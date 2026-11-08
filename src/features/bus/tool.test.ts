import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { BusNode } from "./node.ts";
import type { Envelope, PeerRecord, SendResult } from "./protocol.ts";
import { busDirs, ensureDirs } from "./registry.ts";
import { BusStore } from "./store.ts";
import { type ActionHost, formatSendResult, inboxAction, replyAction, sendAction } from "./tool.ts";

let root: string;
let store: BusStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bus-tool-"));
	store = new BusStore(undefined, ensureDirs(busDirs(root)));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function peer(name: string, hex: string): PeerRecord {
	return {
		protocol: 1,
		instanceId: hex.repeat(32),
		owner: hex.repeat(32),
		name,
		pid: 1,
		cwd: "/",
		sock: "/s",
		host: "h",
		labels: {},
		topics: [],
		state: "idle",
		startedAt: 0,
		heartbeatAt: 0,
	};
}

function envelope(extra: Partial<Envelope> = {}): Envelope {
	return {
		v: 1,
		id: "e".repeat(32),
		threadId: "f".repeat(32),
		from: peer("asker", "a"),
		to: "x",
		kind: "question",
		priority: "normal",
		wake: "now",
		body: "q",
		createdAt: 0,
		...extra,
	};
}

function result(parts: Partial<SendResult>): SendResult {
	return {
		envelope: envelope({ id: "d".repeat(32), from: peer("me", "9") }),
		matched: [],
		delivered: [],
		unknown: [],
		failed: [],
		acks: [],
		...parts,
	};
}

function host(sent: SendResult, calls: { to: string; corrId?: string | undefined }[] = []): ActionHost {
	const node = {
		instanceId: "9".repeat(32),
		send: async (to: string, init: { corrId?: string }) => {
			calls.push({ to, corrId: init.corrId });
			return sent;
		},
	} as unknown as BusNode;
	return { node: () => node, store: () => store, wakePolicy: "all", markRead: () => {}, changed: () => {} };
}

const mixed = result({
	delivered: [peer("alpha", "1")],
	unknown: [{ instanceId: "2".repeat(32), name: "beta", reason: "written but not acked" }],
	failed: [{ instanceId: "3".repeat(32), name: "gamma", reason: "connect ECONNREFUSED" }],
});

describe("send and reply results", () => {
	it("prints one delivered, one unconfirmed, and one failed line", () => {
		const lines = formatSendResult("Sent", mixed).split("\n");
		expect(lines.filter((line) => line.startsWith("delivered: "))).toEqual(["delivered: alpha (owner:111111111111)"]);
		expect(lines.filter((line) => line.startsWith("unconfirmed: "))).toEqual([
			"unconfirmed: beta (written but not acked)",
		]);
		expect(lines.filter((line) => line.startsWith("failed: "))).toEqual(["failed: gamma (connect ECONNREFUSED)"]);
	});

	it("returns a send with a delivered or unconfirmed peer as a result", async () => {
		const sent = await sendAction(host(mixed), { action: "send", target: "all", body: "hi" });
		expect(sent.text).toContain("unconfirmed: beta");
		const unconfirmedOnly = result({ unknown: [{ instanceId: "2".repeat(32), name: "beta", reason: "late" }] });
		await expect(
			sendAction(host(unconfirmedOnly), { action: "send", target: "all", body: "hi" }),
		).resolves.toBeDefined();
	});

	it("makes a send with nothing delivered or unconfirmed an error", async () => {
		const none = result({ failed: [{ instanceId: "3".repeat(32), name: "gamma", reason: "refused" }] });
		await expect(sendAction(host(none), { action: "send", target: "all", body: "hi" })).rejects.toThrow(
			/failed: gamma \(refused\)/,
		);
	});

	it("prints the same lines for a reply and errors when nothing is handed over", async () => {
		store.addInbound(envelope());
		const calls: { to: string; corrId?: string | undefined }[] = [];
		const replied = await replyAction(host(mixed, calls), { action: "reply", body: "a", messageId: "eeeeeeee" });
		expect(replied.text).toMatch(/delivered: alpha[\s\S]*unconfirmed: beta[\s\S]*failed: gamma/);
		expect(calls).toEqual([{ to: `owner:${"a".repeat(32)}`, corrId: "e".repeat(32) }]);
		const none = result({ failed: [{ instanceId: "a".repeat(32), name: "asker", reason: "gone" }] });
		await expect(replyAction(host(none), { action: "reply", body: "a", messageId: "eeeeeeee" })).rejects.toThrow(
			/failed: asker \(gone\)/,
		);
	});

	it("refuses to reply to a message whose sender has no owner", async () => {
		const { owner: _owner, ...ownerless } = peer("asker", "a");
		store.addInbound(envelope({ from: ownerless as PeerRecord }));
		const calls: { to: string; corrId?: string | undefined }[] = [];
		await expect(
			replyAction(host(mixed, calls), { action: "reply", body: "a", messageId: "eeeeeeee" }),
		).rejects.toThrow(/has no sender owner/);
		expect(calls).toEqual([]);
	});

	it("keeps the question unanswered when the reply reached nobody", async () => {
		store.addInbound(envelope());
		const none = result({ failed: [{ instanceId: "a".repeat(32), name: "asker", reason: "gone" }] });
		const sent = { ...none, envelope: { ...none.envelope, corrId: "e".repeat(32) } };
		await expect(replyAction(host(sent), { action: "reply", body: "a", messageId: "eeeeeeee" })).rejects.toThrow();
		expect(store.unansweredInbound().map((item) => item.id)).toEqual(["e".repeat(32)]);
	});
});

describe("inbox", () => {
	it("marks only fully shown bodies as read", () => {
		const short = envelope({ id: "1".repeat(32), kind: "note", body: "short" });
		const long = envelope({ id: "2".repeat(32), kind: "note", body: "y".repeat(500) });
		store.addInbound(short);
		store.addInbound(long);
		const read: string[] = [];
		const shown = inboxAction({ ...host(mixed), markRead: (ids) => read.push(...ids) }, {});
		expect(shown.text).toContain("messageId=111111111111");
		expect(shown.text).toContain("messageId=222222222222");
		expect(read).toEqual(["1".repeat(32)]);
	});
});
