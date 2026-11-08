import { describe, expect, it } from "vite-plus/test";
import { type Cycle, initialLifecycle, type Lifecycle, type LifecycleInput, step } from "./lifecycle.ts";
import { createGoal, type GoalRecord, pause } from "./state.ts";

const T0 = 1_700_000_000_000;
const active = createGoal({ condition: "ship it", now: T0, id: "g1" });
const paused = pause(active, "user-input", "x", T0);
const at = (record: GoalRecord | undefined, cycle: Partial<Cycle> = {}, waiting?: string): Lifecycle => ({
	record,
	cycle: { ...initialLifecycle().cycle, ...cycle },
	waiting,
});
const types = (input: LifecycleInput, state: Lifecycle) => step(state, input, T0 + 1).effects.map((e) => e.type);
const withWork = (state: Lifecycle): Lifecycle => ({ ...state, cycle: { ...state.cycle, worked: true } });
const settleInput = (timerArmed = false) => ({ type: "before-settle", outcome: "completed", timerArmed }) as const;

describe("before-settle transitions", () => {
	it("continues an active goal without a timer", () => {
		const result = step(at(active, { worked: true }), settleInput(), T0 + 1);
		expect(result.state.cycle.continued).toBe(true);
		expect(result.effects).toEqual([
			{
				type: "continue",
				text: expect.stringContaining("Goal continuation 1.") as string,
				details: { goal: "g1", generation: 1 },
			},
		]);
	});
	it("numbers continuations per goal, not per turn, and keeps the count in the record", () => {
		const first = step(at({ ...active, turns: 5 }, { worked: true }), settleInput(), T0 + 1);
		expect(first.state.record?.continuations).toBe(1);
		const second = step(withWork(first.state), settleInput(), T0 + 2);
		expect(second.effects[0]).toMatchObject({ text: expect.stringContaining("Goal continuation 2.") as string });
		expect(second.state.record?.continuations).toBe(2);
	});
	it("lets the run settle while a timer is armed, with no continuation and no record write", () => {
		const state = at(active, { worked: true });
		const result = step(state, settleInput(true), T0 + 1);
		expect(result.effects).toEqual([]);
		expect(result.state.record).toBe(active);
		expect(result.state.cycle.continued).toBe(false);
	});
	it("adds the last rejection as a hint", () => {
		const rejected = { ...active, rejected: 1, detail: "no test output" };
		const [effect] = step(at(rejected), settleInput(), T0).effects;
		expect(effect).toMatchObject({ type: "continue", text: expect.stringContaining("no test output") as string });
	});
	it.each([
		["a paused goal", at(paused)],
		["no goal", at(undefined)],
		["a run with a terminal goal tool", at(active, { terminal: true })],
	])("does not continue %s", (_name, state) => {
		const result = step(state, settleInput(), T0);
		expect(result.effects).toEqual([]);
		expect(result.state.cycle.continued).toBe(false);
	});
	it("does nothing for an aborted outcome", () => {
		expect(types({ type: "before-settle", outcome: "aborted", timerArmed: false }, at(active))).toEqual([]);
	});
	it("pauses an active goal on a provider error and pings the phone", () => {
		const result = step(
			at(active),
			{ type: "before-settle", outcome: "error", errorMessage: "429 rate limited", timerArmed: true },
			T0 + 1,
		);
		expect(result.state.record).toMatchObject({ state: "paused", pauseReason: "run-error" });
		expect(result.state.record?.detail).toContain("429 rate limited");
		expect(result.effects.map((e) => e.type)).toEqual(["persist", "stopped"]);
		expect(result.effects[1]).toMatchObject({ reason: "run-error", phone: true });
	});
	it("ignores an error outcome without an active goal", () => {
		expect(
			types({ type: "before-settle", outcome: "error", errorMessage: "x", timerArmed: false }, at(paused)),
		).toEqual([]);
	});
	it("leaves an error without a message to the settled checks", () => {
		const result = step(at(active), { type: "before-settle", outcome: "error", timerArmed: false }, T0 + 1);
		expect(result.effects).toEqual([]);
		const settled = (aborted: boolean) =>
			step(result.state, { type: "settled", aborted, timerArmed: false }, T0 + 2).state.record?.pauseReason;
		expect(settled(false)).toBe("run-lost");
		expect(step(result.state, { type: "settled", aborted: true, timerArmed: false }, T0 + 2).state.waiting).toBe("g1");
	});
});

describe("stall cap", () => {
	const settleIdle = (state: Lifecycle) => step(state, settleInput(), T0 + 1);

	it("pauses as stalled when 3 runs in a row end without a tool call and without a timer", () => {
		const first = settleIdle(at(active));
		expect(first.effects.map((e) => e.type)).toEqual(["continue"]);
		const second = settleIdle(first.state);
		expect(second.effects.map((e) => e.type)).toEqual(["continue"]);
		const third = settleIdle(second.state);
		expect(third.state.record).toMatchObject({
			state: "paused",
			pauseReason: "stalled",
			detail: "The agent ended 3 runs in a row without work and without a timer.",
		});
		expect(third.effects.map((e) => e.type)).toEqual(["persist", "stopped"]);
		expect(third.state.cycle).toMatchObject({ continued: false, stalls: 0 });
	});
	it("resets the count on any tool call", () => {
		const twice = settleIdle(settleIdle(at(active)).state).state;
		expect(twice.cycle.stalls).toBe(2);
		const worked = step(twice, { type: "tool-call" }, T0).state;
		expect(worked.cycle).toMatchObject({ stalls: 0, worked: true });
		const next = settleIdle(worked);
		expect(next.effects.map((e) => e.type)).toEqual(["continue"]);
		expect(next.state.cycle).toMatchObject({ stalls: 0, worked: false });
	});
	it("does not count a settle while a timer is armed", () => {
		const twice = settleIdle(settleIdle(at(active)).state).state;
		const held = step(twice, settleInput(true), T0).state;
		expect(held.cycle.stalls).toBe(2);
		expect(settleIdle(held).state.record?.pauseReason).toBe("stalled");
	});
});

describe("settled transitions", () => {
	const settled = (aborted: boolean, timerArmed = false) => ({ type: "settled", aborted, timerArmed }) as const;
	it("keeps the goal active and waiting after an aborted run, with no record write", () => {
		const result = step(at(active, { worked: true }), settled(true, true), T0 + 1);
		expect(result.state.record).toBe(active);
		expect(result.state.waiting).toBe("g1");
		expect(result.effects).toEqual([{ type: "waiting" }]);
	});
	it("a waiting goal gets no continuation, counts no stall, and is not lost at settle", () => {
		const waiting = at(active, { worked: false, stalls: 2 }, "g1");
		const boundary = step(waiting, settleInput(), T0);
		expect(boundary.effects).toEqual([]);
		expect(boundary.state.cycle).toMatchObject({ continued: false, stalls: 2 });
		const after = step(boundary.state, settled(false), T0 + 1);
		expect(after.effects).toEqual([]);
		expect(after.state.record).toBe(active);
		expect(after.state.waiting).toBe("g1");
	});
	it("a wake ends the wait, so the next run end continues", () => {
		const woken = step(at(active, {}, "g1"), { type: "woken" }, T0).state;
		expect(woken.waiting).toBeUndefined();
		expect(step(woken, settleInput(), T0).effects.map((e) => e.type)).toEqual(["continue"]);
	});
	it("a wait of an earlier goal does not hold a new goal", () => {
		const result = step(at(active, { worked: true }, "old-goal"), settleInput(), T0);
		expect(result.effects.map((e) => e.type)).toEqual(["continue"]);
	});
	it("pauses an active goal without a timer as run-lost", () => {
		const result = step(at(active), settled(false), T0 + 1);
		expect(result.state.record?.pauseReason).toBe("run-lost");
		expect(result.effects.at(-1)).toMatchObject({ type: "stopped", reason: "run-lost", phone: true });
	});
	it("leaves an active goal with an armed timer active after a clean settle", () => {
		const result = step(at(active), settled(false, true), T0);
		expect(result.effects).toEqual([]);
		expect(result.state.record).toBe(active);
	});
	it("names a refused continuation in the run-lost detail", () => {
		const result = step(at(active, { continued: true }), settled(false), T0 + 1);
		expect(result.state.record?.detail).toContain("did not run the requested continuation");
	});
	it.each([
		["a paused goal", at(paused)],
		["no goal", at(undefined)],
	])("leaves %s alone", (_name, state) => {
		expect(step(state, settled(false), T0).effects).toEqual([]);
		expect(step(state, settled(true), T0).state.record).toBe(state.record);
		expect(step(state, settled(true), T0).state.waiting).toBeUndefined();
	});
	it("resets the run flags and keeps the stall count", () => {
		const result = step(
			at(active, { continued: true, terminal: true, worked: true, stalls: 2 }),
			settled(false, true),
			T0,
		);
		expect(result.state.cycle).toEqual({ continued: false, terminal: false, worked: false, stalls: 2, parked: false });
	});
	it("keeps the goal active when the timer seen at before-settle fires before settled", () => {
		const parked = step(at(active, { worked: true }), settleInput(true), T0).state;
		expect(parked.cycle.parked).toBe(true);
		const result = step(parked, settled(false, false), T0 + 1);
		expect(result.effects).toEqual([]);
		expect(result.state.record).toBe(active);
		expect(result.state.cycle.parked).toBe(false);
	});
	it("does not park a run that continued", () => {
		const continued = step(at(active, { worked: true }), settleInput(false), T0).state;
		expect(continued.cycle.parked).toBe(false);
	});
});

describe("run, terminal, blocked, turn, and compaction transitions", () => {
	it("a turn start clears the terminal flag only", () => {
		const result = step(at(active, { continued: true, terminal: true }), { type: "turn-start" }, T0);
		expect(result.state.cycle).toMatchObject({ continued: true, terminal: false });
	});
	it("a terminal tool marks the run", () => {
		expect(step(at(active), { type: "terminal" }, T0).state.cycle.terminal).toBe(true);
	});
	it("a blocked notify pauses the goal without a phone ping and marks the run", () => {
		const result = step(at(active), { type: "blocked", message: "needs a key" }, T0 + 1);
		expect(result.state.record).toMatchObject({ state: "paused", pauseReason: "blocked", detail: "needs a key" });
		expect(result.state.cycle.terminal).toBe(true);
		expect(result.effects.at(-1)).toMatchObject({ type: "stopped", reason: "blocked", phone: false });
	});
	it("a blocked notify without an active goal changes nothing", () => {
		expect(types({ type: "blocked", message: "x" }, at(paused))).toEqual([]);
	});
	it("a finished turn counts in memory only", () => {
		const result = step(at(active), { type: "turn-end", stopReason: "stop" }, T0);
		expect(result.state.record?.turns).toBe(1);
		expect(result.effects.map((e) => e.type)).toEqual(["remember"]);
	});
	it.each(["error", "aborted"])("a %s turn does not count", (stopReason) => {
		expect(step(at(active), { type: "turn-end", stopReason }, T0).state.record?.turns).toBe(0);
	});
	it("compaction posts the condition again for an active goal only", () => {
		const [effect] = step(at(active), { type: "compacted" }, T0).effects;
		expect(effect).toMatchObject({ type: "condition", text: expect.stringContaining("ship it") as string });
		expect(types({ type: "compacted" }, at(paused))).toEqual([]);
	});
});

describe("recover transitions", () => {
	type Kind = "restart" | "reload" | "navigation" | "fork";
	const recoverInput = (found: GoalRecord | undefined, kind: Kind, timerArmed = false, waiting = false) =>
		({ type: "recover", found, kind, timerArmed, waiting }) as const;

	it("keeps an active goal active and not waiting while a timer of this session is armed", () => {
		for (const kind of ["restart", "reload"] as const) {
			const result = step(at(undefined), recoverInput(active, kind, true), T0);
			expect(result.state.record).toBe(active);
			expect(result.state.waiting).toBeUndefined();
			expect(result.effects).toEqual([{ type: "remember", record: active }]);
		}
	});
	it("makes an active goal without a timer wait on a restart, with one notice and no record write", () => {
		const result = step(at(undefined), recoverInput(active, "restart"), T0);
		expect(result.state.record).toBe(active);
		expect(result.state.waiting).toBe("g1");
		expect(result.effects).toEqual([{ type: "remember", record: active }, { type: "waiting" }]);
	});
	it("makes an active goal without a timer wait on a reload, with no notice", () => {
		const result = step(at(undefined), recoverInput(active, "reload"), T0);
		expect(result.state.waiting).toBe("g1");
		expect(result.effects).toEqual([{ type: "remember", record: active }]);
	});
	it("keeps a goal that waited before a reload waiting, also with a timer", () => {
		const result = step(at(undefined), recoverInput(active, "reload", true, true), T0);
		expect(result.state.record).toBe(active);
		expect(result.state.waiting).toBe("g1");
	});
	it("pauses an active goal on navigation and in a fork, without a phone ping", () => {
		const navigated = step(at(undefined), recoverInput(active, "navigation", true), T0);
		expect(navigated.state.record?.pauseReason).toBe("navigation");
		const forked = step(at(undefined), recoverInput(active, "fork", true), T0);
		expect(forked.state.record?.pauseReason).toBe("fork");
		expect(forked.state.waiting).toBeUndefined();
		expect(forked.effects.map((e) => e.type)).toEqual(["persist", "stopped"]);
		expect(forked.effects.at(-1)).toMatchObject({ phone: false });
	});
	it("loads a paused goal or no goal unchanged and resets the run flags", () => {
		const result = step(at(active, { continued: true, stalls: 2 }), recoverInput(paused, "restart"), T0);
		expect(result.state).toEqual(initialLifecycle(paused));
		expect(step(at(active), recoverInput(undefined, "restart"), T0).state.record).toBeUndefined();
	});
});

describe("waiting ends when the goal leaves active", () => {
	it("a stop clears the wait, so a later resume of the same goal is not waiting", () => {
		const result = step(at(active, {}, "g1"), { type: "blocked", message: "needs a key" }, T0);
		expect(result.state.record?.state).toBe("paused");
		expect(result.state.waiting).toBeUndefined();
	});
});
