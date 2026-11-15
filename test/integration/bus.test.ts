import { TaskState } from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { defineFeature } from "../../src/core/feature.ts";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { bus, DIGEST_TYPE, STATUS_ENTRY } from "../../src/features/bus/index.ts";
import { AGENTS_CACHE_MS } from "../../src/features/bus/protocol.ts";
import { busCapture, busHarness, customMessages, hex, toolTexts, until } from "../support/bus.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { FAKE_HERMES_TOKEN, FakeHermes } from "../support/fake-hermes.ts";
import {
	a2aClient,
	bearer,
	externalAgent,
	HOST_TOKEN,
	type HubPeer,
	PEER_TOKEN,
	sendRequest,
	startPeer,
	startTestHub,
	type TestHub,
} from "../support/hub.ts";

type AnyTask = Awaited<ReturnType<Client["getTask"]>>;

const capture = busCapture();
const busService = () => capture.get();

function identityListener() {
	const typed: unknown[] = [];
	const listener = defineFeature({
		id: "identity-listener",
		description: "test feature that records the bus identity",
		defaultEnabled: true,
		setup(ctx) {
			ctx.events.on("bus:identity", (identity) => typed.push(identity));
		},
	});
	return { typed, listener };
}

type ToolArgs = Parameters<typeof fauxToolCall>[1];
const call = (params: ToolArgs) => fauxAssistantMessage(fauxToolCall("pi_bus", params), { stopReason: "toolUse" });

describe("bus feature without a hub", () => {
	let harness: Harness | undefined;
	beforeEach(() => clearReloadState());
	afterEach(async () => {
		capture.reset();
		await harness?.shutdown();
		harness?.dispose();
		harness = undefined;
		clearReloadState();
	});

	it("says so in whoami and returns one short error for other actions", async () => {
		harness = await createHarness({ features: [bus, capture.feature], ui: {} });
		const h = harness;
		h.respond([
			call({ action: "whoami" }),
			call({ action: "send", target: "all", body: "x" }),
			fauxAssistantMessage(fauxText("ok")),
		]);
		await h.session.prompt("bus");
		const [whoami, send] = toolTexts(h);
		expect(whoami).toContain("hub: none. Set features.bus.hub.url in pimon.json to use the bus.");
		expect(send).toBe("pi_bus: no hub configured. Set features.bus.hub.url in pimon.json.");
		expect(busService().started).toBe(false);
		await h.session.prompt("/bus");
		expect(h.notifications.at(-1)?.message.split("\n")[0]).toBe("bus: no hub");
	});
});

describe("bus feature on a hub", () => {
	let hub: TestHub;
	let harness: Harness | undefined;
	const peers: HubPeer[] = [];

	beforeAll(async () => {
		hub = await startTestHub();
	});
	afterAll(async () => {
		await hub.close();
	});
	beforeEach(() => clearReloadState());
	afterEach(async () => {
		for (const key of ["PI_BUS_ROLE", "PI_BUS_PARENT"]) delete process.env[key];
		for (const peer of peers.splice(0)) await peer.stop();
		capture.reset();
		await harness?.shutdown();
		harness?.dispose();
		harness = undefined;
		clearReloadState();
	});

	async function start(options: Parameters<typeof busHarness>[2] = {}): Promise<Harness> {
		harness = await busHarness(hub.url, capture, options);
		return harness;
	}

	async function peer(name: string, options: Parameters<typeof startPeer>[2] = {}): Promise<HubPeer> {
		const started = await startPeer(hub.url, name, options);
		peers.push(started);
		return started;
	}

	async function busTool(h: Harness, calls: ToolArgs[]): Promise<string[]> {
		const before = toolTexts(h).length;
		h.respond([...calls.map(call), fauxAssistantMessage(fauxText("ok"))]);
		await h.session.prompt("use the bus");
		return toolTexts(h).slice(before);
	}

	async function busCommand(h: Harness, command: string): Promise<string> {
		await h.session.prompt(command);
		return h.notifications.at(-1)?.message ?? "";
	}

	/** Counts load a short time after a change. */
	async function statusLineBecomes(h: Harness, expected: string): Promise<void> {
		const deadline = Date.now() + 3_000;
		let line = "";
		while (Date.now() < deadline) {
			line = (await busCommand(h, "/bus")).split("\n")[0] ?? "";
			if (line === expected) return;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(line).toBe(expected);
	}

	it("registers under the session id", async () => {
		const h = await start();
		const id = h.session.sessionManager.getSessionId();
		expect(busService().id).toBe(id);
		const listed = await hub.agents();
		expect(listed.find((agent) => agent.id === id)).toMatchObject({ kind: "session", online: true });
	});

	it("wakes the model with a digest and marks it read after a completed answer", async () => {
		const h = await start();
		const sender = await peer("sender");
		h.respond([
			fauxAssistantMessage(fauxText("got it")),
			call({ action: "inbox" }),
			fauxAssistantMessage(fauxText("done")),
		]);
		const sent = await sender.send(busService().id, "hello there");
		expect(sent.state).toBe("delivered");
		await h.waitForRequests(1);
		const digest = String(customMessages(h, DIGEST_TYPE)[0]?.content);
		expect(digest).toContain("hello there");
		expect(digest).toContain(`- note from sender id:${hex(sender.id)} messageId=${hex(sent.messageId)}:`);
		await h.session.prompt("check inbox");
		expect(toolTexts(h).at(-1)).toBe("No unread bus messages.");
	});

	it("lists a digested message as read while the hub has not answered the mark-read yet", async () => {
		const h = await start();
		const sender = await peer("sender");
		const readPath = `/link/${encodeURIComponent(busService().id)}/read`;
		const inboxPath = `/link/${encodeURIComponent(busService().id)}/inbox?limit=10&unread=1`;
		const realFetch = globalThis.fetch;
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		let fallback: ReturnType<typeof setTimeout> | undefined;
		// The read reaches the hub only after the hub answered the inbox list.
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url.endsWith(readPath)) {
				// Fallback for a client that waits for the read before it lists the inbox.
				fallback ??= setTimeout(() => release(), 1_000);
				await held;
			}
			const response = await realFetch(input, init);
			if (url.endsWith(inboxPath)) release();
			return response;
		}) as typeof fetch;
		try {
			h.respond([
				fauxAssistantMessage(fauxText("got it")),
				call({ action: "inbox" }),
				fauxAssistantMessage(fauxText("done")),
			]);
			await sender.send(busService().id, "hello there");
			await h.waitForRequests(1);
			await h.session.prompt("check inbox");
			expect(toolTexts(h).at(-1)).toBe("No unread bus messages.");
		} finally {
			clearTimeout(fallback);
			release();
			globalThis.fetch = realFetch;
		}
	});

	it("stores a wake=never message without starting a run", async () => {
		const h = await start({ ui: {} });
		const quiet = await peer("quiet");
		await quiet.send(busService().id, "fyi", { kind: "status", wake: "never" });
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect(h.requests).toHaveLength(0);
		expect(customMessages(h, DIGEST_TYPE)).toHaveLength(0);
		await statusLineBecomes(h, "bus: 1 unread");
	});

	it("rejects a reply with a target and a reply to an own message", async () => {
		const h = await start();
		const other = await peer("other");
		const [withTarget, sent] = await busTool(h, [
			{ action: "reply", target: "all", body: "x", messageId: "abcdef12" },
			{ action: "send", target: `id:${other.id}`, body: "q", wake: "never" },
		]);
		expect(withTarget).toContain("reply derives the recipient from messageId");
		const sentId = /messageId ([0-9a-f]{12})/.exec(sent ?? "")?.[1] ?? "";
		const [own] = await busTool(h, [{ action: "reply", body: "self", messageId: sentId }]);
		expect(own).toContain("was sent by this session");
	});

	it("replies to the sender of the given message in its thread", async () => {
		const h = await start();
		const alice = await peer("alice");
		const bob = await peer("bob");
		await alice.send(busService().id, "alice asks", { kind: "question", wake: "never" });
		const note = await bob.send(busService().id, "bob says", { wake: "never" });
		await busTool(h, [{ action: "reply", body: "for bob", messageId: hex(note.messageId) }]);
		const got = await bob.next("message", (message) => message.text === "for bob");
		expect(got.payload.replyTo).toBe(note.messageId);
		expect(got.payload.contextId).toBe(note.state === "failed" ? "" : note.contextId);
		expect(alice.events.filter((event) => event.type === "message")).toEqual([]);
	});

	it("settles the peer's open question with a reply", async () => {
		const h = await start();
		const asker = await peer("asker");
		const question = await asker.send(busService().id, "why?", { kind: "question", wake: "never", expectReply: true });
		expect((await asker.client.pending()).expectReply).toHaveLength(1);
		const [replied] = await busTool(h, [{ action: "reply", body: "because", messageId: hex(question.messageId) }]);
		expect(replied).toContain(`queued: asker (id:${hex(asker.id)}, task completed)`);
		const update = await asker.next("update", (event) => event.state === "completed");
		expect(update.payload.text).toBe("because");
		expect((await asker.client.pending()).expectReply).toEqual([]);
	});

	it("queues a message to an offline session by id and says so", async () => {
		const h = await start();
		const away = await peer("away");
		await away.stop();
		const [sent] = await busTool(h, [{ action: "send", target: `id:${away.id}`, body: "later", wake: "never" }]);
		expect(sent).toContain(`queued: away (id:${hex(away.id)})`);
		const [none] = await busTool(h, [{ action: "send", target: "name:away", body: "x" }]);
		expect(none).toContain("name:away");
	});

	it("does not wake for an unrelated peer that goes offline", async () => {
		const h = await start();
		const bystander = await peer("bystander");
		await bystander.stop();
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(h.requests).toHaveLength(0);
	});

	it("wakes when a child goes offline", async () => {
		const h = await start();
		const child = await peer("child", { parent: busService().id });
		h.respond([fauxAssistantMessage(fauxText("noted"))]);
		await child.stop();
		await h.waitForRequests(1);
		expect(String(customMessages(h, DIGEST_TYPE)[0]?.content)).toContain(`child (id:${hex(child.id)}) went offline.`);
	});

	it("starts no run for an expected child exit and shows the notice at the next turn", async () => {
		const h = await start({ ui: {} });
		const child = await peer("child", { parent: busService().id });
		busService().expectOffline(child.id);
		await child.stop();
		await until(() => h.notifications.some((entry) => entry.message.includes("went offline")));
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(h.requests).toHaveLength(0);
		h.respond([fauxAssistantMessage(fauxText("ok"))]);
		await h.session.prompt("next");
		expect(JSON.stringify(h.requests[0])).toContain(`child (id:${hex(child.id)}) went offline.`);
	});

	it("wakes for an expected exit of a child that owes an answer", async () => {
		const h = await start();
		const child = await peer("child", { parent: busService().id });
		const [target] = await busService().resolve(`id:${child.id}`);
		if (!target) throw new Error("child not found");
		await busService().send([target], { body: "status?", kind: "question", expectReply: true, wake: "now" });
		busService().expectOffline(child.id);
		h.respond([fauxAssistantMessage(fauxText("noted"))]);
		await child.stop();
		await h.waitForRequests(1);
		expect(String(customMessages(h, DIGEST_TYPE)[0]?.content)).toContain("1 unanswered request(s)");
	});

	it("keeps the id and unread state across reload", async () => {
		const h = await start();
		const id = busService().id;
		const early = await peer("early");
		await early.send(id, "kept", { wake: "never" });
		await h.session.reload();
		await until(() => busService().online);
		expect(busService().id).toBe(id);
		const [inbox] = await busTool(h, [{ action: "inbox" }]);
		expect(inbox).toContain("kept");
	});

	it("wakes once for a message sent while a reload has the link closed", async () => {
		let gap: (() => Promise<void>) | undefined;
		let gapState: string | undefined;
		const h = await start({
			extensions: [
				(pi) =>
					void pi.on("session_shutdown", async (event) => {
						if (event.reason === "reload" && gap) await gap();
					}),
			],
		});
		const id = busService().id;
		const sender = await peer("sender");
		const old = busService();
		gap = async () => {
			gap = undefined;
			await until(() => !old.online, 3_000);
			const sent = await sender.send(id, "sent in the reload gap", { wake: "now" });
			gapState = sent.state;
		};
		h.respond([fauxAssistantMessage(fauxText("seen"))]);
		await h.session.reload();
		expect(gapState).toBeDefined();
		expect(gapState).not.toBe("failed");
		await h.waitForRequests(1);
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		const holding = customMessages(h, DIGEST_TYPE).filter((m) => String(m.content).includes("sent in the reload gap"));
		expect(holding).toHaveLength(1);
		expect(h.requests).toHaveLength(1);
	});

	it("takes a new id at /new and leaves mail to the old id queued", async () => {
		const h = await start();
		const old = busService().id;
		const watcher = await peer("watcher");
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
		const next = crypto.randomUUID();
		h.session.sessionManager.newSession({ id: next });
		await h.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		await until(() => busService().online && busService().id !== old);
		expect(busService().id).toBe(next);
		const agents = await watcher.client.agents(true);
		expect(agents.find((agent) => agent.id === old)?.online).toBe(false);
		const sent = await watcher.send(old, "for the old session");
		expect(sent.state).toBe("queued");
	});

	it("publishes only name and role on the pimon event bus, and not again without a change", async () => {
		process.env["PI_BUS_ROLE"] = "reviewer";
		const legacy: unknown[] = [];
		const { typed, listener } = identityListener();
		const h = await start({
			features: [bus, capture.feature, listener],
			extensions: [(pi) => void pi.events.on("pi-bus:identity", (data) => legacy.push(data))],
		});
		const identity = { name: busService().name, role: "reviewer" };
		expect(typed.at(-1)).toEqual(identity);
		const count = typed.length;
		const chatty = await peer("chatty");
		await chatty.send(busService().id, "x", { wake: "never" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(typed).toHaveLength(count);
		await h.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		expect(typed.at(-1)).toEqual(identity);
		expect(legacy).toEqual([]);
		expect(h.extensionErrors).toEqual([]);
	});

	it("removes identity keys from the env of a bash child", async () => {
		process.env["PI_BUS_ROLE"] = "worker";
		process.env["PI_BUS_WAKE_POLICY"] = "all";
		try {
			const h = await start();
			h.respond([
				fauxAssistantMessage(fauxToolCall("bash", { command: "env | grep '^PI_BUS_' | sort" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxText("done")),
			]);
			await h.session.prompt("env");
			const output = toolTexts(h).at(-1) ?? "";
			expect(output).toContain("PI_BUS_WAKE_POLICY=all");
			expect(output).not.toContain("PI_BUS_ROLE");
			const own = (await busService().agents()).find((agent) => agent.id === busService().id);
			expect(own?.role).toBe("worker");
		} finally {
			delete process.env["PI_BUS_WAKE_POLICY"];
		}
	});

	it("runs /bus-send and /bus-pending through the shared actions", async () => {
		const h = await start({ ui: {} });
		const target = await peer("target");
		await h.session.prompt(`/bus-send id:${target.id} hello from a command`);
		expect(h.notifications.at(-1)?.message).toMatch(
			/^Sent to id:[0-9a-f]{32} on thread [\s\S]*delivered: target \(id:/,
		);
		await target.next("message", (message) => message.text === "hello from a command");
		expect(await busCommand(h, "/bus-pending")).toBe("No open questions.");
		await h.session.prompt("/bus-send name:nobody hi");
		expect(h.notifications.at(-1)).toMatchObject({ level: "error" });
		expect(h.requests).toHaveLength(0);
	});

	it("lists other sessions with id, host, role, and status text", async () => {
		const h = await start();
		const [alone] = await busTool(h, [{ action: "peers" }]);
		expect(alone).toBe("No other sessions are on the bus.");
		const alpha = await peer("alpha", { role: "reviewer" });
		await alpha.client.status("reviewing step 3");
		await new Promise((resolve) => setTimeout(resolve, AGENTS_CACHE_MS + 50));
		const [listed] = await busTool(h, [{ action: "peers" }]);
		expect(listed?.split("\n")).toHaveLength(1);
		expect(listed).toMatch(
			new RegExp(`^alpha id:${hex(alpha.id)} idle role=reviewer host=mars status="reviewing step 3" \\(\\d+s\\)`),
		);
	});

	it("sets its own status text so peers see it, and /bus-status clears it", async () => {
		const h = await start({ ui: {} });
		const [set] = await busTool(h, [{ action: "set_status", body: "testing\nstep 4" }]);
		expect(set).toBe("Status set: testing step 4");
		const own = (await hub.agents()).find((agent) => agent.id === busService().id);
		expect(own?.status.text).toBe("testing step 4");
		expect(await busCommand(h, "/bus-status")).toBe("Status cleared.");
		const cleared = (await hub.agents()).find((agent) => agent.id === busService().id);
		expect(cleared?.status.text).toBe("");
		const entries = h.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === STATUS_ENTRY);
		expect(entries).toHaveLength(2);
		expect(entries[0]?.type === "custom" ? entries[0].data : undefined).toMatchObject({
			text: "testing step 4",
			session: busService().id,
		});
	});

	it("saves no status entry for a text that the hub refuses", async () => {
		const own = await startTestHub();
		try {
			harness = await busHarness(own.url, capture, { ui: {} });
			const h = harness;
			await own.revokeHostToken();
			// The hub must keep the open link stream. Else the bus saves the status offline and sends nothing.
			expect(capture.get().online).toBe(true);
			const [refused] = await busTool(h, [{ action: "set_status", body: "revoked token" }]);
			expect(refused).toContain("the hub refused the request");
			const entries = h.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === STATUS_ENTRY);
			expect(entries).toEqual([]);
		} finally {
			await own.close();
		}
	});

	it("restores its saved status text at a restart when the hub row has none", async () => {
		const id = crypto.randomUUID();
		await start({
			sessionManager: (cwd) => {
				const manager = SessionManager.inMemory(cwd, { id });
				manager.appendCustomEntry(STATUS_ENTRY, { text: "reviewing the parser", session: id });
				return manager;
			},
		});
		const statusText = async () => (await hub.agents()).find((agent) => agent.id === id)?.status.text;
		await until(async () => ![undefined, ""].includes(await statusText()));
		expect(await statusText()).toBe("reviewing the parser");
	});

	it("does not restore a status entry that a fork copied from another session", async () => {
		const id = crypto.randomUUID();
		await start({
			sessionManager: (cwd) => {
				const manager = SessionManager.inMemory(cwd, { id });
				manager.appendCustomEntry(STATUS_ENTRY, { text: "the parent's work", session: crypto.randomUUID() });
				return manager;
			},
		});
		await until(async () => (await hub.agents()).some((agent) => agent.id === id));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect((await hub.agents()).find((agent) => agent.id === id)?.status.text).toBe("");
	});

	it("probes a matching agent and reports a selector with no match", async () => {
		const h = await start();
		const alpha = await peer("alpha");
		const [found, none] = await busTool(h, [
			{ action: "probe", target: "name:alpha" },
			{ action: "probe", target: "name:nobody" },
		]);
		expect(found).toMatch(new RegExp(`^alpha \\(id:${hex(alpha.id)}\\) online state=idle seen=\\d+s ago$`));
		expect(none).toBe("Nothing matches name:nobody.");
	});

	it("reads one message by messageId and a thread by threadId, and marks them read", async () => {
		const h = await start({ ui: {} });
		const writer = await peer("writer");
		const self = busService().id;
		const thread = crypto.randomUUID();
		const first = await writer.send(self, "first of thread", { wake: "never" }, { contextId: thread });
		const second = await writer.send(self, "second of thread", { wake: "never" }, { contextId: thread });
		const single = await writer.send(self, "alone", { kind: "status", subject: "solo", wake: "never" });
		await statusLineBecomes(h, "bus: 3 unread");

		const [byId] = await busTool(h, [{ action: "read", messageId: hex(single.messageId) }]);
		const lines = byId?.split("\n") ?? [];
		expect(lines[0]).toMatch(new RegExp(`^messageId=${hex(single.messageId)} threadId=[0-9a-f]{12}$`));
		expect(lines[1]).toBe(`from=writer (id:${hex(writer.id)}) to=${busService().name} (id:${hex(self)})`);
		expect(lines.slice(3)).toEqual(["subject: solo", "alone"]);

		const [byThread] = await busTool(h, [{ action: "read", threadId: hex(thread) }]);
		const parts = byThread?.split("\n\n---\n\n") ?? [];
		expect(parts).toHaveLength(2);
		expect(parts[0]).toContain(`messageId=${hex(first.messageId)} threadId=${hex(thread)}`);
		expect(parts[1]).toContain(`messageId=${hex(second.messageId)} threadId=${hex(thread)}`);
		await statusLineBecomes(h, "bus: online");
	});

	it("subscribes to a topic, receives a topic message, and unsubscribes", async () => {
		const h = await start();
		const caster = await peer("broadcaster");
		const [subscribed] = await busTool(h, [{ action: "subscribe", topic: "build" }]);
		expect(subscribed).toBe("Topics: build");
		const agents = await caster.client.agents();
		expect(agents.find((agent) => agent.id === busService().id)?.topics).toEqual(["build"]);
		const [unsubscribed] = await busTool(h, [{ action: "unsubscribe", topic: "build" }]);
		expect(unsubscribed).toBe("Topics: none");
	});

	it("shows status and doctor output through /bus and /bus-doctor", async () => {
		const h = await start({ ui: {} });
		const service = busService();
		const status = (await busCommand(h, "/bus")).split("\n");
		expect(status).toEqual([
			"bus: online",
			`me: ${service.name} (id:${hex(service.id)})`,
			"labels: none",
			`hub: ${hub.url} (online)`,
		]);
		const doctor = (await busCommand(h, "/bus-doctor")).split("\n");
		expect(doctor[0]).toBe(`identity: ${service.name} id:${hex(service.id)}`);
		expect(doctor[2]).toMatch(/^token: .*0600/);
		expect(doctor.slice(3)).toEqual([
			"link: online",
			expect.stringMatching(/^health: ok, hub \S+, \d+ agent\(s\) online$/),
			"registered: yes",
			"duplicate names: none",
			"wake policy: all",
		]);
		expect(h.requests).toHaveLength(0);
	});

	it("goes offline on the hub at shutdown", async () => {
		const h = await start();
		const watcher = await peer("watcher");
		const id = busService().id;
		await h.shutdown();
		h.dispose();
		harness = undefined;
		const agents = await watcher.client.agents();
		expect(agents.some((agent) => agent.id === id)).toBe(false);
	});

	describe("external agents", () => {
		const fake = new FakeHermes({ tokens: { "pimon-hub": FAKE_HERMES_TOKEN }, trusted: ["pimon-hub"] });
		let externalHub: TestHub;
		beforeAll(async () => {
			await fake.start();
			externalHub = await startTestHub({ external: [externalAgent("hermes", fake.url, FAKE_HERMES_TOKEN)] });
		});
		afterAll(async () => {
			await externalHub.close();
			await fake.close();
		});

		it("lists an external agent with its kind and sends a task to it by name over the message route", async () => {
			harness = await busHarness(externalHub.url, capture);
			const h = harness;
			const [listed] = await busTool(h, [{ action: "peers" }]);
			expect(listed).toMatch(/^hermes id:hermes kind=external /m);

			const respond = fake.respond;
			fake.respond = (text, task) => `${respond(text, task) ?? ""}\n- first point\n- second point`;
			h.respond([
				call({ action: "send", target: "name:hermes", body: "summarize the log", kind: "task", wake: "never" }),
				fauxAssistantMessage(fauxText("sent")),
				fauxAssistantMessage(fauxText("got the answer")),
			]);
			await h.session.prompt("ask hermes");
			expect(toolTexts(h).at(-1)).toMatch(/(delivered|queued): hermes \(id:hermes/);
			await h.waitForRequests(5);
			await h.session.waitForIdle();
			fake.respond = respond;
			const digest = String(customMessages(h, DIGEST_TYPE).at(-1)?.content);
			expect(digest).toMatch(
				/- hermes \(id:hermes\) set task [0-9a-f]{12} "summarize the log" to completed\. Result: answer: summarize the log\n- first point\n- second point/,
			);
			expect(JSON.stringify(fake.sends().at(-1)?.params)).toContain("summarize the log");
		});

		it("reports a note to an external agent as failed with the hub text", async () => {
			harness = await busHarness(externalHub.url, capture);
			const [refused] = await busTool(harness, [{ action: "send", target: "id:hermes", body: "fyi", wake: "never" }]);
			expect(refused).toContain("failed: hermes (");
			expect(refused).toContain("external agents take only task, question, or correction messages");
		});
	});

	it("still knows the sender of a task after a reload, so a cancel from the parent wakes", async () => {
		const boss = await peer("boss");
		process.env["PI_BUS_WAKE_POLICY"] = "parent";
		process.env["PI_BUS_PARENT"] = boss.id;
		try {
			const h = await start();
			const sent = await boss.send(busService().id, "long job", { kind: "task" });
			expect(sent.state).toBe("delivered");
			await h.session.reload();
			await until(() => busService().online);
			const client = await a2aClient(hub.url, busService().id, bearer(HOST_TOKEN, boss.id));
			await client.cancelTask({ id: sent.state === "failed" ? "" : (sent.taskId ?? "") } as never);
			await until(() => customMessages(h, DIGEST_TYPE).some((m) => String(m.content).includes("canceled task")));
			const notice = customMessages(h, DIGEST_TYPE).find((m) => String(m.content).includes("canceled task"));
			expect(notice?.details?.["wake"]).not.toBe("never");
		} finally {
			delete process.env["PI_BUS_WAKE_POLICY"];
		}
	});

	it("keeps a cancel from waking a session whose wake policy is none", async () => {
		process.env["PI_BUS_WAKE_POLICY"] = "none";
		try {
			const h = await start();
			const sender = await peer("sender");
			const sent = await sender.send(busService().id, "long job", { kind: "task" });
			expect(sent.state).toBe("delivered");
			const client = await a2aClient(hub.url, busService().id, bearer(HOST_TOKEN, sender.id));
			await client.cancelTask({ id: sent.state === "failed" ? "" : (sent.taskId ?? "") } as never);
			await until(() => customMessages(h, DIGEST_TYPE).some((m) => String(m.content).includes("canceled task")));
			const notice = customMessages(h, DIGEST_TYPE).find((m) => String(m.content).includes("canceled task"));
			expect(notice?.details?.["wake"]).toBe("never");
		} finally {
			delete process.env["PI_BUS_WAKE_POLICY"];
		}
	});

	describe("tasks from a peer principal", () => {
		async function hermesTask(h: Harness, text: string): Promise<{ client: Client; task: AnyTask }> {
			const client = await a2aClient(hub.url, busService().id, bearer(PEER_TOKEN));
			const task = (await client.sendMessage(
				sendRequest(text, { bus: { kind: "task" }, returnImmediately: true }),
			)) as AnyTask;
			await h.waitForRequests(h.requests.length + 1);
			return { client, task };
		}

		it("shows the task from the principal name and completes it with a result reply", async () => {
			const h = await start();
			h.respond([fauxAssistantMessage(fauxText("on it"))]);
			const { client, task } = await hermesTask(h, "summarize the release notes");
			const digest = String(customMessages(h, DIGEST_TYPE)[0]?.content);
			expect(digest).toMatch(/- task from hermes messageId=[0-9a-f]{12}/);
			const messageId = /messageId=([0-9a-f]{12})/.exec(digest)?.[1] ?? "";
			const [replied] = await busTool(h, [
				{ action: "reply", body: "three fixes, one feature", messageId, kind: "result" },
			]);
			expect(replied).toContain("queued: hermes (principal, task completed)");
			const done = await client.getTask({ id: task.id, historyLength: 0 } as never);
			expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
			expect(JSON.stringify(done.artifacts)).toContain("three fixes, one feature");
		});

		it("asks back with a question reply and sets the task to input-required", async () => {
			const h = await start();
			h.respond([fauxAssistantMessage(fauxText("on it"))]);
			const { client, task } = await hermesTask(h, "rename the module");
			const messageId = /messageId=([0-9a-f]{12})/.exec(String(customMessages(h, DIGEST_TYPE)[0]?.content))?.[1];
			const [asked] = await busTool(h, [
				{ action: "reply", body: "which module?", messageId: messageId ?? "", kind: "question" },
			]);
			expect(asked).toContain("queued: hermes (principal, task input-required)");
			const waiting = await client.getTask({ id: task.id, historyLength: 0 } as never);
			expect(waiting.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
		});
	});
});
