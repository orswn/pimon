import { describe, expect, it } from "vite-plus/test";
import { GOAL_PROMPT } from "./prompt.ts";
import { continuationText, goalContextText, stalePauseText, startText } from "./policy.ts";
import { createGoal } from "./state.ts";

const record = {
	...createGoal({ condition: "all tests pass", check: "npm test", now: 1_700_000_000_000, id: "g1" }),
	generation: 3,
};

describe("condition text", () => {
	const context = goalContextText(record);
	it("carries the condition and the check command, not the generation", () => {
		expect(context).toContain("all tests pass");
		expect(context).toContain("npm test");
		expect(context).not.toContain("generation");
	});
	it("states the limits and every stop", () => {
		expect(context).toContain("no turn or time limit");
		expect(context).not.toMatch(/only automatic stop/i);
		expect(context).toContain("harness failure");
		expect(context).toContain("report a blocker");
		expect(context).toContain("5 rejected");
		expect(context).not.toMatch(/turns used|remaining/i);
	});
	it("is byte-stable across turns and generations", () => {
		expect(goalContextText({ ...record, turns: 7 })).toBe(context);
		expect(goalContextText({ ...record, generation: 99 })).toBe(context);
	});
	it("does not repeat the rules of the goal prompt section", () => {
		expect(context).not.toContain("timer");
		expect(context).not.toMatch(/poll|sleep/i);
		expect(context).not.toContain("unattended");
	});
	it("states no rejection limit when the budget is off", () => {
		expect(goalContextText({ ...record, limits: { maxRejected: 0 } })).toContain("no turn, time, or rejection limit");
	});
});

describe("start text", () => {
	const text = startText(record, "Goal set.");
	it("carries the headline and the condition", () => {
		expect(text.startsWith("Goal set.\n")).toBe(true);
		expect(text).toContain(goalContextText(record));
	});
	it("is not a continuation and has no generation tag", () => {
		expect(text).not.toMatch(/continuation/i);
		expect(text).not.toMatch(/generation \d+/);
	});
});

describe("continuation text", () => {
	it("is short and numbered from the turn count", () => {
		expect(continuationText(record).length).toBeLessThan(400);
		expect(continuationText({ ...record, turns: 2 })).toContain("Goal continuation 3.");
	});
	it("carries a rejection hint when given", () => {
		expect(continuationText(record, "rejected: no output")).toContain("no output");
	});
	it("tells the model how a run may end", () => {
		expect(continuationText(record)).toContain(
			"To wait for external work, arm it, then set a timer for when it should be done. A run ends only while a timer is armed.",
		);
	});
});

describe("stale texts", () => {
	it("tells the model to stop after a discarded verdict", () => {
		expect(stalePauseText()).toContain("Do not continue");
	});
});

describe("goal prompt section", () => {
	it("holds the timer rule once and no goal_wait rule", () => {
		expect(GOAL_PROMPT.match(/a run ends only while a `timer` is armed/g)).toHaveLength(1);
		expect(GOAL_PROMPT).not.toContain("goal_wait");
		expect(GOAL_PROMPT).not.toMatch(/\bturn\b/);
	});
});
