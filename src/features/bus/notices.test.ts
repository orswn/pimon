import { describe, expect, it } from "vite-plus/test";
import { MAX_STATE_CHARS, MAX_STATE_ITEMS, renderOpenState } from "./digest.ts";
import type { PeerGone } from "./node.ts";
import { type PeerGoneContext, peerGoneWakes } from "./notices.ts";
import type { Envelope, PeerRecord, PendingQuestion } from "./protocol.ts";

const SELF_OWNER = "a".repeat(32);
const SELF_ID = "b".repeat(32);

function record(extra: Partial<PeerRecord> = {}): PeerRecord {
	return {
		protocol: 1,
		instanceId: "c".repeat(32),
		owner: "d".repeat(32),
		name: "peer",
		pid: 1,
		cwd: "/",
		sock: "/s",
		host: "h",
		labels: {},
		topics: [],
		state: "idle",
		startedAt: 0,
		heartbeatAt: 0,
		...extra,
	};
}

function pending(id: string): PendingQuestion {
	return { envelopeId: id, threadId: "t", to: "x", targets: [], body: "q", askedAt: 0, dueAt: 0, nudged: false };
}

function context(extra: Partial<PeerGoneContext> = {}): PeerGoneContext {
	return {
		selfOwner: SELF_OWNER,
		selfInstanceId: SELF_ID,
		parent: undefined,
		policy: "all",
		unansweredInbound: [],
		...extra,
	};
}

const gone = (extra: Partial<PeerGone> = {}): PeerGone => ({
	record: record(),
	reason: "exited",
	pending: [],
	...extra,
});

describe("peer exit wake rule", () => {
	it("does not wake for an unrelated peer", () => {
		expect(peerGoneWakes(gone(), context())).toBe(false);
	});

	it("wakes when a question to that peer is pending", () => {
		expect(peerGoneWakes(gone({ pending: [pending("q")] }), context())).toBe(true);
	});

	it("wakes when that peer still waits for an answer from this instance", () => {
		const inbound = { from: { owner: "d".repeat(32), instanceId: "x" } } as Envelope;
		expect(peerGoneWakes(gone(), context({ unansweredInbound: [inbound] }))).toBe(true);
	});

	it("wakes for a tracked child", () => {
		expect(peerGoneWakes(gone({ record: record({ labels: { parent: SELF_OWNER } }) }), context())).toBe(true);
	});

	it("follows the wake policy", () => {
		const owed = gone({ pending: [pending("q")] });
		expect(peerGoneWakes(owed, context({ policy: "none" }))).toBe(false);
		expect(peerGoneWakes(owed, context({ policy: "parent" }))).toBe(false);
		expect(peerGoneWakes(owed, context({ policy: "parent", parent: "d".repeat(32) }))).toBe(true);
	});
});

describe("open state after compaction", () => {
	it("is empty when nothing is open", () => {
		expect(renderOpenState(0, [], [])).toBeUndefined();
	});

	it("caps items and characters and counts the rest", () => {
		const many = Array.from({ length: 30 }, (_, index) => ({
			...pending(index.toString(16).padStart(32, "0")),
			body: "x".repeat(300),
		}));
		const text = renderOpenState(3, many, []) ?? "";
		expect(text.length).toBeLessThanOrEqual(MAX_STATE_CHARS);
		expect(text.split("\n").filter((line) => line.startsWith("- Pending")).length).toBeLessThanOrEqual(MAX_STATE_ITEMS);
		expect(text).toMatch(/- \d+ more\. Use pi_bus/);
	});
});
