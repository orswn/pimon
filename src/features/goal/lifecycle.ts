// Pure reducer for the run lifecycle of a goal. The adapter turns pi events into inputs and runs
// the effects. Commands and tools change the record through `state.ts` directly.
import { conditionReminderText, continuationText, rejectionHint } from "./policy.ts";
import {
	consumeWait,
	countTurn,
	type GoalRecord,
	isActive,
	type PauseReason,
	pause,
	recover,
	WAKE_SOURCE_LOST_DETAIL,
} from "./state.ts";

export const WAIT_TIMEOUT_MESSAGE = "goal-wait-timeout";
export const WAIT_RESUME_MESSAGE = "goal-wait-resume";
export const CONTINUE_MESSAGE = "goal-continue";
export const START_MESSAGE = "goal-start";
export const CONDITION_MESSAGE = "goal-condition";
const EXTERNAL_WAKE_TYPES = new Set(["background", "monitor", "pi-bus"]);
const TOKEN_WAKE_TYPES = new Set([WAIT_TIMEOUT_MESSAGE, WAIT_RESUME_MESSAGE]);

export type Wake =
	| { source: "user" }
	| { source: "external" }
	| { source: "timeout" | "resume"; token: string | undefined };

export interface Cycle {
	/** The last before-settle boundary of this run asked for a continuation. */
	continued: boolean;
	/** A goal tool or a blocked notify ended the tool batch of this turn. */
	terminal: boolean;
	/** The wait token that the last wake consumed. Its own wake message is not stale. */
	lastWakeToken?: string | undefined;
}

export interface Lifecycle {
	record: GoalRecord | undefined;
	cycle: Cycle;
}

export type LifecycleInput =
	| { type: "turn-start" }
	| { type: "wake"; wake: Wake }
	| { type: "terminal" }
	| { type: "before-settle"; outcome: "completed" | "aborted" | "error"; errorMessage?: string | undefined }
	/** `at` is later than every entry already on the branch. */
	| { type: "start-landed"; goal: string; at: number }
	| { type: "settled"; aborted: boolean }
	| { type: "compacted" }
	| { type: "blocked"; message: string; detail?: string | undefined }
	| { type: "turn-end"; stopReason?: string | undefined }
	| { type: "recover"; found: GoalRecord | undefined; kind: "restart" | "navigation"; armedHere: boolean };

export type Effect =
	/** Store the record and append it to the session. */
	| { type: "persist"; record: GoalRecord }
	/** Keep the record in memory only. */
	| { type: "remember"; record: GoalRecord }
	| { type: "continue"; text: string; details: GoalMessageDetails }
	| { type: "stopped"; reason: PauseReason; detail: string; phone: boolean }
	| { type: "condition"; text: string; details: GoalMessageDetails }
	| { type: "clear-timer" }
	| { type: "arm-timer"; token: string; deadline: number };

export interface GoalMessageDetails {
	goal: string;
	generation: number;
	waitToken?: string;
	wake?: "timeout" | "resume";
}

export interface Step {
	state: Lifecycle;
	effects: Effect[];
}

export function initialLifecycle(record?: GoalRecord): Lifecycle {
	return { record, cycle: { continued: false, terminal: false } };
}

export function classifyWake(message: { role?: string; customType?: string; details?: unknown }): Wake | undefined {
	if (message.role === "user") return { source: "user" };
	if (message.role !== "custom" || typeof message.customType !== "string") return undefined;
	if (EXTERNAL_WAKE_TYPES.has(message.customType)) return { source: "external" };
	if (!TOKEN_WAKE_TYPES.has(message.customType)) return undefined;
	const token = (message.details as { waitToken?: unknown } | undefined)?.waitToken;
	return {
		source: message.customType === WAIT_TIMEOUT_MESSAGE ? "timeout" : "resume",
		token: typeof token === "string" ? token : undefined,
	};
}

/** A goal wake message is stale when its token is neither the armed wait nor the wait it just consumed. */
export function isStaleWake(
	message: { role?: string; customType?: string; details?: unknown },
	state: Lifecycle,
): boolean {
	const wake = classifyWake(message);
	if (!wake || (wake.source !== "timeout" && wake.source !== "resume")) return false;
	if (wake.token === undefined) return true;
	if (wake.token === state.cycle.lastWakeToken) return false;
	return !(isActive(state.record) && state.record.waiting?.token === wake.token);
}

/** Wait tokens to add to or remove from the set of waits armed in this process. */
export function waitTokenChange(
	previous: GoalRecord | undefined,
	next: GoalRecord | undefined,
): { add?: string | undefined; remove?: string | undefined } {
	const before = isActive(previous) ? previous.waiting?.token : undefined;
	const after = isActive(next) ? next.waiting?.token : undefined;
	if (before === after) return {};
	return { add: after, remove: before };
}

export function goalDetails(record: GoalRecord): GoalMessageDetails {
	return { goal: record.id, generation: record.generation };
}

function stop(state: Lifecycle, reason: PauseReason, detail: string, phone: boolean, now: number): Step {
	if (!isActive(state.record)) return { state, effects: [] };
	const paused = pause(state.record, reason, detail, now);
	return {
		state: { ...state, record: paused },
		effects: [{ type: "persist", record: paused }, { type: "clear-timer" }, { type: "stopped", reason, detail, phone }],
	};
}

const unchanged = (state: Lifecycle): Step => ({ state, effects: [] });
const withCycle = (state: Lifecycle, patch: Partial<Cycle>): Lifecycle => ({
	...state,
	cycle: { ...state.cycle, ...patch },
});

export function step(state: Lifecycle, input: LifecycleInput, now: number): Step {
	const record = state.record;
	switch (input.type) {
		case "turn-start":
			return unchanged(withCycle(state, { terminal: false }));

		case "terminal":
			return unchanged(withCycle(state, { terminal: true }));

		case "wake": {
			if (!isActive(record) || !record.waiting) return unchanged(state);
			const token = record.waiting.token;
			if ((input.wake.source === "timeout" || input.wake.source === "resume") && input.wake.token !== token)
				return unchanged(state);
			const consumed = consumeWait(record, token, now);
			if (!consumed) return unchanged(state);
			return {
				state: { record: consumed, cycle: { ...state.cycle, lastWakeToken: token } },
				effects: [{ type: "persist", record: consumed }, { type: "clear-timer" }],
			};
		}

		case "before-settle": {
			// An abort can end with an empty error message. Only a real provider error is a run error;
			// anything else falls through to the settled checks.
			if (input.outcome === "error" && input.errorMessage) {
				const stopped = stop(state, "run-error", `the model call failed: ${input.errorMessage}`, true, now);
				return { ...stopped, state: withCycle(stopped.state, { continued: false }) };
			}
			if (input.outcome !== "completed" || !isActive(record) || record.waiting || state.cycle.terminal)
				return unchanged(withCycle(state, { continued: false }));
			const hint = record.detail && record.rejected > 0 ? rejectionHint(record.detail) : undefined;
			return {
				state: withCycle(state, { continued: true }),
				effects: [{ type: "continue", text: continuationText(record, hint), details: goalDetails(record) }],
			};
		}

		case "settled": {
			const cycle = state.cycle;
			const reset = withCycle(state, { continued: false, terminal: false });
			if (input.aborted) return stop(reset, "user-input", "the run was interrupted", true, now);
			if (!isActive(record) || record.waiting) return unchanged(reset);
			const detail = cycle.continued
				? "pi did not run the requested continuation, so the goal has no run"
				: "a run ended without a continuation, so the goal has no run";
			return stop(reset, "run-lost", detail, true, now);
		}

		case "start-landed": {
			if (!isActive(record) || record.id !== input.goal || record.evidenceFrom !== undefined) return unchanged(state);
			const stamped = { ...record, evidenceFrom: input.at, updatedAt: now };
			return { state: { ...state, record: stamped }, effects: [{ type: "persist", record: stamped }] };
		}

		case "compacted":
			if (!isActive(record)) return unchanged(state);
			return {
				state,
				effects: [
					{
						type: "condition",
						text: conditionReminderText(record),
						details: goalDetails(record),
					},
				],
			};

		case "blocked": {
			const stopped = stop(state, "blocked", input.message || "you reported a blocker", false, now);
			return { ...stopped, state: withCycle(stopped.state, { terminal: true }) };
		}

		case "turn-end": {
			if (!isActive(record) || input.stopReason === "error" || input.stopReason === "aborted") return unchanged(state);
			const counted = countTurn(record, now);
			return { state: { ...state, record: counted }, effects: [{ type: "remember", record: counted }] };
		}

		case "recover": {
			const recovered = recover(input.found, input.kind, now, { armedHere: input.armedHere });
			const fresh = initialLifecycle(recovered);
			const effects: Effect[] = [{ type: "clear-timer" }];
			if (recovered && recovered !== input.found) {
				effects.push({ type: "persist", record: recovered });
				const detail = recovered.detail ?? WAKE_SOURCE_LOST_DETAIL;
				if (recovered.pauseReason)
					effects.push({ type: "stopped", reason: recovered.pauseReason, detail, phone: false });
			} else if (recovered) {
				effects.push({ type: "remember", record: recovered });
			}
			if (isActive(recovered) && recovered.waiting?.deadline !== undefined)
				effects.push({ type: "arm-timer", token: recovered.waiting.token, deadline: recovered.waiting.deadline });
			return { state: fresh, effects };
		}
	}
}
