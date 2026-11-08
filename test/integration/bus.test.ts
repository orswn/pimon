import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { defineFeature } from "../../src/core/feature.ts";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { bus, type BusService, DIGEST_TYPE, STATE_TYPE } from "../../src/features/bus/index.ts";
import { BusNode } from "../../src/features/bus/node.ts";
import type { Envelope } from "../../src/features/bus/protocol.ts";
import { busDirs } from "../../src/features/bus/registry.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const OWNER_KEY = "__piBusOwner";

let service: BusService | undefined;
const capture = defineFeature({
	id: "bus-capture",
	description: "test feature that captures the bus service",
	defaultEnabled: true,
	dependsOn: ["bus"],
	setup(ctx) {
		service = ctx.service("bus");
	},
});

function busService(): BusService {
	if (!service) throw new Error("no bus service");
	return service;
}
const globals = globalThis as Record<string, unknown>;

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function customMessages(harness: Harness, customType: string) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && (message as { customType?: string }).customType === customType,
	) as { content: unknown; details?: Record<string, unknown> }[];
}

function toolText(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => JSON.stringify((message as { content: unknown }).content));
}

describe("bus feature", () => {
	let harness: Harness | undefined;
	const peers: BusNode[] = [];
	const handlers = new Map<string, (envelope: Envelope) => void>();

	beforeEach(() => {
		delete globals[OWNER_KEY];
		clearReloadState();
	});

	afterEach(async () => {
		for (const key of ["PI_BUS_ROLE", "PI_BUS_CONTROL_TOKEN"]) delete process.env[key];
		for (const peer of peers.splice(0)) await peer.stop();
		handlers.clear();
		service = undefined;
		await harness?.shutdown();
		harness?.dispose();
		harness = undefined;
		delete globals[OWNER_KEY];
		clearReloadState();
	});

	async function startPeer(name: string, labels: Record<string, string> = {}): Promise<BusNode> {
		if (!harness) throw new Error("no harness");
		const peer = new BusNode({
			owner: crypto.randomUUID(),
			desiredName: name,
			labels,
			dirs: busDirs(harness.agentDir),
			onEnvelope: (envelope) => handlers.get(name)?.(envelope),
		});
		await peer.start();
		peers.push(peer);
		return peer;
	}

	async function start(options: Partial<Parameters<typeof createHarness>[0]> = {}): Promise<Harness> {
		harness = await createHarness({ features: [bus, capture], ...options });
		await until(() => service?.started === true);
		return harness;
	}

	it("keeps presence under the agent dir and adopts the standalone owner", async () => {
		globals[OWNER_KEY] = "0123456789abcdef0123456789abcdef";
		const h = await start();
		const service = busService();
		expect(service.owner).toBe("0123456789abcdef0123456789abcdef");
		const peer = await startPeer("probe");
		const seen = peer.refreshPeers().find((record) => record.instanceId === service.instanceId);
		expect(seen?.owner).toBe("0123456789abcdef0123456789abcdef");
		expect(seen?.sock.startsWith(h.agentDir) || seen?.sock.includes("pi-bus-")).toBe(true);
	});

	it("wakes the model with a digest and marks it read after a completed answer", async () => {
		const h = await start();
		const peer = await startPeer("sender");
		h.respond([
			fauxAssistantMessage(fauxText("got it")),
			fauxAssistantMessage(fauxToolCall("pi_bus", { action: "inbox" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("done")),
		]);
		const result = await peer.send(`id:${busService().instanceId}`, { body: "hello there", kind: "note", wake: "now" });
		expect(result.delivered).toHaveLength(1);
		await h.waitForRequests(1);
		const digest = customMessages(h, DIGEST_TYPE)[0];
		expect(String(digest?.content)).toContain("hello there");
		expect(String(digest?.content)).toContain(`owner:${peer.owner.replace(/-/g, "").slice(0, 12)}`);
		await h.session.prompt("check inbox");
		expect(toolText(h).at(-1)).toContain("No unread bus messages.");
	});

	it("stores a wake=never message without starting a run", async () => {
		const h = await start();
		const peer = await startPeer("quiet");
		await peer.send(`id:${busService().instanceId}`, { body: "fyi", kind: "status", wake: "never" });
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(h.requests).toHaveLength(0);
		expect(customMessages(h, DIGEST_TYPE)).toHaveLength(0);
	});

	it("rejects a reply with a target and a reply to an own message", async () => {
		const h = await start();
		const peer = await startPeer("other");
		h.respond([
			fauxAssistantMessage(
				fauxToolCall("pi_bus", { action: "reply", target: "all", body: "x", messageId: "abcdef12" }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage(
				fauxToolCall("pi_bus", { action: "send", target: `owner:${peer.owner}`, body: "q", wake: "never" }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage(fauxText("sent")),
		]);
		await h.session.prompt("send");
		const texts = toolText(h);
		expect(texts[0]).toContain("reply derives the recipient from messageId");
		const sentId = /messageId ([0-9a-f]{12})/.exec(texts[1] ?? "")?.[1];
		expect(sentId).toBeDefined();
		h.respond([
			fauxAssistantMessage(fauxToolCall("pi_bus", { action: "reply", body: "self", messageId: sentId ?? "" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxText("ok")),
		]);
		await h.session.prompt("reply to it");
		expect(toolText(h).at(-1)).toContain("was sent by this instance");
	});

	it("replies to the sender of the given message, not to the thread of an open question", async () => {
		const h = await start();
		const alice = await startPeer("alice");
		const bob = await startPeer("bob");
		const self = `id:${busService().instanceId}`;
		const received: string[] = [];
		handlers.set("alice", (envelope) => received.push(`alice:${envelope.body}`));
		const bobGot = new Promise<void>((resolve) => {
			handlers.set("bob", (envelope) => {
				received.push(`bob:${envelope.body}`);
				resolve();
			});
		});
		await alice.send(self, { body: "alice asks", kind: "question", wake: "never" });
		const note = await bob.send(self, { body: "bob says", kind: "note", wake: "never" });
		h.respond([
			fauxAssistantMessage(
				fauxToolCall("pi_bus", { action: "reply", body: "for bob", messageId: note.envelope.id.slice(0, 12) }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxText("ok")),
		]);
		await h.session.prompt("answer bob");
		await bobGot;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(received).toEqual(["bob:for bob"]);
	});

	it("does not wake for an unrelated peer exit", async () => {
		const h = await start();
		const peer = await startPeer("bystander");
		busService().watch(peer.record);
		await peer.stop({ announce: true });
		peers.splice(peers.indexOf(peer), 1);
		await new Promise((resolve) => setTimeout(resolve, 1_800));
		expect(h.requests).toHaveLength(0);
	});

	it("wakes when a tracked child exits", async () => {
		const h = await start();
		const child = await startPeer("child", { parent: busService().owner });
		busService().watch(child.record);
		h.respond([fauxAssistantMessage(fauxText("noted"))]);
		await child.stop({ announce: true });
		peers.splice(peers.indexOf(child), 1);
		await h.waitForRequests(1);
		expect(String(customMessages(h, DIGEST_TYPE)[0]?.content)).toContain("child");
	});

	it("restores open bus state after compaction without starting a run", async () => {
		const h = await start({ settings: { compaction: { enabled: false, keepRecentTokens: 1 } } });
		const peer = await startPeer("asker");
		const question = await peer.send(`id:${busService().instanceId}`, {
			body: "open question",
			kind: "question",
			wake: "never",
		});
		h.respond([fauxAssistantMessage(fauxText("one")), fauxAssistantMessage(fauxText("two"))]);
		await h.session.prompt("one");
		await h.session.prompt("two");
		h.respond([fauxAssistantMessage(fauxText("summary")), fauxAssistantMessage(fauxText("prefix"))]);
		await h.session.compact();
		const afterCompaction = h.requests.length;
		const state = customMessages(h, STATE_TYPE);
		expect(state).toHaveLength(1);
		const hex = (id: string) => id.replace(/-/g, "").slice(0, 12);
		expect(String(state[0]?.content)).toContain(
			`- Unanswered question messageId=${hex(question.envelope.id)} from asker owner:${hex(peer.owner)}: open question`,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(h.requests.length).toBe(afterCompaction);
		expect(h.session.isStreaming).toBe(false);
	});

	it("adds no bus state after compaction when nothing is open", async () => {
		const h = await start({ settings: { compaction: { enabled: false, keepRecentTokens: 1 } } });
		h.respond([
			fauxAssistantMessage(fauxText("one")),
			fauxAssistantMessage(fauxText("two")),
			fauxAssistantMessage(fauxText("summary")),
			fauxAssistantMessage(fauxText("prefix")),
		]);
		await h.session.prompt("one");
		await h.session.prompt("two");
		await h.session.compact();
		expect(h.session.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
		expect(customMessages(h, STATE_TYPE)).toHaveLength(0);
	});

	it("keeps owner and unread state across reload", async () => {
		const h = await start();
		const ownerBefore = busService().owner;
		const peer = await startPeer("early");
		await peer.send(`id:${busService().instanceId}`, { body: "kept", kind: "note", wake: "never" });
		await h.session.reload();
		await until(() => busService().started);
		expect(busService().owner).toBe(ownerBefore);
		h.respond([
			fauxAssistantMessage(fauxToolCall("pi_bus", { action: "inbox" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("ok")),
		]);
		await h.session.prompt("inbox");
		expect(toolText(h).at(-1)).toContain("kept");
	});

	it("emits only name and role to the statusline, on start and on refresh", async () => {
		process.env["PI_BUS_ROLE"] = "reviewer";
		const seen: unknown[] = [];
		let emitRefresh: (() => void) | undefined;
		const h = await start({
			extensions: [
				(pi) => {
					pi.events.on("pi-bus:identity", (data) => seen.push(data));
					emitRefresh = () => pi.events.emit("pi-bus:refresh", undefined);
				},
			],
		});
		const identity = { name: busService().name, role: "reviewer" };
		expect(seen).toEqual([identity]);

		const peer = await startPeer("chatty");
		await peer.send(`id:${busService().instanceId}`, { body: "x", kind: "note", wake: "never" });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(seen).toHaveLength(1);

		emitRefresh?.();
		expect(seen).toEqual([identity, identity]);
		expect(h.extensionErrors).toEqual([]);
	});

	it("removes identity keys from the env of a bash child", async () => {
		process.env["PI_BUS_ROLE"] = "worker";
		process.env["PI_BUS_CONTROL_TOKEN"] = "secret-token";
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
			const output = toolText(h).at(-1) ?? "";
			expect(output).toContain("PI_BUS_WAKE_POLICY=all");
			expect(output).not.toContain("PI_BUS_ROLE");
			expect(output).not.toContain("secret-token");
			expect(busService().labels["role"]).toBe("worker");
			expect(busService().launch.controlToken).toBe("secret-token");
		} finally {
			delete process.env["PI_BUS_WAKE_POLICY"];
		}
	});

	it("keeps the bus dir under the agent dir by default", async () => {
		const h = await start();
		expect(existsSync(join(h.agentDir, "bus", "peers", `${busService().instanceId}.json`))).toBe(true);
		expect(statSync(join(h.agentDir, "bus")).mode & 0o777).toBe(0o700);
	});

	it("refuses a control request without the token and keeps running", async () => {
		process.env["PI_BUS_CONTROL_TOKEN"] = "right";
		const h = await start();
		const peer = await startPeer("intruder");
		const refused = new Promise<Envelope>((resolve) => handlers.set("intruder", resolve));
		await peer.send(`id:${busService().instanceId}`, {
			body: "shutdown",
			kind: "control",
			wake: "now",
			data: { token: "wrong" },
		});
		expect((await refused).body).toContain("Refused control request");
		expect(busService().started).toBe(true);
		expect(h.requests).toHaveLength(0);
	});

	it("settles the peer's pending question with a faux reply", async () => {
		const h = await start();
		const peer = await startPeer("asker");
		const question = await peer.send(`id:${busService().instanceId}`, {
			body: "why?",
			kind: "question",
			wake: "never",
			replyExpected: true,
		});
		expect(peer.pendingQuestions()).toHaveLength(1);
		const answered = new Promise<Envelope>((resolve) => handlers.set("asker", resolve));
		h.respond([
			fauxAssistantMessage(
				fauxToolCall("pi_bus", { action: "reply", body: "because", messageId: question.envelope.id.slice(0, 12) }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage(fauxText("ok")),
		]);
		await h.session.prompt("reply");
		expect((await answered).corrId).toBe(question.envelope.id);
		await until(() => peer.pendingQuestions().length === 0);
		expect(toolText(h).at(-1)).toContain("delivered: asker");
	});

	it("publishes the session model in presence", async () => {
		const h = await start();
		const peer = await startPeer("reader");
		const self = peer.refreshPeers().find((record) => record.instanceId === busService().instanceId);
		expect(h.session.model?.id).toBeTruthy();
		expect(self?.model).toBe(h.session.model?.id);
	});

	it("runs /bus-send and /bus-pending through the shared actions", async () => {
		const h = await start({ ui: {} });
		const peer = await startPeer("target");
		const received: Envelope[] = [];
		handlers.set("target", (envelope) => received.push(envelope));
		await h.session.prompt(`/bus-send owner:${peer.owner} hello from a command`);
		expect(h.notifications.at(-1)?.message).toMatch(/^Sent to [\s\S]*delivered: target \(owner:/);
		await until(() => received.length > 0);
		expect(received.map((envelope) => envelope.body)).toEqual(["hello from a command"]);

		await h.session.prompt("/bus-pending");
		expect(h.notifications.at(-1)).toEqual({ message: "No open questions.", level: "info" });

		await h.session.prompt("/bus-send name:nobody hi");
		expect(h.notifications.at(-1)).toMatchObject({ level: "error" });
		expect(h.requests).toHaveLength(0);
	});

	it("reports a bus dir that cannot be created as a failed start", async () => {
		harness = await createHarness({
			features: [bus, capture],
			ui: {},
			setupAgentDir: (agentDir) => writeFileSync(join(agentDir, "bus"), "not a dir"),
		});
		await until(() => harness?.notifications.some((entry) => entry.level === "error") === true);
		expect(harness.notifications.find((entry) => entry.level === "error")?.message).toMatch(
			/^pi-bus failed to start: /,
		);
		expect(busService().started).toBe(false);
		const diagnostics = harness.runtime.diagnostics().filter((entry) => entry.feature === "bus");
		expect(diagnostics.map((entry) => entry.message.split(":")[0])).toEqual(["bus failed to start"]);
	});

	it("leaves no presence after shutdown", async () => {
		const h = await start();
		const peer = await startPeer("watcher");
		const id = busService().instanceId;
		await h.shutdown();
		expect(peer.refreshPeers().some((record) => record.instanceId === id)).toBe(false);
	});
});
