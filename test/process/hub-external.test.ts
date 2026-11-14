import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { TaskState } from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { FAKE_HERMES_TOKEN, FakeHermes, type Responder } from "../support/fake-hermes.ts";
import {
	a2aClient,
	bearer,
	HOST_TOKEN,
	type HubProcess,
	LinkClient,
	partText,
	sendRequest,
	sleep,
	startHubProcess,
	tempDir,
	writeTokens,
} from "../support/hub.ts";

type AnyTask = Awaited<ReturnType<Client["getTask"]>>;

const FAST = { pollMs: 100, idleMs: 2000, retryMs: 300, offlineMs: 2000, replyTimeoutMs: 10_000 };
const ASK_AGAIN = "Ask again in the same context.";

function writeExternal(dir: string, entries: Record<string, Record<string, unknown>>, name = "external.json"): string {
	const file = join(dir, name);
	writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
	return file;
}

/** A pi session on host `mars` that sends A2A tasks with its own agent id and reads its link events. */
class Session {
	readonly link: LinkClient;
	readonly agent: string;
	readonly #hub: string;
	readonly #clients = new Map<string, Client>();

	constructor(hub: string, agent: string) {
		this.agent = agent;
		this.#hub = hub;
		this.link = new LinkClient(hub, agent);
	}

	async open(name: string): Promise<this> {
		await this.link.register({ name });
		await this.link.connect();
		return this;
	}

	async client(target: string): Promise<Client> {
		let client = this.#clients.get(target);
		if (!client) {
			client = await a2aClient(this.#hub, target, bearer(HOST_TOKEN, this.agent));
			this.#clients.set(target, client);
		}
		return client;
	}

	async send(target: string, text: string, options: { contextId?: string; taskId?: string } = {}): Promise<AnyTask> {
		const client = await this.client(target);
		return (await client.sendMessage(sendRequest(text, { ...options, returnImmediately: true }))) as AnyTask;
	}

	async task(target: string, id: string): Promise<AnyTask> {
		return (await this.client(target)).getTask({ id } as never);
	}

	update(taskId: string, state: string, timeoutMs = 8000) {
		return this.link.next("update", (data) => data["taskId"] === taskId && data["state"] === state, timeoutMs);
	}
}

const statusText = (task: AnyTask) => partText(task.status?.message);
const artifactText = (task: AnyTask) => (task.artifacts ?? []).map((artifact) => partText(artifact)).join("");

describe("hub external agents", () => {
	const tmp = tempDir("hub-external-");
	const fake = new FakeHermes({
		tokens: { "pimon-hub": FAKE_HERMES_TOKEN, outsider: "outsider-token" },
		trusted: ["pimon-hub"],
	});
	const athena = new FakeHermes({
		skills: [{ id: "toolset.todo", name: "todo", description: "Athena todo", tags: ["todo"] }],
	});
	const defaultRespond = fake.respond;
	let hub: HubProcess;
	let bee: Session;
	let shadow: Session;

	beforeAll(async () => {
		await fake.start();
		await athena.start();
		const externalFile = writeExternal(tmp.dir, {
			hermes: {
				name: "hermes",
				url: fake.url,
				token: FAKE_HERMES_TOKEN,
				description: "Hermes Agent",
				cardTtlMs: 60_000,
				...FAST,
			},
			badkey: { url: fake.url, token: "not-the-token", cardTtlMs: 60_000, ...FAST },
			outsider: { url: fake.url, token: "outsider-token", cardTtlMs: 60_000, ...FAST },
			athena: { url: athena.url, token: FAKE_HERMES_TOKEN, ...FAST, cardTtlMs: 200 },
			ghost: { url: `http://127.0.0.1:${await closedPort()}/`, token: "t", ...FAST, cardTtlMs: 60_000, offlineMs: 600 },
			slowpoke: { url: fake.url, token: FAKE_HERMES_TOKEN, cardTtlMs: 60_000, ...FAST, replyTimeoutMs: 1000 },
		});
		hub = await startHubProcess({ dataDir: join(tmp.dir, "data"), tokensFile: writeTokens(tmp.dir), externalFile });
		bee = await new Session(hub.url, "pi-bee").open("bee");
		shadow = await new Session(hub.url, "pi-shadow").open("hermes");
		await fake.waitFor(() => fake.cardHits > 0);
	});

	afterEach(() => {
		fake.respond = defaultRespond;
		fake.maxTurns = 20;
		fake.rateLimit = undefined;
		fake.keepOnDisconnect = false;
		fake.nextDrop = undefined;
		fake.nextError = undefined;
	});

	afterAll(async () => {
		await bee.link.close();
		await shadow.link.close();
		await hub.stop();
		await fake.close();
		await athena.close();
		tmp.dispose();
	});

	it("sends a pi task with SendStreamingMessage and maps the stream back to COMPLETED", async () => {
		const task = await bee.send("hermes", "what is A2A?");
		expect(task.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
		await bee.update(task.id, "working");
		const done = await bee.update(task.id, "completed");
		expect(done.data).toMatchObject({ artifacts: [{ text: "answer: what is A2A?" }], from: { agent: "hermes" } });
		const request = fake.sends().at(-1);
		expect(request?.headers).toMatchObject({
			authorization: `Bearer ${FAKE_HERMES_TOKEN}`,
			"a2a-version": "1.0",
			accept: "text/event-stream",
			"content-type": "application/json",
		});
		expect(request?.params).toEqual({
			message: {
				role: "ROLE_USER",
				messageId: expect.any(String),
				contextId: task.contextId,
				parts: [{ text: "[from bee on mars]\nwhat is A2A?" }],
			},
		});
		const final = await bee.task("hermes", task.id);
		expect(final.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
		expect(artifactText(final)).toBe("answer: what is A2A?");
	});

	it("continues an INPUT_REQUIRED task with a second remote task in the same context", async () => {
		fake.respond = (text) =>
			text.endsWith("plan a trip") ? "[INPUT_REQUIRED] Which city?" : `booked ${text.split("\n")[1]}`;
		const task = await bee.send("hermes", "plan a trip");
		const asked = await bee.update(task.id, "input-required");
		expect(asked.data).toMatchObject({ kind: "question", text: "Which city?" });
		const next = await bee.send("hermes", "Paris", { taskId: task.id });
		expect(next.id).toBe(task.id);
		const done = await bee.update(task.id, "completed");
		expect(done.data["artifacts"]).toEqual([{ text: "booked Paris" }]);
		const remote = [...fake.tasks.values()].filter((item) => item.contextId === task.contextId);
		expect(remote.map((item) => item.state)).toEqual(["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_COMPLETED"]);

		const again = await bee.send("hermes", "plan a trip");
		await bee.update(again.id, "input-required");
		const joined = await bee.send("hermes", "Rome", { contextId: again.contextId });
		expect(joined.id).toBe(again.id);
		expect((await bee.update(again.id, "completed")).data["artifacts"]).toEqual([{ text: "booked Rome" }]);
	});

	it("shows the turn cap as REJECTED with the Hermes text", async () => {
		fake.maxTurns = 1;
		const first = await bee.send("hermes", "one");
		await bee.update(first.id, "completed");
		const second = await bee.send("hermes", "two", { contextId: first.contextId });
		expect(second.id).not.toBe(first.id);
		const rejected = await bee.update(second.id, "rejected");
		expect(String(rejected.data["text"])).toMatch(/^Anti-loop protection: context .* exceeded 1 turns/);
		expect((await bee.task("hermes", second.id)).status?.state).toBe(TaskState.TASK_STATE_REJECTED);
	});

	it("polls GetTask after a stream drop and fails the task the way Hermes did", async () => {
		fake.respond = () => undefined;
		fake.nextDrop = "after-task";
		const task = await bee.send("hermes", "drop me");
		const failed = await bee.update(task.id, "failed");
		expect(failed.data["text"]).toBe(
			`hermes failed the task after the stream dropped: [client disconnected]. ${ASK_AGAIN}`,
		);
		const remote = [...fake.tasks.values()].find((item) => item.contextId === task.contextId);
		expect(fake.calls("GetTask").map((call) => call.params["id"])).toContain(remote?.id);

		fake.respond = defaultRespond;
		fake.keepOnDisconnect = true;
		fake.nextDrop = "after-task";
		const kept = await bee.send("hermes", "survive");
		expect((await bee.update(kept.id, "completed")).data["artifacts"]).toEqual([{ text: "answer: survive" }]);
	});

	it("finds the remote task with ListTasks when the stream drops before the first event", async () => {
		fake.nextDrop = "before-task";
		fake.keepOnDisconnect = true;
		const mapped = await bee.send("hermes", "mapped");
		expect((await bee.update(mapped.id, "completed")).data["artifacts"]).toEqual([{ text: "answer: mapped" }]);
		expect(fake.calls("ListTasks").map((call) => call.params["contextId"])).toContain(mapped.contextId);

		fake.keepOnDisconnect = false;
		fake.nextDrop = "no-task";
		const lost = await bee.send("hermes", "lost");
		const failed = await bee.update(lost.id, "failed");
		expect(failed.data["text"]).toBe(`hermes did not confirm the task before the stream dropped. ${ASK_AGAIN}`);
		expect(fake.calls("ListTasks").map((call) => call.params["contextId"])).toContain(lost.contextId);
	});

	it("fails the task when Hermes restarted and lost it", async () => {
		fake.respond = () => undefined;
		const task = await bee.send("hermes", "long job");
		await bee.update(task.id, "working");
		await fake.waitFor(() => [...fake.tasks.values()].some((item) => item.contextId === task.contextId));
		fake.restart();
		const failed = await bee.update(task.id, "failed");
		expect(failed.data["text"]).toBe(`hermes lost the task. ${ASK_AGAIN}`);
	});

	it("retries after a rate limit answer, and fails on a rejected token", async () => {
		fake.rateLimit = { limit: 1, windowMs: 250 };
		const one = await bee.send("hermes", "first");
		const two = await bee.send("hermes", "second");
		await bee.update(one.id, "completed");
		await bee.update(two.id, "completed");
		expect(fake.calls("SendStreamingMessage").filter((call) => call.status === 429).length).toBeGreaterThan(0);
		fake.rateLimit = undefined;

		const bad = await bee.send("badkey", "hello");
		const failed = await bee.update(bad.id, "failed");
		expect(failed.data["text"]).toBe("hub token rejected by badkey");
		expect(hub.stderr()).toContain("external agent badkey rejected the hub token");
	});

	it("fails the task when the agent does not trust the hub or refuses the params", async () => {
		const untrusted = await bee.send("outsider", "hello");
		expect((await bee.update(untrusted.id, "failed")).data["text"]).toBe("hub not in A2A_TRUSTED_PEERS of outsider");
		expect(fake.calls("SendStreamingMessage").some((call) => call.status === 403)).toBe(true);
		expect(hub.stderr()).toContain("external agent outsider does not trust the hub");

		fake.nextError = { code: -32602, message: "unsupported A2A-Version: 2.0" };
		const refused = await bee.send("hermes", "hello");
		expect((await bee.update(refused.id, "failed")).data["text"]).toBe(
			"hermes answered -32602: unsupported A2A-Version: 2.0",
		);
	});

	it("sends CancelTask for a canceled hub task", async () => {
		fake.respond = () => undefined;
		const task = await bee.send("hermes", "cancel me");
		await bee.update(task.id, "working");
		const remote = await fake.waitFor(() => [...fake.tasks.values()].find((item) => item.contextId === task.contextId));
		const client = await bee.client("hermes");
		const canceled = await client.cancelTask({ id: task.id } as never);
		expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
		await fake.waitFor(() => fake.calls("CancelTask").some((call) => call.params["id"] === remote.id));
		expect(fake.tasks.get(remote.id)?.state).toBe("TASK_STATE_CANCELED");
	});

	it("holds a second task of a context until the first one ends", async () => {
		const held: Responder = (text) => (text.endsWith("first") ? undefined : `answer: ${text.split("\n")[1]}`);
		fake.respond = held;
		const first = await bee.send("hermes", "first");
		const remote = await fake.waitFor(() =>
			[...fake.tasks.values()].find((item) => item.contextId === first.contextId),
		);
		const second = await bee.send("hermes", "second", { contextId: first.contextId });
		expect(second.id).not.toBe(first.id);
		await sleep(400);
		const inContext = () =>
			fake.sends().filter((call) => (call.params["message"] as { contextId?: string }).contextId === first.contextId);
		expect(inContext()).toHaveLength(1);
		expect((await bee.task("hermes", second.id)).status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
		const finishedAt = Date.now();
		fake.finish(remote.id, "first done");
		await bee.update(first.id, "completed");
		await bee.update(second.id, "completed");
		expect(inContext()).toHaveLength(2);
		expect(inContext()[1]?.at).toBeGreaterThanOrEqual(finishedAt);
	});

	it("refreshes the card by TTL, goes offline after failed fetches, and tells pi peers", async () => {
		const hits = athena.cardHits;
		await athena.waitFor(() => athena.cardHits >= hits + 2);
		const card = (await (await fetch(`${hub.url}/a2a/athena/.well-known/agent-card.json`)).json()) as Record<
			string,
			unknown
		>;
		expect(card["skills"]).toEqual([{ id: "toolset.todo", name: "todo", description: "Athena todo", tags: ["todo"] }]);
		athena.respond = () => undefined;
		const open = await bee.send("athena", "stay open");
		await bee.update(open.id, "working");
		athena.cardBroken = true;
		await bee.link.next("presence", (data) => data["agent"] === "athena" && data["online"] === false);
		const stale = (await (await fetch(`${hub.url}/a2a/athena/.well-known/agent-card.json`)).json()) as Record<
			string,
			unknown
		>;
		expect(stale["skills"]).toEqual(card["skills"]);
		athena.cardBroken = false;
		await bee.link.next("presence", (data) => data["agent"] === "athena" && data["online"] === true);
		const remote = [...athena.tasks.values()].find((item) => item.contextId === open.contextId);
		athena.finish(remote?.id ?? "", "closed");
		await bee.update(open.id, "completed");
	});

	it("retries an unreachable agent, then fails the task after offlineMs", async () => {
		const task = await bee.send("ghost", "anyone?");
		const failed = await bee.update(task.id, "failed", 4000);
		expect(String(failed.data["text"])).toMatch(/^ghost is unreachable: .*ECONNREFUSED/);
		expect(hub.stderr()).toContain("external agent ghost is unreachable, retrying");
	});

	it("fails a task whose stream sends only keepalives past the reply timeout", async () => {
		fake.respond = () => undefined;
		const task = await bee.send("slowpoke", "never answered");
		await bee.update(task.id, "working");
		const failed = await bee.update(task.id, "failed", 4000);
		expect(failed.data["text"]).toBe("slowpoke gave no answer within 1 s");
	});

	it("resolves @hermes to the external agent while a pi session is named hermes", async () => {
		const response = await fetch(`${hub.url}/a2a/@hermes/.well-known/agent-card.json`);
		const card = (await response.json()) as { description: string; supportedInterfaces: { url: string }[] };
		expect(card.description).toBe("Hermes Agent");
		expect(card.supportedInterfaces[0]?.url).toBe(`${hub.url}/a2a/hermes`);
		const task = await bee.send("@hermes", "who are you?");
		await bee.update(task.id, "completed");
		expect(shadow.link.events.filter((event) => event.type === "message")).toEqual([]);
	});
});

describe("hub external agents: restart", () => {
	const tmp = tempDir("hub-external-restart-");
	const fake = new FakeHermes();

	afterAll(async () => {
		await fake.close();
		tmp.dispose();
	});

	it("recovers WORKING, dispatched, and SUBMITTED tasks after a hub restart", async () => {
		await fake.start();
		fake.respond = (text) => (text.includes("slow") ? undefined : `answer: ${text.split("\n")[1]}`);
		const options = {
			dataDir: join(tmp.dir, "data"),
			tokensFile: writeTokens(tmp.dir),
			externalFile: writeExternal(tmp.dir, {
				hermes: { url: fake.url, token: FAKE_HERMES_TOKEN, cardTtlMs: 60_000, ...FAST },
			}),
		};
		let hub = await startHubProcess(options);
		let bee = await new Session(hub.url, "pi-bee").open("bee");
		const working = await bee.send("hermes", "slow work");
		await bee.update(working.id, "working");
		fake.nextDrop = "silent";
		const silent = await bee.send("hermes", "slow silent");
		await fake.waitFor(() => [...fake.tasks.values()].some((item) => item.contextId === silent.contextId));
		const queued = await bee.send("hermes", "queued", { contextId: working.contextId });
		await sleep(200);
		expect((await bee.task("hermes", queued.id)).status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
		await bee.link.close();
		await hub.stop();

		hub = await startHubProcess(options);
		bee = new Session(hub.url, "pi-bee");
		await bee.link.connect();
		try {
			expect((await bee.update(working.id, "failed")).data["text"]).toBe(
				`hermes failed the task after the stream dropped: [client disconnected]. ${ASK_AGAIN}`,
			);
			expect((await bee.update(silent.id, "failed")).data["text"]).toBe(
				`hermes failed the task after the stream dropped: [client disconnected]. ${ASK_AGAIN}`,
			);
			expect((await bee.update(queued.id, "completed")).data["artifacts"]).toEqual([{ text: "answer: queued" }]);
			expect(fake.calls("ListTasks").map((call) => call.params["contextId"])).toEqual([silent.contextId]);
			const final = await bee.task("hermes", working.id);
			expect(statusText(final)).toContain("[client disconnected]");
		} finally {
			await bee.link.close();
			await hub.stop();
		}
	});
});

describe("hub external agents: reload", () => {
	const tmp = tempDir("hub-external-reload-");
	const fake = new FakeHermes();

	afterAll(async () => {
		await fake.close();
		tmp.dispose();
	});

	it("reloads the external file on SIGHUP", async () => {
		await fake.start();
		const entry = { url: fake.url, cardTtlMs: 60_000, ...FAST };
		const file = writeExternal(tmp.dir, {
			hermes: { ...entry, token: "old-token", description: "before" },
			gone: { ...entry, token: FAKE_HERMES_TOKEN },
		});
		const hub = await startHubProcess({
			dataDir: join(tmp.dir, "data"),
			tokensFile: writeTokens(tmp.dir),
			externalFile: file,
		});
		const bee = await new Session(hub.url, "pi-bee").open("bee");
		const registry = async () =>
			(
				(await (await fetch(`${hub.url}/agents?offline=1`, { headers: bearer(HOST_TOKEN) })).json()) as {
					agents: { id: string; online: boolean }[];
				}
			).agents;
		try {
			const before = await bee.send("hermes", "hello");
			expect((await bee.update(before.id, "failed")).data["text"]).toBe("hub token rejected by hermes");
			await waitUntil(async () => (await registry()).some((agent) => agent.id === "gone" && agent.online));

			writeExternal(tmp.dir, { hermes: { ...entry, token: FAKE_HERMES_TOKEN, description: "after" } });
			hub.child.kill("SIGHUP");
			await waitUntil(async () => hub.stderr().includes("SIGHUP: external agents reloaded: 1"));
			const card = (await (await fetch(`${hub.url}/a2a/hermes/.well-known/agent-card.json`)).json()) as {
				description: string;
			};
			expect(card.description).toBe("after");
			const after = await bee.send("hermes", "hello again");
			expect((await bee.update(after.id, "completed")).data["artifacts"]).toEqual([{ text: "answer: hello again" }]);
			await waitUntil(async () => (await registry()).some((agent) => agent.id === "gone" && !agent.online));

			writeFileSync(file, "{ not json");
			hub.child.kill("SIGHUP");
			await waitUntil(async () => hub.stderr().includes("SIGHUP: external reload failed, old agents kept"));
			expect(
				((await (await fetch(`${hub.url}/a2a/hermes/.well-known/agent-card.json`)).json()) as { description: string })
					.description,
			).toBe("after");
		} finally {
			await bee.link.close();
			await hub.stop();
		}
	});
});

describe("hub external agents: close", () => {
	const tmp = tempDir("hub-external-close-");

	afterAll(() => tmp.dispose());

	it("leaves no card fetch pending after close, so an embedding process exits at once", async () => {
		const held: Socket[] = [];
		const hang = createServer((socket) => held.push(socket));
		await new Promise<void>((done) => hang.listen(0, "127.0.0.1", done));
		const port = (hang.address() as { port: number }).port;
		const server = fileURLToPath(new URL("../../src/hub/server.ts", import.meta.url));
		const script = join(tmp.dir, "embed.mjs");
		writeFileSync(
			script,
			`import { startHub } from ${JSON.stringify(server)};
const hub = await startHub({ dataDir: ":memory:", external: [${JSON.stringify({
				id: "hermes",
				name: "hermes",
				url: `http://127.0.0.1:${port}/`,
				token: "t",
				description: "d",
				pollMs: 60_000,
				cardTtlMs: 60_000,
				replyTimeoutMs: 60_000,
				idleMs: 60_000,
				retryMs: 60_000,
				offlineMs: 60_000,
			})}] });
process.stdin.once("data", async () => {
	await hub.close();
	process.stdout.write("closed\\n");
	process.stdin.pause();
});
`,
		);
		const child = spawn(process.execPath, ["--no-warnings", script], { stdio: ["pipe", "pipe", "inherit"] });
		let out = "";
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
		const exited = new Promise<number>((done) => child.once("exit", () => done(Date.now())));
		try {
			await waitUntil(async () => held.length > 0);
			child.stdin.write("close\n");
			await waitUntil(async () => out.includes("closed"));
			const closedAt = Date.now();
			const exitAt = await Promise.race([exited, sleep(5000).then(() => Number.POSITIVE_INFINITY)]);
			expect(exitAt - closedAt).toBeLessThan(2000);
		} finally {
			child.kill();
			for (const socket of held) socket.destroy();
			await new Promise<void>((done) => hang.close(() => done()));
		}
	});
});

async function waitUntil(probe: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await probe())) {
		if (Date.now() > deadline) throw new Error("condition not met");
		await sleep(25);
	}
}

async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as { port: number };
	await new Promise<void>((done) => server.close(() => done()));
	return port;
}
