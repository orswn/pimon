import { describe, expect, it } from "vite-plus/test";
import { type Cycle, initialLifecycle, type Lifecycle, type LifecycleInput, step } from "./lifecycle.ts";
import { createGoal, type GoalRecord, pause } from "./state.ts";

const T0 = 1_700_000_000_000;
const active = createGoal({ condition: "ship it", now: T0, id: "g1" });
const paused = pause(active, "user-input", "x", T0);
const at = (record: GoalRecord | undefined, cycle: Partial<Cycle> = {}): Lifecycle => ({
	record,
	cycle: { ...initialLifecycle().cycle, ...cycle },
});
const types = (input: LifecycleInput, state: Lifecycle) => step(state, input, T0 + 1).effects.map((e) => e.type);
const settleInput = (timerArmed = false) => ({ type: "before-settle", outcome: "completed", timerArmed }) as const;

describe("before-settle transitions", () => {
	it("continues an active goal without a timer and tells the model to set one", () => {
		const result = step(at(active, { worked: true }), settleInput(), T0 + 1);
		expect(result.state.cycle.continued).toBe(true);
		expect(result.effects).toEqual([
			{
				type: "continue",
				text: expect.stringContaining("Goal continuation 1.") as string,
				details: { goal: "g1", generation: 1 },
			},
		]);
		expect(result.effects[0]).toMatchObject({
			text: expect.stringContaining(
				"To wait for external work, arm it, then set a timer for when it should be done. A run ends only while a timer is armed.",
			) as string,
		});
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
		expect(settled(true)).toBe("user-input");
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
	it("pauses on an aborted run with user-input, also while a timer is armed", () => {
		const result = step(at(active), settled(true, true), T0 + 1);
		expect(result.state.record?.pauseReason).toBe("user-input");
		expect(result.effects.at(-1)).toMatchObject({ type: "stopped", reason: "user-input", phone: true });
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
	const recoverInput = (
		found: GoalRecord | undefined,
		timerArmed: boolean,
		kind: "restart" | "navigation" = "restart",
	) => ({ type: "recover", found, kind, timerArmed }) as const;

	it("keeps an active goal active when a timer of this session is armed in this process", () => {
		const result = step(at(undefined), recoverInput(active, true), T0);
		expect(result.state.record).toBe(active);
		expect(result.effects).toEqual([{ type: "remember", record: active }]);
	});
	it("pauses an active goal without a timer as wake-source-lost, with no phone ping", () => {
		const result = step(at(undefined), recoverInput(active, false), T0);
		expect(result.state.record).toMatchObject({
			pauseReason: "wake-source-lost",
			detail: "No timer is armed in this pi process.",
		});
		expect(result.effects.map((e) => e.type)).toEqual(["persist", "stopped"]);
		expect(result.effects.at(-1)).toMatchObject({ phone: false });
	});
	it("pauses an active goal on navigation even with a timer", () => {
		expect(step(at(undefined), recoverInput(active, true, "navigation"), T0).state.record?.pauseReason).toBe(
			"navigation",
		);
	});
	it("loads a paused goal or no goal unchanged and resets the run flags", () => {
		const result = step(at(active, { continued: true, stalls: 2 }), recoverInput(paused, false), T0);
		expect(result.state).toEqual(initialLifecycle(paused));
		expect(step(at(active), recoverInput(undefined, false), T0).state.record).toBeUndefined();
	});
});

describe("start message landing", () => {
	const fresh = { ...active, evidenceFrom: undefined };
	it("stamps the evidence boundary of the matching goal once", () => {
		const result = step(at(fresh), { type: "start-landed", goal: "g1", at: T0 + 9 }, T0 + 5);
		expect(result.state.record?.evidenceFrom).toBe(T0 + 9);
		expect(result.effects.map((e) => e.type)).toEqual(["persist"]);
		expect(step(result.state, { type: "start-landed", goal: "g1", at: T0 + 20 }, T0 + 20).effects).toEqual([]);
	});
	it("ignores the start message of another goal or a paused goal", () => {
		expect(types({ type: "start-landed", goal: "other", at: T0 }, at(fresh))).toEqual([]);
		expect(types({ type: "start-landed", goal: "g1", at: T0 }, at({ ...paused, evidenceFrom: undefined }))).toEqual([]);
	});
});
