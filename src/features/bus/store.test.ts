import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { Envelope } from "./protocol.ts";
import { type BusDirs, busDirs, ensureDirs } from "./registry.ts";
import { BusStore, historyPath, prepareHistory } from "./store.ts";

let root: string;
let dirs: BusDirs;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bus-store-"));
	dirs = ensureDirs(busDirs(root));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function envelope(id: string, extra: Partial<Envelope> = {}): Envelope {
	return {
		v: 1,
		id,
		threadId: "t".repeat(32),
		from: { instanceId: "1".repeat(32), owner: "2".repeat(32), name: "peer", pid: 1, cwd: "/", sock: "/s", labels: {} },
		to: "self",
		kind: "note",
		priority: "normal",
		wake: "now",
		body: "hi",
		createdAt: 1,
		...extra,
	};
}

describe("bus history", () => {
	it("keys the history file by the sha256 of the session file, like the standalone bus", () => {
		const key = createHash("sha256").update("/s/a.jsonl").digest("hex").slice(0, 12);
		expect(historyPath("/s/a.jsonl", dirs)).toBe(join(dirs.history, `${key}.jsonl`));
		const store = new BusStore("/s/a.jsonl", dirs);
		store.addInbound(envelope("a".repeat(32)));
		const line = JSON.parse(readFileSync(historyPath("/s/a.jsonl", dirs), "utf8").trim());
		expect(line).toEqual({ direction: "in", envelope: envelope("a".repeat(32)) });
	});

	it("never stores a control token", () => {
		const store = new BusStore("/s/a.jsonl", dirs);
		store.addInbound(envelope("a".repeat(32), { kind: "control", data: { token: "secret", x: 1 } }));
		expect(readFileSync(historyPath("/s/a.jsonl", dirs), "utf8")).not.toContain("secret");
	});

	it("never counts event or control envelopes as unread", () => {
		const store = new BusStore(undefined, dirs);
		store.addInbound(envelope("a".repeat(32), { kind: "event" }));
		store.addInbound(envelope("b".repeat(32), { kind: "control", data: { token: "t" } }));
		store.addInbound(envelope("c".repeat(32), { kind: "note" }));
		expect([...store.unread]).toEqual(["c".repeat(32)]);
	});

	it("needs 8 hex characters for a message id prefix and rejects an ambiguous one", () => {
		const store = new BusStore(undefined, dirs);
		store.addInbound(envelope("abcdef0111111111111111111111111a"));
		store.addInbound(envelope("abcdef0122222222222222222222222b"));
		expect(store.lookup("a")).toEqual({ error: expect.stringMatching(/at least 8 hex/) });
		expect(store.lookup("abcdef01")).toEqual({ error: expect.stringMatching(/matches 2 messages/) });
		expect(store.lookup("abcdef011")).toMatchObject({ envelope: { id: "abcdef0111111111111111111111111a" } });
	});

	it("answers the latest inbound message of one thread and rejects a short or ambiguous thread prefix", () => {
		const store = new BusStore(undefined, dirs);
		const one = "12345678aaaaaaaaaaaaaaaaaaaaaaaa";
		const two = "12345678bbbbbbbbbbbbbbbbbbbbbbbb";
		store.addInbound(envelope("a".repeat(32), { threadId: one, createdAt: 1 }));
		store.addInbound(envelope("b".repeat(32), { threadId: one, createdAt: 2 }));
		store.addInbound(envelope("c".repeat(32), { threadId: two, createdAt: 3 }));
		expect(store.latestInbound("1234")).toEqual({ error: expect.stringMatching(/at least 8 hex/) });
		expect(store.latestInbound("12345678")).toEqual({ error: expect.stringMatching(/matches 2 threads/) });
		expect(store.latestInbound("12345678a")).toMatchObject({ envelope: { id: "b".repeat(32) } });
		expect(store.latestInbound("deadbeef")).toEqual({ error: expect.stringMatching(/No inbound message/) });
	});

	it("restores the same messages and unread state from a snapshot", () => {
		const store = new BusStore("/s/a.jsonl", dirs);
		store.addInbound(envelope("a".repeat(32)));
		store.addInbound(envelope("b".repeat(32)));
		store.addOutbound(envelope("c".repeat(32)));
		store.markRead(["a".repeat(32)]);
		const snapshot = JSON.parse(JSON.stringify(store.snapshot())) as ReturnType<BusStore["snapshot"]>;
		const restored = BusStore.restore("/s/a.jsonl", dirs, snapshot);
		expect(restored.inbox).toEqual(store.inbox);
		expect(restored.outbox).toEqual(store.outbox);
		expect([...restored.unread]).toEqual(["b".repeat(32)]);
	});

	it("lists inbound questions that no outbound message answers", () => {
		const store = new BusStore(undefined, dirs);
		store.addInbound(envelope("a".repeat(32), { kind: "question" }));
		store.addInbound(envelope("b".repeat(32), { kind: "task", replyExpected: true }));
		store.addInbound(envelope("c".repeat(32), { kind: "note" }));
		store.addOutbound(envelope("d".repeat(32), { kind: "answer", corrId: "a".repeat(32) }));
		expect(store.unansweredInbound().map((e) => e.id)).toEqual(["b".repeat(32)]);
	});

	it("sets old files to 0600 and removes files past retention", () => {
		const old = join(dirs.history, "000000000000.jsonl");
		const fresh = join(dirs.history, "111111111111.jsonl");
		writeFileSync(old, "", { mode: 0o644 });
		writeFileSync(fresh, "", { mode: 0o644 });
		const now = Date.now();
		utimesSync(old, (now - 40 * 86_400_000) / 1000, (now - 40 * 86_400_000) / 1000);
		expect(prepareHistory(dirs, 30, { now })).toEqual({ removed: 1 });
		expect(statSync(fresh).mode & 0o777).toBe(0o600);
		expect(() => statSync(old)).toThrow();
	});

	it("keeps the active session's history file past retention", () => {
		const active = historyPath("/s/active.jsonl", dirs);
		writeFileSync(active, "");
		writeFileSync(`${active}.1`, "");
		utimesSync(active, 0, 0);
		utimesSync(`${active}.1`, 0, 0);
		expect(prepareHistory(dirs, 30, { keep: active })).toEqual({ removed: 0 });
		expect(statSync(active).isFile()).toBe(true);
	});

	it("keeps every file when retention is 0", () => {
		const old = join(dirs.history, "000000000000.jsonl");
		writeFileSync(old, "");
		utimesSync(old, 0, 0);
		expect(prepareHistory(dirs, 0)).toEqual({ removed: 0 });
	});
});
