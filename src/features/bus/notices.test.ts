import { describe, expect, it } from "vite-plus/test";
import type { PendingResult, PresenceEvent } from "../../hub/protocol.ts";
import { MAX_STATE_CHARS, MAX_STATE_ITEMS, renderOpenState } from "./digest.ts";
import { ExpectedExits, offlineNotice, offlineWakes, type OfflineContext, openWorkWith } from "./notices.ts";

const PEER = "d".repeat(32);
const empty: PendingResult = { expectReply: [], tasks: [] };

function asked(agent: string): PendingResult {
	return {
		expectReply: [{ messageId: "m", contextId: "c", taskId: null, agent, name: "peer", createdAt: "" }],
		tasks: [],
	};
}

function tasked(agent: string | null): PendingResult {
	return {
		expectReply: [],
		tasks: [{ taskId: "t", contextId: "c", agent, name: "peer", state: "working", createdAt: "" }],
	};
}

const offline = (extra: Partial<PresenceEvent> = {}): PresenceEvent => ({
	agent: PEER,
	name: "peer",
	online: false,
	relation: "peer",
	...extra,
});

const context = (extra: Partial<OfflineContext> = {}): OfflineContext => ({
	parent: undefined,
	policy: "all",
	...extra,
});

describe("open work with one agent", () => {
	it("counts questions and tasks in both directions for that agent only", () => {
		expect(openWorkWith(PEER, asked(PEER), tasked(PEER))).toEqual({ waiting: 1, owed: 1 });
		expect(openWorkWith(PEER, asked("other"), tasked(null))).toEqual({ waiting: 0, owed: 0 });
	});
});

describe("offline wake rule", () => {
	it("does not wake for an agent without open work", () => {
		expect(offlineWakes(offline(), { waiting: 0, owed: 0 }, context())).toBe(false);
	});

	it("wakes when a question or task to that agent is open", () => {
		expect(offlineWakes(offline(), { waiting: 1, owed: 0 }, context())).toBe(true);
	});

	it("wakes when that agent still waits for an answer from this session", () => {
		expect(offlineWakes(offline(), { waiting: 0, owed: 1 }, context())).toBe(true);
	});

	it("wakes for a child", () => {
		expect(offlineWakes(offline({ relation: "child" }), { waiting: 0, owed: 0 }, context())).toBe(true);
		expect(offlineWakes(offline({ relation: "parent" }), { waiting: 0, owed: 0 }, context())).toBe(false);
	});

	it("follows the wake policy", () => {
		const work = { waiting: 1, owed: 0 };
		expect(offlineWakes(offline(), work, context({ policy: "none" }))).toBe(false);
		expect(offlineWakes(offline(), work, context({ policy: "parent" }))).toBe(false);
		expect(offlineWakes(offline(), work, context({ policy: "parent", parent: PEER }))).toBe(true);
	});

	it("names the agent and its unanswered requests", () => {
		expect(offlineNotice(offline(), { waiting: 0, owed: 0 })).toBe("peer (id:dddddddddddd) went offline.");
		expect(offlineNotice(offline(), { waiting: 2, owed: 0 })).toBe(
			"peer (id:dddddddddddd) went offline. It had 2 unanswered request(s).",
		);
	});
});

describe("open state after compaction", () => {
	it("caps items and characters and counts the rest", () => {
		const many: PendingResult = {
			expectReply: Array.from({ length: 30 }, (_, index) => ({
				messageId: index.toString(16).padStart(32, "0"),
				contextId: "c",
				taskId: null,
				agent: PEER,
				name: "x".repeat(100),
				createdAt: "",
			})),
			tasks: [],
		};
		const text = renderOpenState(3, many, empty) ?? "";
		expect(text.length).toBeLessThanOrEqual(MAX_STATE_CHARS);
		expect(text.split("\n").filter((line) => line.startsWith("- Pending")).length).toBeLessThanOrEqual(MAX_STATE_ITEMS);
		expect(text).toMatch(/- \d+ more\. Use pi_bus/);
	});
});

describe("expected exits", () => {
	const MIN = 60_000;

	it("matches the next offline event of a marked agent once", () => {
		const exits = new ExpectedExits();
		exits.expect("o1", 0);
		expect(exits.take("o2", 1)).toBe(false);
		expect(exits.take("o1", 1)).toBe(true);
		expect(exits.take("o1", 2)).toBe(false);
	});

	it("drops a mark after 10 minutes", () => {
		const exits = new ExpectedExits();
		exits.expect("o1", 0);
		expect(exits.take("o1", 10 * MIN + 1)).toBe(false);
		exits.expect("o1", 0);
		expect(exits.take("o1", 10 * MIN - 1)).toBe(true);
	});

	it("drops a mark that is cleared or cancelled", () => {
		const exits = new ExpectedExits();
		exits.expect("o1", 0);
		exits.clear("o1");
		expect(exits.take("o1", 1)).toBe(false);
		const cancel = exits.expect("o1", 0);
		cancel();
		expect(exits.take("o1", 1)).toBe(false);
	});

	it("keeps a newer mark when an older one is cancelled, also in the same millisecond", () => {
		const exits = new ExpectedExits();
		const cancelOld = exits.expect("o1", 5);
		exits.expect("o1", 5);
		cancelOld();
		expect(exits.take("o1", 6)).toBe(true);
	});
});
