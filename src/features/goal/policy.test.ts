import { describe, expect, it } from "vite-plus/test";
import { GOAL_PROMPT } from "./prompt.ts";
import {
	checkFailedText,
	continuationText,
	goalContextText,
	CHECK_CHANGED_TEXT,
	checkCommandChangedText,
	objectiveReplacedText,
	resumedText,
	stalePauseText,
	startText,
} from "./policy.ts";
import { createGoal, setObjective } from "./state.ts";

const T0 = 1_700_000_000_000;
const record = {
	...createGoal({ condition: "all tests pass", check: "npm test", now: T0, id: "g1" }),
	generation: 3,
};
const modelGoal = createGoal({
	condition: "keep going until v1.2 is released, i'll be afk",
	objective: "v1.2.0 is tagged.\nShown by: git ls-remote.",
	setBy: "model",
	now: T0,
	id: "g2",
});

describe("active goal block", () => {
	const context = goalContextText(record);
	it("carries the objective and the check command, not the generation", () => {
		expect(context).toContain("objective:\nall tests pass\n");
		expect(context).toContain("check command (run by the harness when you call goal_done): npm test");
		expect(context).not.toContain("generation");
	});
	it("states the limits and every stop", () => {
		expect(context).toContain(
			"There is no turn or time limit. The goal stops when goal_done is accepted, after 5 failed checks, on a harness failure, or when you report a blocker.",
		);
		expect(context).not.toMatch(/turns used|remaining|rounds/i);
	});
	it("names no failed-check stop without a check or with the stop off", () => {
		const stop =
			"There is no turn or time limit. The goal stops when goal_done is accepted, on a harness failure, or when you report a blocker.";
		expect(goalContextText({ ...record, check: undefined })).toContain(stop);
		expect(goalContextText({ ...record, limits: { maxRejected: 0 } })).toContain(stop);
		expect(goalContextText({ ...record, check: undefined })).not.toContain("check command");
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
	it("shows the objective and the human request of a model goal", () => {
		expect(goalContextText(modelGoal)).toBe(
			[
				"<active-goal>",
				"objective:",
				"v1.2.0 is tagged.\nShown by: git ls-remote.",
				"human request:",
				"keep going until v1.2 is released, i'll be afk",
				"There is no turn or time limit. The goal stops when goal_done is accepted, on a harness failure, or when you report a blocker.",
				"</active-goal>",
			].join("\n"),
		);
	});
	it("marks a pending objective", () => {
		const pending = createGoal({ condition: "continue the work", setBy: "human", now: T0, id: "g3" });
		expect(goalContextText(pending)).toMatch(
			/^<active-goal>\nobjective: not defined yet\nhuman request:\ncontinue the work\n/,
		);
	});
	it("shows the last 3 human changes, oldest first", () => {
		let changed = modelGoal;
		for (const words of ["one", "two", "three", "four"]) changed = setObjective(changed, `o ${words}`, words, T0);
		expect(goalContextText(changed)).toContain(
			"human request:\nkeep going until v1.2 is released, i'll be afk\nhuman changes, oldest first:\n- two\n- three\n- four\nThere is",
		);
	});
});

describe("start text", () => {
	const text = startText(record, "Goal set by the human.");
	it("carries the headline and the block", () => {
		expect(text).toBe(`Goal set by the human.\n${goalContextText(record)}`);
	});
	it("asks for an objective while it is pending", () => {
		const pending = createGoal({
			condition: "continue the work until it is deployed",
			setBy: "human",
			now: T0,
			id: "g3",
		});
		expect(startText(pending, "Goal set by the human.")).toBe(
			[
				"Goal set by the human.",
				"<active-goal>",
				"objective: not defined yet",
				"human request:",
				"continue the work until it is deployed",
				"There is no turn or time limit. The goal stops when goal_done is accepted, on a harness failure, or when you report a blocker.",
				"</active-goal>",
				'First call goal_set action="edit" with an objective that states this request as a self-contained end state. Take the details from this conversation. If the request is unclear, call notify kind="blocked" with your question.',
			].join("\n"),
		);
	});
	it("is not a continuation and has no generation tag", () => {
		expect(text).not.toMatch(/continuation/i);
		expect(text).not.toMatch(/generation \d+/);
	});
});

describe("check command changed text", () => {
	it("says that only the check command changed", () => {
		expect(checkCommandChangedText(record)).toBe(`The goal check command changed.\n${goalContextText(record)}`);
	});
});

describe("resumed text", () => {
	it("carries the goal block", () => {
		expect(resumedText(modelGoal)).toBe(
			`Goal resumed. Keep working toward the objective. Call goal_done when it holds now.\n${goalContextText(modelGoal)}`,
		);
	});
});

describe("objective replaced text", () => {
	it("says the new block is the goal from now on", () => {
		expect(objectiveReplacedText(modelGoal)).toBe(
			`Objective replaced. It is the goal from now on. The earlier objective no longer counts.\n${goalContextText(modelGoal)}`,
		);
	});
});

describe("continuation text", () => {
	it("is numbered from the continuations of the goal, not from its turns", () => {
		expect(continuationText({ ...record, turns: 11, continuations: 3 })).toBe(
			"Goal continuation 3.\nKeep working toward the objective. Call goal_done when it holds now.",
		);
	});
	it("carries a rejection hint when given", () => {
		expect(continuationText(record, "rejected: no output")).toContain("\nrejected: no output\n");
	});
});

describe("check failed text", () => {
	it("gives the exit code and the output tail", () => {
		expect(checkFailedText(1, "1 test failed")).toBe(
			"Check failed: exit 1:\n1 test failed\nKeep working: close that gap, then call goal_done again.",
		);
		expect(checkFailedText(2, "")).toBe(
			"Check failed: exit 2\nKeep working: close that gap, then call goal_done again.",
		);
	});
});

describe("stale texts", () => {
	it("tells the model to stop after a discarded verdict and speaks of checks and the human", () => {
		expect(stalePauseText()).toContain("Do not continue");
		for (const text of [stalePauseText(), CHECK_CHANGED_TEXT]) {
			expect(text).not.toMatch(/adjudicat|\buser\b/);
		}
	});
});

describe("goal prompt section", () => {
	it("holds the timer rule once and no goal_wait rule", () => {
		expect(GOAL_PROMPT.match(/a run that ends with no armed `timer` gets a continuation at once/g)).toHaveLength(1);
		expect(GOAL_PROMPT).not.toContain("goal_wait");
		expect(GOAL_PROMPT).not.toMatch(/\bturn\b/);
	});
	it("names the objective and asks for proof from this goal", () => {
		expect(GOAL_PROMPT).toContain("An autonomous goal is active when an `<active-goal>` block states its objective.");
		expect(GOAL_PROMPT).toContain(
			"Call `goal_done` only when the objective holds now and tool results of this goal show it. A plan, partial work, or a skipped check is not done.",
		);
		expect(GOAL_PROMPT).not.toContain("independent check");
	});
});
