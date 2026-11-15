import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LinkEvent } from "@orswn/a2a-hub-protocol";
import { Backoff, backoffDelay } from "./backoff.ts";
import { hubErrorText } from "../tool.ts";
import {
	BUS_EXTENSION_URI,
	type FetchFn,
	HUB_PROTOCOL,
	HubClient,
	HubHttpError,
	HubUnreachableError,
	SEND_TIMEOUT_MS,
} from "./client.ts";
import { HubLink, type LinkStatus } from "./link.ts";
import { SseParser } from "./sse.ts";
import { readHubToken } from "./token.ts";

const AGENT = "019a7c3e-5d10-7000-8000-000000000001";

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function bodyText(init: RequestInit | undefined): string {
	return typeof init?.body === "string" ? init.body : "";
}

interface Call {
	url: string;
	init: RequestInit;
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
	fetch: FetchFn;
	calls: Call[];
} {
	const calls: Call[] = [];
	return {
		calls,
		fetch: async (url, init) => {
			calls.push({ url, init });
			return handler(url, init);
		},
	};
}

/** A stream the test writes SSE text into. */
function sseStream(): { body: ReadableStream<Uint8Array>; write(text: string): void; end(): void } {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const encoder = new TextEncoder();
	return {
		body,
		write: (text) => controller.enqueue(encoder.encode(text)),
		end: () => controller.close(),
	};
}

const frame = (seq: number, type: string, payload: unknown) =>
	`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

async function until(check: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met");
		await new Promise((done) => setTimeout(done, 5));
	}
}

describe("SseParser", () => {
	it("joins split chunks, skips comments, and keeps ids", () => {
		const parser = new SseParser();
		expect(parser.feed(": hb\n\nid: 4\nevent: mess")).toEqual([]);
		expect(parser.feed('age\ndata: {"a":1}\n\nevent: replaced\ndata: {}\n\n')).toEqual([
			{ id: 4, event: "message", data: '{"a":1}' },
			{ event: "replaced", data: "{}" },
		]);
	});

	it("reads CRLF frames and multi-line data", () => {
		expect(new SseParser().feed("id: 1\r\nevent: x\r\ndata: a\r\ndata: b\r\n\r\n")).toEqual([
			{ id: 1, event: "x", data: "a\nb" },
		]);
	});
});

describe("backoff", () => {
	it("starts at 1 s, doubles, and caps at 30 s", () => {
		const mid = () => 0.5;
		expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n, mid))).toEqual([
			1000, 2000, 4000, 8000, 16000, 30000, 30000,
		]);
	});

	it("keeps jitter within 20 percent", () => {
		expect(backoffDelay(1, () => 0)).toBe(800);
		expect(backoffDelay(1, () => 1)).toBe(1200);
	});

	it("resets after 60 s connected", () => {
		let now = 0;
		const backoff = new Backoff({ random: () => 0.5, now: () => now });
		expect(backoff.failed()).toBe(1000);
		expect(backoff.failed()).toBe(2000);
		backoff.connected();
		now += 59_000;
		expect(backoff.failed()).toBe(4000);
		backoff.connected();
		now += 60_000;
		expect(backoff.failed()).toBe(1000);
	});
});

describe("readHubToken", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("reads a 0600 file and refuses other modes, links, and missing files", () => {
		dir = mkdtempSync(join(tmpdir(), "hub-token-"));
		const file = join(dir, "pimon-hub.token");
		expect(readHubToken(file)).toMatchObject({ reason: "missing" });
		writeFileSync(file, "secret\n", { mode: 0o600 });
		expect(readHubToken(file)).toEqual({ token: "secret" });
		chmodSync(file, 0o644);
		expect(readHubToken(file)).toMatchObject({ reason: "mode" });
		chmodSync(file, 0o600);
		const link = join(dir, "link.token");
		symlinkSync(file, link);
		expect(readHubToken(link)).toMatchObject({ reason: "unreadable" });
		writeFileSync(file, "  \n");
		expect(readHubToken(file)).toMatchObject({ reason: "empty" });
	});
});

describe("hub protocol pin", () => {
	it("matches the committed JSON Schema of the a2a-hub protocol package", () => {
		const file = createRequire(import.meta.url).resolve(`@orswn/a2a-hub-protocol/hub-protocol-v${HUB_PROTOCOL}.json`);
		const document = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		expect(HUB_PROTOCOL).toBe(3);
		expect(document["$id"]).toBe("urn:a2a-hub:protocol:3");
		expect(document["x-bus-extension-uri"]).toBe(BUS_EXTENSION_URI);
	});
});

describe("HubClient", () => {
	it("sends the bearer token, the protocol, and the pi harness label on register", async () => {
		const fake = fakeFetch(() => json(200, { agent: AGENT, name: "n", host: "mars" }));
		const client = new HubClient({ url: "http://hub/", token: "tok", agent: AGENT, fetch: fake.fetch });
		await client.register({ name: "n", ephemeral: true });
		await client.register({ name: "n", labels: { team: "core", harness: "other" } });
		expect(fake.calls[0]?.url).toBe("http://hub/link/register");
		expect(new Headers(fake.calls[0]?.init.headers).get("authorization")).toBe("Bearer tok");
		expect(JSON.parse(bodyText(fake.calls[0]?.init))).toEqual({
			name: "n",
			ephemeral: true,
			labels: { harness: "pi" },
			agent: AGENT,
			protocol: 3,
		});
		expect(JSON.parse(bodyText(fake.calls[1]?.init))).toMatchObject({ labels: { team: "core", harness: "pi" } });
	});

	it("tells the model the protocol of the hub and of this pimon after a 426", () => {
		const error = new HubHttpError(426, "426 hub protocol 2 required", { expected: 2 });
		expect(hubErrorText(error, "http://hub")).toBe(
			"pi_bus: the hub speaks protocol 2, this pimon speaks 3. Update pimon or the hub.",
		);
	});

	it("turns an error status into HubHttpError and a network error into HubUnreachableError", async () => {
		const client = new HubClient({
			url: "http://hub",
			token: "t",
			agent: AGENT,
			fetch: fakeFetch(() => json(426, { error: "hub protocol 2 required", expected: 2 })).fetch,
		});
		const error = await client.pending().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(HubHttpError);
		expect(error).toMatchObject({ status: 426, body: { expected: 2 } });

		const down = new HubClient({
			url: "http://hub",
			token: "t",
			agent: AGENT,
			fetch: async () => {
				throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
			},
		});
		const refused = await down.inbox({ unread: true, limit: 5 }).catch((caught: unknown) => caught);
		expect(refused).toBeInstanceOf(HubUnreachableError);
		expect((refused as Error).message).toBe("ECONNREFUSED");
	});

	it("builds the link paths with query strings", async () => {
		const fake = fakeFetch((url) =>
			json(200, url.includes("inbox") ? { messages: [] } : url.includes("agents") ? { agents: [] } : {}),
		);
		const client = new HubClient({ url: "http://hub", token: "t", agent: AGENT, fetch: fake.fetch });
		await client.inbox({ unread: true, limit: 20 });
		await client.agents(true);
		await client.taskUpdate("task-1", { state: "working" });
		expect(fake.calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
			`GET http://hub/link/${AGENT}/inbox?limit=20&unread=1`,
			"GET http://hub/agents?offline=1",
			`POST http://hub/link/${AGENT}/tasks/task-1`,
		]);
	});

	it("sends A2A with deliveryWait and reads the delivery stamp", async () => {
		const fake = fakeFetch(async (_url, init) => {
			const request = JSON.parse(bodyText(init)) as { id: number; params: { message: Record<string, unknown> } };
			return json(200, {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					task: {
						id: "task-9",
						contextId: request.params.message["contextId"],
						status: { state: "TASK_STATE_SUBMITTED" },
						metadata: { [BUS_EXTENSION_URI]: { delivery: "queued" } },
					},
				},
			});
		});
		const client = new HubClient({ url: "http://hub", token: "t", agent: AGENT, fetch: fake.fetch });
		const outcome = await client.sendMessage("peer-1", {
			messageId: "m-1",
			contextId: "c-1",
			text: "hello",
			meta: { kind: "task", wake: "now" },
		});
		expect(outcome).toMatchObject({ state: "queued", taskId: "task-9", contextId: "c-1" });
		const call = fake.calls[0];
		expect(call?.url).toBe("http://hub/a2a/peer-1");
		const headers = new Headers(call?.init.headers);
		expect(headers.get("x-a2a-agent")).toBe(AGENT);
		expect(headers.get("x-pimon-agent")).toBeNull();
		expect(headers.get("a2a-extensions")).toBe("https://github.com/orswn/a2a-hub/bus/v1");
		expect(headers.get("authorization")).toBe("Bearer t");
		expect(headers.get("a2a-version")).toBe("1.0");
		const body = JSON.parse(bodyText(call?.init)) as {
			method: string;
			params: { message: { metadata: Record<string, unknown> }; configuration: unknown };
		};
		expect(body.method).toBe("SendMessage");
		expect(body.params.message.metadata[BUS_EXTENSION_URI]).toEqual({
			kind: "task",
			wake: "now",
			deliveryWait: true,
		});
		expect(body.params.configuration).toMatchObject({ returnImmediately: true });
	});

	it("reports a refused connection as failed and a reset after the request as unconfirmed", async () => {
		const rejecting = (code: string) =>
			new HubClient({
				url: "http://hub",
				token: "t",
				agent: AGENT,
				fetch: async () => {
					throw new TypeError("fetch failed", { cause: { code } });
				},
			});
		const message = { messageId: "m", contextId: "c", text: "x", meta: {} };
		for (const code of [
			"ECONNREFUSED",
			"ENOTFOUND",
			"EAI_AGAIN",
			"UND_ERR_CONNECT_TIMEOUT",
			"ENETUNREACH",
			"EHOSTUNREACH",
		]) {
			const outcome = await rejecting(code).sendMessage("p", message);
			expect(outcome).toMatchObject({ state: "failed" });
			expect(outcome.state === "failed" ? outcome.reason : "").toBe(`hub unreachable: ${code}`);
		}
		expect(await rejecting("ECONNRESET").sendMessage("p", message)).toEqual({
			state: "unconfirmed",
			contextId: "c",
			reason: "the connection to the hub broke",
		});
	});

	it("reads a hub answer without a delivery stamp as unconfirmed", async () => {
		const client = new HubClient({
			url: "http://hub",
			token: "t",
			agent: AGENT,
			fetch: async (_url, init) => {
				const { id } = JSON.parse(bodyText(init)) as { id: unknown };
				return Response.json({ jsonrpc: "2.0", id, result: { message: { messageId: "x", contextId: "c" } } });
			},
		});
		const outcome = await client.sendMessage("p", { messageId: "m", contextId: "c", text: "x", meta: {} });
		expect(outcome).toEqual({ state: "unconfirmed", contextId: "c" });
	});

	it("waits longer for a send than the 10 s connect timeout of fetch, so a connect timeout shows its code", () => {
		expect(SEND_TIMEOUT_MS).toBeGreaterThan(10_000);
	});

	it("reports unconfirmed after a timeout", async () => {
		const message = { messageId: "m", contextId: "c", text: "x", meta: {} };

		const slow = new HubClient({
			url: "http://hub",
			token: "t",
			agent: AGENT,
			sendTimeoutMs: 50,
			fetch: (_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				}),
		});
		expect(await slow.sendMessage("p", message)).toEqual({
			state: "unconfirmed",
			contextId: "c",
			reason: "no answer from the hub",
		});
	});

	it("reports a send the hub refuses as failed with the hub text", async () => {
		const text = "external agents take only task, question, or correction messages";
		const refusing = new HubClient({
			url: "http://hub",
			token: "t",
			agent: AGENT,
			fetch: async (_url, init) => {
				const { id } = JSON.parse(bodyText(init)) as { id: unknown };
				return Response.json({ jsonrpc: "2.0", id, error: { code: -32602, message: text } });
			},
		});
		const outcome = await refusing.sendMessage("hermes", { messageId: "m", contextId: "c", text: "x", meta: {} });
		expect(outcome.state).toBe("failed");
		expect(outcome.state === "failed" ? outcome.reason : "").toContain(text);
	});
});

describe("HubLink", () => {
	function linkWith(
		handler: (url: string, init: RequestInit) => Response | Promise<Response>,
		lastSeq?: number,
		idleMs?: number,
	) {
		const fake = fakeFetch(handler);
		const client = new HubClient({ url: "http://hub", token: "t", agent: AGENT, fetch: fake.fetch });
		const events: LinkEvent[] = [];
		const statuses: LinkStatus[] = [];
		const sleeps: number[] = [];
		const link = new HubLink({
			client,
			registration: () => ({ name: "me" }),
			onEvent: (event) => {
				events.push(event);
			},
			onStatus: (status) => statuses.push(status),
			lastSeq,
			idleMs,
			backoff: new Backoff({ random: () => 0.5 }),
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		return { link, fake, events, statuses, sleeps };
	}

	it("registers, streams events in order, and acks the newest seq", async () => {
		const stream = sseStream();
		const acks: number[] = [];
		const { link, events, fake } = linkWith(async (url, init) => {
			if (url.endsWith("/events")) return new Response(stream.body, { status: 200 });
			if (url.endsWith("/ack")) acks.push((JSON.parse(bodyText(init)) as { upTo: number }).upTo);
			return json(200, { agent: AGENT, name: "me", host: "mars" });
		}, 3);
		link.start();
		await until(() => link.status.state === "online");
		expect(new Headers(fake.calls[1]?.init.headers).get("last-event-id")).toBe("3");
		stream.write(frame(3, "message", { old: true }) + frame(4, "presence", { agent: "x" }) + ": hb\n\n");
		stream.write(frame(5, "update", { taskId: "t" }));
		await until(() => acks.includes(5));
		expect(events.map((event) => [event.seq, event.type])).toEqual([
			[4, "presence"],
			[5, "update"],
		]);
		expect(link.lastSeq).toBe(5);
		await link.stop();
		expect(link.status.state).toBe("stopped");
	});

	it("leaves an event that the handler refused unacked and outside its seq, so the next link gets it again", async () => {
		const stream = sseStream();
		const acks: number[] = [];
		const fake = fakeFetch(async (url, init) => {
			if (url.endsWith("/events")) return new Response(stream.body, { status: 200 });
			if (url.endsWith("/ack")) acks.push((JSON.parse(bodyText(init)) as { upTo: number }).upTo);
			return json(200, { agent: AGENT, name: "me", host: "mars" });
		});
		const taken: number[] = [];
		let refuse = false;
		const link = new HubLink({
			client: new HubClient({ url: "http://hub", token: "t", agent: AGENT, fetch: fake.fetch }),
			registration: () => ({ name: "me" }),
			onEvent: (event) => {
				if (refuse) return false;
				taken.push(event.seq);
				return true;
			},
			onStatus: () => {},
			backoff: new Backoff({ random: () => 0.5 }),
			sleep: (_ms, signal) =>
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 5_000);
					signal.addEventListener("abort", () => {
						clearTimeout(timer);
						resolve();
					});
				}),
		});
		link.start();
		await until(() => link.status.state === "online");
		stream.write(frame(4, "message", {}));
		await until(() => acks.includes(4));
		refuse = true;
		stream.write(frame(5, "message", {}) + frame(6, "message", {}));
		await new Promise((resolve) => setTimeout(resolve, 50));
		await link.stop();
		expect(taken).toEqual([4]);
		expect(acks).toEqual([4]);
		expect(link.lastSeq).toBe(4);
	});

	it("retries on backoff when the hub is unreachable", async () => {
		let attempts = 0;
		const stream = sseStream();
		const { link, sleeps, statuses } = linkWith(async (url) => {
			if (url.endsWith("/register")) {
				attempts++;
				if (attempts < 3) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
				return json(200, { agent: AGENT, name: "me", host: "mars" });
			}
			return new Response(stream.body, { status: 200 });
		});
		link.start();
		await until(() => link.status.state === "online");
		expect(sleeps).toEqual([1000, 2000]);
		expect(statuses.some((status) => status.state === "retrying" && status.reason === "ECONNREFUSED")).toBe(true);
		await link.stop();
	});

	it("stops without retry on 401 and 426", async () => {
		for (const status of [401, 426]) {
			const { link, sleeps } = linkWith(() => json(status, { error: "no" }));
			link.start();
			await until(() => link.status.state === "stopped");
			expect(link.status.fatal).toBe(status);
			expect(sleeps).toEqual([]);
			await link.stop();
		}
	});

	it("stops after a replaced event", async () => {
		const stream = sseStream();
		const { link, events, sleeps } = linkWith(async (url) =>
			url.endsWith("/events")
				? new Response(stream.body, { status: 200 })
				: json(200, { agent: AGENT, name: "me", host: "mars" }),
		);
		link.start();
		await until(() => link.status.state === "online");
		stream.write("event: replaced\ndata: {}\n\n");
		await until(() => link.status.state === "stopped");
		expect(link.status.reason).toBe("replaced");
		expect(events.map((event) => event.type)).toEqual(["replaced"]);
		expect(sleeps).toEqual([]);
		await link.stop();
	});

	it("drops a stream that stays silent and reconnects with the last seq", async () => {
		const streams = [sseStream(), sseStream()];
		let opened = 0;
		const { link, fake, statuses } = linkWith(
			async (url) => {
				if (url.endsWith("/events")) return new Response(streams[opened++]?.body ?? null, { status: 200 });
				return json(200, { agent: AGENT, name: "me", host: "mars" });
			},
			undefined,
			500,
		);
		link.start();
		await until(() => opened === 1);
		streams[0]?.write(frame(4, "message", {}));
		await until(() => link.lastSeq === 4);
		// Beats at a tenth of the idle time keep the stream across 1.2 idle periods, also on a busy host.
		for (let beat = 0; beat < 12; beat++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			streams[0]?.write(": hb\n\n");
		}
		expect(opened).toBe(1);
		await until(() => opened === 2);
		expect(statuses.some((status) => status.reason === "stream idle")).toBe(true);
		const second = fake.calls.filter((call) => call.url.endsWith("/events"))[1];
		expect(new Headers(second?.init.headers).get("last-event-id")).toBe("4");
		await link.stop();
	});

	it("starts its seq again when the first event of a new stream is older than the kept seq", async () => {
		const stream = sseStream();
		const { link, events } = linkWith(async (url) => {
			if (url.endsWith("/events")) return new Response(stream.body, { status: 200 });
			return json(200, { agent: AGENT, name: "me", host: "mars" });
		}, 100);
		link.start();
		await until(() => link.status.state === "online");
		stream.write(frame(1, "message", { fresh: 1 }) + frame(2, "message", { fresh: 2 }));
		await until(() => events.length === 2);
		expect(events.map((event) => event.seq)).toEqual([1, 2]);
		expect(link.lastSeq).toBe(2);
		await link.stop();
	});

	it("reconnects with the last seq after the stream ends", async () => {
		const streams = [sseStream(), sseStream()];
		let opened = 0;
		const { link, fake, sleeps } = linkWith(async (url) => {
			if (url.endsWith("/events")) return new Response(streams[opened++]?.body ?? null, { status: 200 });
			return json(200, { agent: AGENT, name: "me", host: "mars" });
		});
		link.start();
		await until(() => opened === 1);
		streams[0]?.write(frame(7, "message", {}));
		await until(() => link.lastSeq === 7);
		streams[0]?.end();
		await until(() => opened === 2);
		const second = fake.calls.filter((call) => call.url.endsWith("/events"))[1];
		expect(new Headers(second?.init.headers).get("last-event-id")).toBe("7");
		expect(sleeps).toEqual([1000]);
		await link.stop();
	});
});
