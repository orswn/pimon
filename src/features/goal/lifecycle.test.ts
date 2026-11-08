import { describe, expect, it } from "vite-plus/test";
import {
	classifyWake,
	type Cycle,
	initialLifecycle,
	isStaleWake,
	type Lifecycle,
	type LifecycleInput,
	step,
	waitTokenChange,
} from "./lifecycle.ts";
import { beginWait, createGoal, type GoalRecord, pause } from "./state.ts";

const T0 = 1_700_000_000_000;
const active = createGoal({ condition: "ship it", now: T0, id: "g1" });
const waiting = beginWait(active, { token: "w1", reason: "CI", deadline: T0 + 5_000 }, T0);
const paused = pause(active, "user-input", "x", T0);
const at = (record: GoalRecord | undefined, cycle: Partial<Cycle> = {}): Lifecycle => ({
	record,
	cycle: { ...initialLifecycle().cycle, ...cycle },
});
const types = (input: LifecycleInput, state: Lifecycle) => step(state, input, T0 + 1).effects.map((e) => e.type);

describe("wake classification", () => {
	it.each([
		[{ role: "user" }, { source: "user" }],
		[{ role: "custom", customType: "background" }, { source: "external" }],
		[{ role: "custom", customType: "monitor" }, { source: "external" }],
		[{ role: "custom", customType: "pi-bus" }, { source: "external" }],
		[
			{ role: "custom", customType: "goal-wait-timeout", details: { waitToken: "w1" } },
			{ source: "timeout", token: "w1" },
		],
		[
			{ role: "custom", customType: "goal-wait-resume", details: { waitToken: "w1" } },
			{ source: "resume", token: "w1" },
		],
		[
			{ role: "custom", customType: "goal-wait-timeout" },
			{ source: "timeout", token: undefined },
		],
		[{ role: "custom", customType: "goal-continue" }, undefined],
		[{ role: "custom", customType: "goal-start" }, undefined],
		[{ role: "assistant" }, undefined],
		[{ role: "toolResult" }, undefined],
	])("%j is %j", (message, wake) => {
		expect(classifyWake(message)).toEqual(wake);
	});
});

describe("wake transitions", () => {
	it.each([
		["a user message", { source: "user" } as const],
		["an external message", { source: "external" } as const],
		["the timeout of the armed wait", { source: "timeout", token: "w1" } as const],
		["the resume of the armed wait", { source: "resume", token: "w1" } as const],
	])("%s consumes the wait, saves it, and clears the timer", (_name, wake) => {
		const result = step(at(waiting), { type: "wake", wake }, T0 + 1);
		expect(result.state.record?.waiting).toBeUndefined();
		expect(result.state.record?.state).toBe("active");
		expect(result.state.cycle.lastWakeToken).toBe("w1");
		expect(result.effects.map((e) => e.type)).toEqual(["persist", "clear-timer"]);
	});

	it.each([
		["a timeout of another wait", at(waiting), { source: "timeout", token: "old" } as const],
		["a timeout without a token", at(waiting), { source: "timeout", token: undefined } as const],
		["a user message while not waiting", at(active), { source: "user" } as const],
		["a wake for a paused goal", at(paused), { source: "external" } as const],
		["a wake with no goal", at(undefined), { source: "user" } as const],
	])("%s changes nothing", (_name, state, wake) => {
		const result = step(state, { type: "wake", wake }, T0 + 1);
		expect(result.state).toBe(state);
		expect(result.effects).toEqual([]);
	});
});

describe("stale wake messages", () => {
	const timeout = (token: string) => ({
		role: "custom",
		customType: "goal-wait-timeout",
		details: { waitToken: token },
	});
	it("the armed wait's own timeout is fresh", () => expect(isStaleWake(timeout("w1"), at(waiting))).toBe(false));
	it("a timeout that just consumed its wait is fresh", () => {
		const consumed = step(at(waiting), { type: "wake", wake: { source: "timeout", token: "w1" } }, T0).state;
		expect(isStaleWake(timeout("w1"), consumed)).toBe(false);
	});
	it("a timeout after a clear, a pause, or a newer wait is stale", () => {
		expect(isStaleWake(timeout("w1"), at(undefined))).toBe(true);
		expect(isStaleWake(timeout("w1"), at(paused))).toBe(true);
		expect(isStaleWake(timeout("old"), at(waiting))).toBe(true);
	});
	it("a resume wake without a token is stale", () => {
		expect(isStaleWake({ role: "custom", customType: "goal-wait-resume" }, at(waiting))).toBe(true);
	});
	it("other messages are never stale", () => {
		expect(isStaleWake({ role: "custom", customType: "pi-bus" }, at(undefined))).toBe(false);
		expect(isStaleWake({ role: "custom", customType: "goal-continue" }, at(undefined))).toBe(false);
		expect(isStaleWake({ role: "user" }, at(undefined))).toBe(false);
	});
});

describe("before-settle transitions", () => {
	it("continues an active goal after a completed run with a continuation draft", () => {
		const result = step(at(active), { type: "before-settle", outcome: "completed" }, T0 + 1);
		expect(result.state.cycle.continued).toBe(true);
		expect(result.effects).toEqual([
			{
				type: "continue",
				text: expect.stringContaining("Goal continuation 1.") as string,
				details: { goal: "g1", generation: 1 },
			},
		]);
	});
	it("adds the last rejection as a hint", () => {
		const rejected = { ...active, rejected: 1, detail: "no test output" };
		const [effect] = step(at(rejected), { type: "before-settle", outcome: "completed" }, T0).effects;
		expect(effect).toMatchObject({ type: "continue", text: expect.stringContaining("no test output") as string });
	});
	it.each([
		["a waiting goal", at(waiting)],
		["a paused goal", at(paused)],
		["no goal", at(undefined)],
		["a run with a terminal goal tool", at(active, { terminal: true })],
	])("does not continue %s", (_name, state) => {
		const result = step(state, { type: "before-settle", outcome: "completed" }, T0);
		expect(result.effects).toEqual([]);
		expect(result.state.cycle.continued).toBe(false);
	});
	it("does nothing for an aborted outcome", () => {
		expect(types({ type: "before-settle", outcome: "aborted" }, at(active))).toEqual([]);
	});
	it("pauses an active goal on a provider error and pings the phone", () => {
		const result = step(
			at(active),
			{ type: "before-settle", outcome: "error", errorMessage: "429 rate limited" },
			T0 + 1,
		);
		expect(result.state.record).toMatchObject({ state: "paused", pauseReason: "run-error" });
		expect(result.state.record?.detail).toContain("429 rate limited");
		expect(result.effects.map((e) => e.type)).toEqual(["persist", "clear-timer", "stopped"]);
		expect(result.effects[2]).toMatchObject({ reason: "run-error", phone: true });
	});
	it("ignores an error outcome without an active goal", () => {
		expect(types({ type: "before-settle", outcome: "error", errorMessage: "x" }, at(paused))).toEqual([]);
	});
	it("leaves an error without a message to the settled checks", () => {
		const result = step(at(active), { type: "before-settle", outcome: "error" }, T0 + 1);
		expect(result.effects).toEqual([]);
		expect(step(result.state, { type: "settled", aborted: false }, T0 + 2).state.record?.pauseReason).toBe("run-lost");
		expect(step(result.state, { type: "settled", aborted: true }, T0 + 2).state.record?.pauseReason).toBe("user-input");
	});
});

describe("settled transitions", () => {
	it("pauses on an aborted run with user-input", () => {
		const result = step(at(active), { type: "settled", aborted: true }, T0 + 1);
		expect(result.state.record?.pauseReason).toBe("user-input");
		expect(result.effects.at(-1)).toMatchObject({ type: "stopped", reason: "user-input", phone: true });
	});
	it("pauses an active, not waiting goal as run-lost", () => {
		const result = step(at(active), { type: "settled", aborted: false }, T0 + 1);
		expect(result.state.record?.pauseReason).toBe("run-lost");
		expect(result.effects.at(-1)).toMatchObject({ type: "stopped", reason: "run-lost", phone: true });
	});
	it("names a refused continuation in the run-lost detail", () => {
		const result = step(at(active, { continued: true }), { type: "settled", aborted: false }, T0 + 1);
		expect(result.state.record?.detail).toContain("did not run the requested continuation");
	});
	it.each([
		["a paused goal", at(paused)],
		["no goal", at(undefined)],
	])("leaves %s alone", (_name, state) => {
		expect(step(state, { type: "settled", aborted: false }, T0).effects).toEqual([]);
		expect(step(state, { type: "settled", aborted: true }, T0).state.record).toBe(state.record);
	});
	it("leaves a waiting goal waiting after a clean settle", () => {
		expect(step(at(waiting), { type: "settled", aborted: false }, T0).effects).toEqual([]);
	});
	it("pauses a waiting goal when the run that armed the wait is aborted", () => {
		const result = step(at(waiting), { type: "settled", aborted: true }, T0);
		expect(result.state.record).toMatchObject({ state: "paused", pauseReason: "user-input", waiting: undefined });
	});
	it("resets the run flags", () => {
		const result = step(at(waiting, { continued: true, terminal: true }), { type: "settled", aborted: false }, T0);
		expect(result.state.cycle).toMatchObject({ continued: false, terminal: false });
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
		const result = step(at(waiting), { type: "blocked", message: "needs a key" }, T0 + 1);
		expect(result.state.record).toMatchObject({ state: "paused", pauseReason: "blocked", detail: "needs a key" });
		expect(result.state.record?.waiting).toBeUndefined();
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
		armedHere: boolean,
		kind: "restart" | "navigation" = "restart",
	) => ({ type: "recover", found, kind, armedHere }) as const;

	it("keeps a wait armed in this process and re-arms its timer", () => {
		const result = step(at(undefined), recoverInput(waiting, true), T0);
		expect(result.state.record).toBe(waiting);
		expect(result.effects).toEqual([
			{ type: "clear-timer" },
			{ type: "remember", record: waiting },
			{ type: "arm-timer", token: "w1", deadline: T0 + 5_000 },
		]);
	});
	it("pauses a wait armed elsewhere with a terminal notice and no phone ping", () => {
		const result = step(at(undefined), recoverInput(waiting, false), T0);
		expect(result.state.record?.pauseReason).toBe("wake-source-lost");
		expect(result.effects.map((e) => e.type)).toEqual(["clear-timer", "persist", "stopped"]);
		expect(result.effects.at(-1)).toMatchObject({ phone: false });
	});
	it("pauses an active goal as interrupted or navigation", () => {
		expect(step(at(undefined), recoverInput(active, true), T0).state.record?.pauseReason).toBe("interrupted");
		expect(step(at(undefined), recoverInput(active, true, "navigation"), T0).state.record?.pauseReason).toBe(
			"navigation",
		);
	});
	it("loads a paused goal or no goal unchanged and resets the run flags", () => {
		const result = step(at(active, { continued: true, lastWakeToken: "x" }), recoverInput(paused, false), T0);
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

describe("wait token bookkeeping", () => {
	it("adds a new wait and removes a consumed, paused, or replaced one", () => {
		expect(waitTokenChange(active, waiting)).toEqual({ add: "w1", remove: undefined });
		expect(waitTokenChange(waiting, active)).toEqual({ add: undefined, remove: "w1" });
		expect(waitTokenChange(waiting, pause(waiting, "blocked", "x", T0))).toEqual({ add: undefined, remove: "w1" });
		expect(waitTokenChange(waiting, undefined)).toEqual({ add: undefined, remove: "w1" });
		expect(waitTokenChange(waiting, { ...waiting, generation: 9 })).toEqual({});
	});
});
