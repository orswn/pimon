import { describe as group, expect, it } from "vite-plus/test";
import {
	achieve,
	beginWait,
	clear,
	consumeWait,
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

	it("arms a wait that keeps the goal active, with its generation and deadline", () => {
		const waiting = beginWait(fresh, { token: "wait-1", reason: "background test", deadline: T0 + 10_000 }, T0 + 4000);
		expect(waiting.state).toBe("active");
		expect(waiting.waiting?.reason).toBe("background test");
		expect(waiting.waiting?.generation).toBe(waiting.generation);
		expect(waiting.waiting?.deadline).toBe(T0 + 10_000);
	});

	it("rebinds the wait generation on a check change and keeps the token", () => {
		const waiting = beginWait(fresh, { token: "wait-1", reason: "r" }, T0 + 4000);
		const rebound = setCheck(waiting, "true", T0 + 4500);
		expect(rebound.waiting?.generation).toBe(rebound.generation);
		expect(rebound.waiting?.token).toBe("wait-1");
	});

	it("consumes a wait only with its token and bumps the generation", () => {
		const waiting = setCheck(beginWait(fresh, { token: "wait-1", reason: "r" }, T0 + 4000), "true", T0 + 4500);
		expect(consumeWait(waiting, "old", T0 + 5000)).toBeUndefined();
		const consumed = consumeWait(waiting, "wait-1", T0 + 5000);
		expect(consumed?.state).toBe("active");
		expect(consumed?.waiting).toBeUndefined();
		expect(consumed?.generation).toBe(waiting.generation + 1);
	});

	it("does not consume the wait of a paused goal", () => {
		const waiting = beginWait(fresh, { token: "wait-1", reason: "r" }, T0);
		expect(consumeWait({ ...waiting, state: "paused" }, "wait-1", T0)).toBeUndefined();
	});

	it("removes the wait marker on pause, achieve, and clear", () => {
		const waiting = beginWait(fresh, { token: "wait-1", reason: "r" }, T0 + 4000);
		expect(pause(waiting, "user-input", "stop", T0 + 6000).waiting).toBeUndefined();
		expect(achieve(waiting, true, "done", T0 + 6000).waiting).toBeUndefined();
		expect(clear(waiting, T0 + 6000).waiting).toBeUndefined();
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
	const waiting = beginWait(
		active,
		{ token: "restart-wait", reason: "external result", deadline: T0 + 60_000 },
		T0 + 1,
	);
	it("pauses an active goal as interrupted on restart and as navigation on a branch switch", () => {
		expect(recover(active, "restart", T0, { armedHere: true })?.pauseReason).toBe("interrupted");
		expect(recover(active, "navigation", T0, { armedHere: true })?.pauseReason).toBe("navigation");
		expect(recover(active, "restart", T0, { armedHere: true })?.state).toBe("paused");
	});
	it("leaves paused and achieved goals and no goal alone", () => {
		const paused = pause(active, "deadline", "out of time", T0);
		expect(recover(paused, "restart", T0, { armedHere: false })).toBe(paused);
		expect(recover(achieve(active, true, "", T0), "restart", T0, { armedHere: false })?.state).toBe("achieved");
		expect(recover(undefined, "restart", T0, { armedHere: false })).toBeUndefined();
	});
	it("keeps a wait armed in this process across reload and branch reconstruction", () => {
		expect(recover(waiting, "restart", T0 + 2, { armedHere: true })).toBe(waiting);
		expect(recover(waiting, "navigation", T0 + 2, { armedHere: true })).toBe(waiting);
	});
	it("pauses a wait with a mismatched generation", () => {
		const stale = { ...waiting, waiting: { token: "restart-wait", reason: "x", generation: waiting.generation - 1 } };
		expect(recover(stale, "restart", T0 + 2, { armedHere: true })).toMatchObject({
			state: "paused",
			pauseReason: "interrupted",
		});
	});
	it("pauses a wait armed elsewhere as wake-source-lost and says why", () => {
		const lost = recover(waiting, "restart", T0 + 2, { armedHere: false });
		expect(lost?.state).toBe("paused");
		expect(lost?.pauseReason).toBe("wake-source-lost");
		expect(lost?.detail).toContain("wake source");
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
	it("identifies an external wait", () => {
		const text = describe(
			beginWait(goal(), { token: "status-wait", reason: "CI result", deadline: T0 + 60_000 }, T0),
			T0,
		);
		expect(text).toContain("Goal (active, waiting)");
		expect(text).toContain("CI result");
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
