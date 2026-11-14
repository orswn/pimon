import { TaskState } from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import {
	a2aClient,
	BUS_URI,
	bearer,
	HOST_TOKEN,
	type HubProcess,
	LinkClient,
	OTHER_HOST_TOKEN,
	PEER_TOKEN,
	sendRequest,
	sleep,
	startHubProcess,
	tempDir,
	writeTokens,
} from "../support/hub.ts";

type AnyTask = Awaited<ReturnType<Client["getTask"]>>;
const asTask = (value: unknown) => value as AnyTask;
const delivery = (task: AnyTask) => (task.metadata?.[BUS_URI] as { delivery?: string } | undefined)?.delivery;

describe("hub link API", () => {
	const tmp = tempDir("hub-link-");
	let hub: HubProcess;
	let peer: Client;
	const links: LinkClient[] = [];
	let counter = 0;

	async function agent(extra: Record<string, unknown> = {}, connect = true): Promise<LinkClient> {
		const link = new LinkClient(hub.url, `agent-${++counter}`);
		links.push(link);
		await link.register(extra);
		if (connect) await link.connect();
		return link;
	}

	beforeAll(async () => {
		hub = await startHubProcess({
			dataDir: `${tmp.dir}/data`,
			tokensFile: writeTokens(tmp.dir),
			env: { HUB_PRESENCE_GRACE_MS: "400" },
		});
	});

	afterEach(async () => {
		for (const link of links.splice(0)) await link.close();
	});

	afterAll(async () => {
		await hub.stop();
		tmp.dispose();
	});

	async function clientFor(id: string, headers = bearer(PEER_TOKEN)): Promise<Client> {
		return a2aClient(hub.url, id, headers);
	}

	it("resumes after Last-Event-ID and replays all unacked events without it", async () => {
		const link = await agent();
		const client = await clientFor(link.agent);
		for (const text of ["e1", "e2", "e3"]) await client.sendMessage(sendRequest(text, { bus: { kind: "note" } }));
		await link.next("message", (data) => data["text"] === "e3");
		const got = link.events.filter((event) => event.type === "message");
		expect(got.map((event) => event.data["text"])).toEqual(["e1", "e2", "e3"]);
		await link.ack(got[0]?.id ?? 0);
		await link.close();

		const replayed = async (options: { lastEventId?: string; query?: string }) => {
			const again = new LinkClient(hub.url, link.agent);
			links.push(again);
			await again.connect(options);
			await again.next("message", (data) => data["text"] === "e3");
			await sleep(100);
			await again.close();
			return again.events.filter((event) => event.type === "message").map((event) => event.data["text"]);
		};
		expect(await replayed({ lastEventId: String(got[1]?.id) })).toEqual(["e3"]);
		expect(await replayed({ query: `lastEventId=${got[1]?.id}` })).toEqual(["e3"]);
		expect(await replayed({})).toEqual(["e2", "e3"]);
		expect(await replayed({ lastEventId: "-1" })).toEqual(["e2", "e3"]);
		expect(await replayed({ lastEventId: "abc" })).toEqual(["e2", "e3"]);
	});

	it("replays the mailbox on connect until acked, and replaces an older stream", async () => {
		const link = await agent({}, false);
		peer = await clientFor(link.agent);
		await peer.sendMessage(sendRequest("queued note", { bus: { kind: "note" } }));
		await link.connect();
		const first = await link.next("message", (data) => data["text"] === "queued note");
		const second = new LinkClient(hub.url, link.agent);
		links.push(second);
		await second.connect();
		await link.next("replaced");
		await second.next("message", (data) => data["text"] === "queued note");
		expect(link.closedByServer).toBe(true);
		await second.ack(first.id);
		const third = new LinkClient(hub.url, link.agent);
		links.push(third);
		await third.connect();
		await sleep(200);
		expect(third.events.filter((event) => event.type === "message")).toEqual([]);
	});

	it("reports delivered, queued, and unconfirmed for deliveryWait", async () => {
		const online = await agent();
		const client = await clientFor(online.agent);
		const acker = (async () => {
			const event = await online.next("message", (data) => data["text"] === "ack me");
			await online.ack(event.id);
		})();
		const delivered = asTask(
			await client.sendMessage(sendRequest("ack me", { bus: { deliveryWait: true }, returnImmediately: true })),
		);
		await acker;
		expect(delivery(delivered)).toBe("delivered");

		const started = Date.now();
		const unconfirmed = asTask(
			await client.sendMessage(sendRequest("never acked", { bus: { deliveryWait: true }, returnImmediately: true })),
		);
		expect(delivery(unconfirmed)).toBe("unconfirmed");
		expect(Date.now() - started).toBeGreaterThanOrEqual(1900);

		const offline = await agent({}, false);
		const queued = asTask(
			await (
				await clientFor(offline.agent)
			).sendMessage(sendRequest("for later", { bus: { deliveryWait: true }, returnImmediately: true })),
		);
		expect(delivery(queued)).toBe("queued");
		expect(queued.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
	});

	it("sends no offline presence when a stream reopens within the grace", async () => {
		const parent = await agent();
		const child = await agent({ parent: parent.agent }, false);
		await child.connect();
		await parent.next("presence", (data) => data["agent"] === child.agent && data["online"] === true);
		await child.close();
		const again = new LinkClient(hub.url, child.agent);
		links.push(again);
		await again.connect();
		await sleep(700);
		expect(parent.events.filter((event) => event.type === "presence" && event.data["online"] === false)).toEqual([]);
		await again.close();
		await parent.next("presence", (data) => data["agent"] === child.agent && data["online"] === false, 3000);
	});

	it("sends presence at once on DELETE and keeps the mailbox", async () => {
		const parent = await agent();
		const child = await agent({ parent: parent.agent });
		await parent.next("presence", (data) => data["agent"] === child.agent && data["online"] === true);
		await child.close();
		await child.ok("DELETE", `/link/${child.agent}`);
		await parent.next("presence", (data) => data["agent"] === child.agent && data["online"] === false, 300);
	});

	it("binds an agent to its host and keeps peers off the link API", async () => {
		const link = await agent({}, false);
		const venus = new LinkClient(hub.url, link.agent, OTHER_HOST_TOKEN);
		expect((await venus.request("POST", "/link/register", { agent: link.agent, protocol: 2 })).status).toBe(403);
		expect((await venus.request("POST", `/link/${link.agent}/status`, { text: "x" })).status).toBe(403);
		const hermes = new LinkClient(hub.url, "hermes-agent", PEER_TOKEN);
		expect((await hermes.request("POST", "/link/register", { agent: "hermes-agent", protocol: 2 })).status).toBe(403);
		expect((await hermes.request("GET", "/agents")).status).toBe(403);
		const anonymous = await fetch(`${hub.url}/agents`);
		expect(anonymous.status).toBe(401);
		const old = await link.request("POST", "/link/register", { agent: link.agent, protocol: 1 });
		expect(old).toEqual({ status: 426, body: expect.objectContaining({ expected: 2 }) });
		const rpc = (headers: Record<string, string>) =>
			fetch(`${hub.url}/a2a/${link.agent}`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json", "A2A-Version": "1.0" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "x" } }),
			});
		expect((await rpc(bearer(OTHER_HOST_TOKEN, link.agent))).status).toBe(403);
		expect((await rpc(bearer(PEER_TOKEN, link.agent))).status).toBe(403);
		expect((await rpc(bearer(HOST_TOKEN, link.agent))).status).toBe(200);
	});

	it("routes sender identity, owed work, thread, and inbox items through the link", async () => {
		const asker = await agent({ name: "asker" });
		const helper = await agent({ name: "helper" });
		const asAsker = await clientFor(helper.agent, bearer(HOST_TOKEN, asker.agent));
		const task = asTask(
			await asAsker.sendMessage(
				sendRequest("please help", { bus: { expectReply: true, subject: "help" }, returnImmediately: true }),
			),
		);
		const event = await helper.next("message", (data) => data["taskId"] === task.id);
		expect(event.data).toMatchObject({ from: { agent: asker.agent, name: "asker", kind: "pi" }, expectReply: true });
		const owed = await helper.ok("GET", `/link/${helper.agent}/owed`);
		expect(owed).toMatchObject({
			expectReply: [{ taskId: task.id, agent: asker.agent }],
			tasks: [{ taskId: task.id, agent: asker.agent, state: "submitted" }],
		});
		await helper.update(task.id, { state: "completed", text: "here you go" });
		const update = await asker.next("update", (data) => data["taskId"] === task.id);
		expect(update.data).toMatchObject({ state: "completed", kind: "result", text: "here you go" });
		const thread = await asker.ok("GET", `/link/${asker.agent}/thread/${task.contextId.slice(0, 12)}`);
		expect((thread["messages"] as { direction: string; text: string }[]).map((m) => [m.direction, m.text])).toEqual([
			["out", "please help"],
			["in", "here you go"],
		]);
		const inbox = await asker.ok("GET", `/link/${asker.agent}/inbox?unread=1`);
		expect(inbox["messages"]).toEqual([
			expect.objectContaining({
				messageId: update.data["messageId"],
				kind: "result",
				to: { agent: asker.agent, name: "asker" },
			}),
		]);
		const one = await asker.ok("GET", `/link/${asker.agent}/message/${String(update.data["messageId"]).slice(0, 20)}`);
		expect(one["text"]).toBe("here you go");
		expect(await asker.ok("GET", `/link/${asker.agent}/pending`)).toEqual({ expectReply: [], tasks: [] });
	});

	it("pre-registers a child, refuses control to it while offline, and resolves aliases", async () => {
		const parent = await agent();
		const childId = `child-${counter}`;
		expect(await parent.ok("POST", `/link/${parent.agent}/children`, { id: childId, name: "kid" })).toEqual({
			agent: childId,
			name: "kid",
			host: "mars",
		});
		const control = await parent.request("POST", `/link/${parent.agent}/control`, { target: childId, action: "close" });
		expect(control).toEqual({ status: 409, body: { error: "offline" } });
		const child = new LinkClient(hub.url, childId);
		links.push(child);
		await child.register();
		await child.connect();
		await parent.ok("POST", `/link/${parent.agent}/control`, { target: childId, action: "close" });
		await child.next("control", (data) => data["action"] === "close");

		const twin = await agent({ name: "kid" });
		const rpc = async (ref: string) =>
			(await (
				await fetch(`${hub.url}/a2a/${ref}`, {
					method: "POST",
					headers: { ...bearer(PEER_TOKEN), "Content-Type": "application/json", "A2A-Version": "1.0" },
					body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "GetTask", params: { id: "nope" } }),
				})
			).json()) as { id: number; error: { code: number; data: { metadata: { agents: string } }[] } };
		const card = await fetch(`${hub.url}/a2a/@kid/.well-known/agent-card.json`);
		expect(card.status).toBe(409);
		expect(await card.json()).toEqual({ error: "agent alias @kid is ambiguous" });
		const ambiguous = await rpc("@kid");
		expect(ambiguous.error.code).toBe(-32602);
		expect(ambiguous.error.data[0]?.metadata.agents.split(",").sort()).toEqual([childId, twin.agent].sort());
		await twin.close();
		await twin.ok("DELETE", `/link/${twin.agent}`);
		expect((await rpc("@kid")).error.code).toBe(-32001);
	});

	it("answers 100 blocking round trips fast", async () => {
		const link = await agent();
		const client = await clientFor(link.agent);
		const times: number[] = [];
		for (let i = 0; i < 100; i++) {
			const started = performance.now();
			const pending = client.sendMessage(sendRequest(`lat-${i}`));
			const event = await link.next("message", (data) => data["text"] === `lat-${i}`);
			await link.update(String(event.data["taskId"]), { state: "completed" });
			const task = asTask(await pending);
			times.push(performance.now() - started);
			expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
		}
		times.sort((a, b) => a - b);
		const p50 = times[49] ?? 0;
		const p95 = times[94] ?? 0;
		process.stderr.write(
			`hub latency: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${times[99]?.toFixed(1)} ms\n`,
		);
		expect(p95).toBeLessThan(100);
	});
});
