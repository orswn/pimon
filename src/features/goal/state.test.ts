import { describe as group, expect, it } from "vite-plus/test";
import {
	achieve,
	clear,
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
	validateCondition,
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
		expect(resume(achieve(fresh, true, "ok", T0), T0).error).toBeTruthy();
	});

	it("has terminal achieved, achieved-unverified, and cleared states", () => {
		const done = achieve(fresh, true, "verified", T0 + 5000);
		expect(isTerminal(done)).toBe(true);
		expect(done.state).toBe("achieved");
		expect(achieve(fresh, false, "adjudicator down", T0).state).toBe("achieved-unverified");
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

group("recovery", () => {
	const active = goal();
	it("keeps an active goal on restart while a timer of its session is armed in this process", () => {
		expect(recover(active, "restart", T0, { timerArmed: true })).toBe(active);
	});
	it("pauses an active goal without a timer on restart as wake-source-lost and says why", () => {
		const lost = recover(active, "restart", T0 + 2, { timerArmed: false });
		expect(lost).toMatchObject({
			state: "paused",
			pauseReason: "wake-source-lost",
			detail: "No timer is armed in this pi process.",
		});
	});
	it("pauses an active goal on a branch switch as navigation, also with a timer", () => {
		expect(recover(active, "navigation", T0, { timerArmed: true })?.pauseReason).toBe("navigation");
		expect(recover(active, "navigation", T0, { timerArmed: false })?.pauseReason).toBe("navigation");
	});
	it("leaves paused and achieved goals and no goal alone", () => {
		const paused = pause(active, "deadline", "out of time", T0);
		expect(recover(paused, "restart", T0, { timerArmed: false })).toBe(paused);
		expect(recover(achieve(active, true, "", T0), "restart", T0, { timerArmed: false })?.state).toBe("achieved");
		expect(recover(undefined, "restart", T0, { timerArmed: false })).toBeUndefined();
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
	it("loads a record saved with a waiting field and drops the field", () => {
		const old = { ...goal(), waiting: { token: "w", reason: "CI result", generation: 1 } };
		const loaded = latestFromEntries([{ type: "custom", customType: "goal", data: old }]);
		expect(loaded).toEqual(goal());
		expect(loaded && "waiting" in loaded).toBe(false);
		expect(describe(loaded, T0)).toContain("Goal (active): all tests pass");
	});
	it("ignores malformed data, an empty branch, and custom_message entries", () => {
		expect(latestFromEntries([{ type: "custom", customType: "goal", data: { nope: true } }])).toBeUndefined();
		expect(latestFromEntries([])).toBeUndefined();
		expect(latestFromEntries([{ type: "custom_message", customType: "goal", data: older }])).toBeUndefined();
	});
});

group("status rendering", () => {
	it("reads plainly with no goal", () => expect(describe(undefined, T0)).toBe("No goal set."));
	it("shows condition, autonomy, turns, and check command", () => {
		const text = describe(countTurn(goal({ check: "npm test" }), T0), T0 + 120_000);
		expect(text).toContain("all tests pass");
		expect(text).toContain("autonomy: full");
		expect(text).toMatch(/turns: 1\b/);
		expect(text).toContain("npm test");
	});
	it("shows why a goal paused", () => {
		const text = describe(pause(goal(), "blocked", "needs a decision", T0), T0);
		expect(text).toContain("blocked");
		expect(text).toContain("needs a decision");
	});
	it("reports achieved and unverified achievement", () => {
		expect(describe(achieve(goal(), true, "", T0), T0).startsWith("Goal achieved:")).toBe(true);
		expect(describe(achieve(goal(), false, "no adjudicator", T0), T0)).toContain("unverified");
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
