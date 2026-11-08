import { describe as group, expect, it } from "vite-plus/test";
import {
	achieve,
	clear,
	copiedFromAnotherSession,
	countContinuation,
	countTurn,
	createGoal,
	describe,
	exceededBudget,
	type GoalRecord,
	isActive,
	isTerminal,
	latestFromEntries,
	pause,
	recover,
	resume,
	setCheck,
	setObjective,
	objectiveOf,
	validateCondition,
	validateObjective,
} from "./state.ts";

const T0 = 1_700_000_000_000;
const goal = (patch: Partial<GoalRecord> = {}): GoalRecord => ({
	...createGoal({ condition: "all tests pass", now: T0, id: "g1" }),
	...patch,
});

group("condition validation", () => {
	it("rejects an empty condition", () => expect(validateCondition("   ")).toBeTruthy());
	it("passes a normal condition", () => expect(validateCondition("tests pass")).toBeUndefined());
	it("allows 4000 characters", () => expect(validateCondition("x".repeat(4000))).toBeUndefined());
	it("rejects 4001 characters and names the count", () =>
		expect(validateCondition("x".repeat(4001))).toContain("4001"));
});

group("state transitions", () => {
	const fresh = goal();
	it("starts active with full autonomy at generation 1", () => {
		expect(isActive(fresh)).toBe(true);
		expect(fresh.state).toBe("active");
		expect(fresh.autonomy).toBe("full");
		expect(fresh.generation).toBe(1);
	});

	it("counts a turn without a new generation", () => {
		const turned = countTurn(fresh, T0 + 1000);
		expect(turned.turns).toBe(1);
		expect(turned.generation).toBe(1);
	});

	it("pauses with a reason and a new generation, and a paused goal is not terminal", () => {
		const paused = pause(countTurn(fresh, T0 + 1000), "user-input", "you typed something", T0 + 2000);
		expect(paused.generation).toBe(2);
		expect(paused.state).toBe("paused");
		expect(paused.pauseReason).toBe("user-input");
		expect(isTerminal(paused)).toBe(false);
	});

	it("resumes from paused and resets turns, clock, and reason", () => {
		const paused = pause(countTurn(fresh, T0 + 1000), "user-input", "x", T0 + 2000);
		const resumed = resume(paused, T0 + 3000);
		expect(resumed.record?.state).toBe("active");
		expect(resumed.record?.turns).toBe(0);
		expect(resumed.record?.startedAt).toBe(T0 + 3000);
		expect(resumed.record?.pauseReason).toBeUndefined();
	});

	it("refuses to resume an active or achieved goal", () => {
		expect(resume(fresh, T0).error).toBeTruthy();
		expect(resume(achieve(fresh, "ok", T0), T0).error).toBeTruthy();
	});

	it("has terminal achieved, achieved-unverified, and cleared states", () => {
		const done = achieve(fresh, "ran the tests", T0 + 5000);
		expect(isTerminal(done)).toBe(true);
		expect(done).toMatchObject({ state: "achieved", detail: "ran the tests" });
		expect(isTerminal({ ...fresh, state: "achieved-unverified" })).toBe(true);
		expect(isTerminal(clear(fresh, T0))).toBe(true);
	});
});

group("budgets", () => {
	const fresh = goal();
	it("has no turn cap, no deadline, and a rejected-claim budget of 5", () => {
		expect((fresh.limits as unknown as Record<string, unknown>)["maxTurns"]).toBeUndefined();
		expect((fresh.limits as unknown as Record<string, unknown>)["maxMs"]).toBeUndefined();
		expect(fresh.limits.maxRejected).toBe(5);
	});
	it("does not stop for turns or time", () => {
		expect(exceededBudget({ ...fresh, turns: 1_000 })).toBeUndefined();
		expect(exceededBudget({ ...fresh, startedAt: T0 - 24 * 60 * 60_000 })).toBeUndefined();
	});
	it("stops at 5 rejections, not 4, and names the count", () => {
		expect(exceededBudget({ ...fresh, rejected: 4 })).toBeUndefined();
		expect(exceededBudget({ ...fresh, rejected: 5 })?.reason).toBe("rejected-claims");
		expect(exceededBudget({ ...fresh, rejected: 5 })?.detail).toContain("5 claims rejected");
	});
	it("disables the stop with maxRejected 0", () => {
		expect(exceededBudget({ ...fresh, limits: { maxRejected: 0 }, rejected: 99 })).toBeUndefined();
	});
});

group("continuation count", () => {
	it("counts from 1 and survives a resume", () => {
		const first = countContinuation(goal(), T0);
		expect(first.continuations).toBe(1);
		const paused = pause(countContinuation(first, T0), "user-input", "x", T0);
		expect(resume(paused, T0).record?.continuations).toBe(2);
	});
});

group("copied goal detection", () => {
	const entry = (at: string, data: unknown = goal()) => ({ type: "custom", customType: "goal", data, timestamp: at });
	it("finds a goal that was saved before this session file was made", () => {
		expect(copiedFromAnotherSession([entry("2026-11-08T10:00:00.000Z")], "2026-11-08T10:00:01.000Z")).toBe(true);
	});
	it("keeps a goal that was saved in this session file, also in the same millisecond", () => {
		expect(copiedFromAnotherSession([entry("2026-11-08T10:00:01.000Z")], "2026-11-08T10:00:01.000Z")).toBe(false);
		expect(copiedFromAnotherSession([entry("2026-11-08T10:00:02.000Z")], "2026-11-08T10:00:01.000Z")).toBe(false);
	});
	it("uses the newest goal entry and ignores other entries", () => {
		const branch = [
			entry("2026-11-08T10:00:00.000Z"),
			entry("2026-11-08T10:00:05.000Z"),
			{ type: "custom", customType: "other", data: {}, timestamp: "2026-11-08T09:00:00.000Z" },
		];
		expect(copiedFromAnotherSession(branch, "2026-11-08T10:00:01.000Z")).toBe(false);
	});
	it("is false without a goal entry, a header time, or a valid time", () => {
		expect(copiedFromAnotherSession([], "2026-11-08T10:00:01.000Z")).toBe(false);
		expect(copiedFromAnotherSession([entry("2026-11-08T10:00:00.000Z")], undefined)).toBe(false);
		expect(copiedFromAnotherSession([entry("bad")], "2026-11-08T10:00:01.000Z")).toBe(false);
	});
});

group("recovery", () => {
	const active = goal();
	it("keeps an active goal on a restart or a reload, with or without a timer", () => {
		expect(recover(active, "restart", T0)).toBe(active);
		expect(recover(active, "reload", T0)).toBe(active);
	});
	it("pauses an active goal on a branch switch as navigation", () => {
		expect(recover(active, "navigation", T0)?.pauseReason).toBe("navigation");
	});
	it("pauses an active goal in a fork and says that the goal belongs to the original session", () => {
		expect(recover(active, "fork", T0 + 2)).toMatchObject({
			state: "paused",
			pauseReason: "fork",
			detail: "This session is a fork; the goal belongs to the original session.",
		});
	});
	it("leaves paused and achieved goals and no goal alone", () => {
		const paused = pause(active, "deadline", "out of time", T0);
		expect(recover(paused, "fork", T0)).toBe(paused);
		expect(recover(achieve(active, "", T0), "navigation", T0)?.state).toBe("achieved");
		expect(recover(undefined, "restart", T0)).toBeUndefined();
	});
});

group("reconstruction from session entries", () => {
	const older = goal({ id: "old", condition: "first" });
	const newer = pause(goal({ id: "new", condition: "second" }), "deadline", "d", T0);
	it("takes the newest goal entry and ignores other extensions", () => {
		const entries = [
			{ type: "message", message: { role: "user" } },
			{ type: "custom", customType: "goal", data: older },
			{ type: "message", message: { role: "assistant" } },
			{ type: "custom", customType: "goal", data: newer },
			{ type: "custom", customType: "other-extension", data: { id: "x" } },
		];
		expect(latestFromEntries(entries)?.id).toBe("new");
		expect(latestFromEntries([{ type: "custom", customType: "background", data: { id: "no" } }])).toBeUndefined();
	});
	it("loads and renders a record paused as wake-source-lost", () => {
		const old = pause(goal(), "wake-source-lost", "No timer is armed in this pi process.", T0);
		const loaded = latestFromEntries([{ type: "custom", customType: "goal", data: old }]);
		expect(describe(loaded, T0)).toContain("paused: wake-source-lost (No timer is armed in this pi process.)");
	});
	it("loads a record saved with a waiting field and drops the field", () => {
		const old = { ...goal(), waiting: { token: "w", reason: "CI result", generation: 1 } };
		const loaded = latestFromEntries([{ type: "custom", customType: "goal", data: old }]);
		expect(loaded).toEqual(goal());
		expect(loaded && "waiting" in loaded).toBe(false);
		expect(describe(loaded, T0)).toContain("Goal (active)\nobjective: all tests pass");
	});
	it("ignores malformed data, an empty branch, and custom_message entries", () => {
		expect(latestFromEntries([{ type: "custom", customType: "goal", data: { nope: true } }])).toBeUndefined();
		expect(latestFromEntries([])).toBeUndefined();
		expect(latestFromEntries([{ type: "custom_message", customType: "goal", data: older }])).toBeUndefined();
	});
});

group("status rendering", () => {
	it("reads plainly with no goal", () => expect(describe(undefined, T0)).toBe("No goal set."));
	it("shows objective, turns, and check command", () => {
		const text = describe(countTurn(goal({ check: "npm test" }), T0), T0 + 120_000);
		expect(text).toContain("objective: all tests pass");
		expect(text).toMatch(/turns: 1\b/);
		expect(text).toContain("check: npm test");
	});
	it("shows who set the goal, the objective, the request, and each change", () => {
		const set = goal({ setBy: "model", objective: "v1.2.0 is tagged", condition: "release it, i'll be afk" });
		const changed = setObjective(set, "v1.2.0 is tagged. Not deployed.", "skip the deploy", T0 + 60_000);
		const text = describe(changed, T0 + 120_000);
		expect(text.split("\n").slice(0, 5)).toEqual([
			"Goal (active, set by the model)",
			"objective: v1.2.0 is tagged. Not deployed.",
			"request: release it, i'll be afk",
			"changes:",
			`- ${new Date(T0 + 60_000).toTimeString().slice(0, 8)} skip the deploy`,
		]);
	});
	it("shows a pending objective of a goal set by the human", () => {
		const text = describe(goal({ setBy: "human", condition: "continue the work" }), T0);
		expect(text).toContain("Goal (active, set by the human)\nobjective: not defined yet\nrequest: continue the work");
	});
	it("shows why a goal paused", () => {
		const text = describe(pause(goal(), "blocked", "needs a decision", T0), T0);
		expect(text).toContain("blocked");
		expect(text).toContain("needs a decision");
	});
	it("reports achieved and unverified achievement", () => {
		expect(describe(achieve(goal(), "", T0), T0).startsWith("Goal achieved: all tests pass")).toBe(true);
		expect(describe({ ...goal(), state: "achieved-unverified", detail: "x" }, T0)).toContain("unverified");
		const modelGoal = achieve(goal({ setBy: "model", objective: "tag pushed" }), "", T0);
		expect(describe(modelGoal, T0)).toBe("Goal achieved: tag pushed");
	});
});

group("a new verifier is a new generation", () => {
	it("bumps the generation on set and clear, trims, and treats blank as clear", () => {
		const withCheck = setCheck(goal(), "npm test", T0 + 1000);
		expect(withCheck.generation).toBe(2);
		expect(setCheck(goal(), "  npm test  ", T0).check).toBe("npm test");
		expect(setCheck(withCheck, undefined, T0).generation).toBe(3);
		expect(setCheck(withCheck, "   ", T0).check).toBeUndefined();
	});
});

group("objective", () => {
	it("is the condition for a goal saved before goals had an objective", () => {
		expect(objectiveOf(goal())).toBe("all tests pass");
	});
	it("is pending for a goal set by the human until the model defines it", () => {
		expect(objectiveOf(goal({ setBy: "human" }))).toBeUndefined();
		expect(objectiveOf(goal({ setBy: "model", objective: "tag pushed" }))).toBe("tag pushed");
	});
	it("validates an objective with texts that say nothing changed", () => {
		expect(validateObjective(" ")).toBe(
			"Nothing changed: the objective is empty. Say what must be true for the goal to be done.",
		);
		expect(validateObjective("x".repeat(4000))).toBeUndefined();
		expect(validateObjective("x".repeat(4001))).toBe(
			"Nothing changed: an objective is at most 4000 characters, this one is 4001. Put the detail in a file and point the goal at it.",
		);
	});
	it("saves a first objective without a change entry and keeps the human's words", () => {
		const set = setObjective(goal({ setBy: "human", condition: "continue" }), " tag pushed ", undefined, T0 + 1);
		expect(set).toMatchObject({ objective: "tag pushed", condition: "continue", setBy: "human", generation: 2 });
		expect(set.changes).toBeUndefined();
	});
	it("records each human change, keeps the last 10, and clips each to 1000 chars", () => {
		let record = goal({ setBy: "model", objective: "o0" });
		for (let index = 1; index <= 12; index++) record = setObjective(record, `o${index}`, `change ${index}`, T0 + index);
		expect(record.changes?.map((change) => change.request)).toEqual(
			Array.from({ length: 10 }, (_, index) => `change ${index + 3}`),
		);
		expect(record.changes?.at(-1)?.at).toBe(T0 + 12);
		const long = setObjective(record, "o13", "y".repeat(1500), T0);
		expect(long.changes?.at(-1)?.request).toHaveLength(1000);
	});
	it("turns a goal saved before objectives into a human goal on edit", () => {
		const edited = setObjective(goal(), "tests and lint pass", "also lint", T0);
		expect(edited).toMatchObject({ setBy: "human", objective: "tests and lint pass", condition: "all tests pass" });
		expect(objectiveOf(edited)).toBe("tests and lint pass");
	});
});
