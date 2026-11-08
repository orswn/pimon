import { describe, expect, it } from "vite-plus/test";
import type { Envelope } from "./protocol.ts";
import { busDirs } from "./registry.ts";
import { BusStore } from "./store.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");

function envelope(n: number): Envelope {
	return {
		v: 1,
		id: id(n),
		threadId: "t".repeat(32),
		from: { instanceId: "1".repeat(32), owner: "2".repeat(32), name: "peer", pid: 1, cwd: "/", sock: "/s", labels: {} },
		to: "self",
		kind: "note",
		priority: "normal",
		wake: "never",
		body: "hi",
		createdAt: n,
	};
}

describe("bus store unread ids", () => {
	it("drops unread ids whose envelopes were trimmed from the inbox", () => {
		const store = new BusStore(undefined, busDirs("/nonexistent-agent-dir"));
		for (let n = 1; n <= 450; n++) store.addInbound(envelope(n));
		const inbox = new Set(store.inbox.map((entry) => entry.id));
		expect(store.unread.size).toBe(inbox.size);
		expect([...store.unread].every((unread) => inbox.has(unread))).toBe(true);
		expect(store.unread.has(id(1))).toBe(false);
		expect(store.unread.has(id(450))).toBe(true);
	});

	it("keeps only unread ids of kept envelopes when it restores a snapshot", () => {
		const dirs = busDirs("/nonexistent-agent-dir");
		const inbox = Array.from({ length: 450 }, (_, n) => envelope(n + 1));
		const unread = [...inbox.map((entry) => entry.id), ...Array.from({ length: 50 }, (_, n) => id(1_000 + n))];
		const big = BusStore.restore(undefined, dirs, { inbox, outbox: [], unread });
		expect(big.inbox).toHaveLength(400);
		expect(big.unread.size).toBe(400);
		expect(big.unread.has(id(1))).toBe(false);

		const stale = BusStore.restore(undefined, dirs, { inbox: inbox.slice(-10), outbox: [], unread });
		expect([...stale.unread].sort()).toEqual(
			inbox
				.slice(-10)
				.map((entry) => entry.id)
				.sort(),
		);
	});
});
