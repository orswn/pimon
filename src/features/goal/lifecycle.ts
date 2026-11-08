// Pure reducer for the run lifecycle of a goal. The adapter turns pi events into inputs and runs
// the effects. Commands and tools change the record through `state.ts` directly.
import { conditionReminderText, continuationText, rejectionHint } from "./policy.ts";
import {
	countContinuation,
	countTurn,
	type GoalRecord,
	isActive,
	type PauseReason,
	pause,
	type RecoverKind,
	recover,
} from "./state.ts";

export const CONTINUE_MESSAGE = "goal-continue";
export const START_MESSAGE = "goal-start";
export const CONDITION_MESSAGE = "goal-condition";
const STALL_LIMIT = 3;
const STALLED_DETAIL = `The agent ended ${STALL_LIMIT} runs in a row without work and without a timer.`;

export interface Cycle {
	/** The last before-settle boundary of this run asked for a continuation. */
	continued: boolean;
	/** A goal tool or a blocked notify ended the tool batch of this turn. */
	terminal: boolean;
	/** A tool was called since the last before-settle boundary. */
	worked: boolean;
	/** Consecutive boundaries that needed a continuation after no tool call. */
	stalls: number;
	/** The last before-settle boundary let the run settle on an armed timer. That timer may fire before settled. */
	parked: boolean;
}

export interface Lifecycle {
	record: GoalRecord | undefined;
	cycle: Cycle;
	/** Id of the goal whose continuations wait for the next human message or goal timer, after an interrupted run. */
	waiting: string | undefined;
}

export type LifecycleInput =
	| { type: "turn-start" }
	| { type: "tool-call" }
	| { type: "terminal" }
	| {
			type: "before-settle";
			outcome: "completed" | "aborted" | "error";
			errorMessage?: string | undefined;
			timerArmed: boolean;
	  }
	| { type: "settled"; aborted: boolean; timerArmed: boolean }
	/** A human message or a goal timer landed. */
	| { type: "woken" }
	| { type: "compacted" }
	| { type: "blocked"; message: string; detail?: string | undefined }
	| { type: "turn-end"; stopReason?: string | undefined }
	| {
			type: "recover";
			found: GoalRecord | undefined;
			kind: RecoverKind;
			timerArmed: boolean;
			/** The found goal waited when this process reloaded. */
			waiting: boolean;
	  };

export type Effect =
	/** Store the record and append it to the session. */
	| { type: "persist"; record: GoalRecord }
	/** Keep the record in memory only. */
	| { type: "remember"; record: GoalRecord }
	| { type: "continue"; text: string; details: GoalMessageDetails }
	| { type: "stopped"; reason: PauseReason; detail: string; phone: boolean }
	| { type: "condition"; text: string; details: GoalMessageDetails }
	| { type: "waiting" };

interface GoalMessageDetails {
	goal: string;
	generation: number;
}

export interface Step {
	state: Lifecycle;
	effects: Effect[];
}

export function initialLifecycle(record?: GoalRecord, waiting?: string): Lifecycle {
	return { record, cycle: { continued: false, terminal: false, worked: false, stalls: 0, parked: false }, waiting };
}

export function isWaiting(state: Lifecycle): boolean {
	return isActive(state.record) && state.waiting === state.record.id;
}

export function goalDetails(record: GoalRecord): GoalMessageDetails {
	return { goal: record.id, generation: record.generation };
}

function stop(state: Lifecycle, reason: PauseReason, detail: string, phone: boolean, now: number): Step {
	if (!isActive(state.record)) return { state, effects: [] };
	const paused = pause(state.record, reason, detail, now);
	return {
		state: { ...state, record: paused, cycle: { ...state.cycle, stalls: 0 }, waiting: undefined },
		effects: [
			{ type: "persist", record: paused },
			{ type: "stopped", reason, detail, phone },
		],
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

		case "tool-call":
			return unchanged(withCycle(state, { worked: true, stalls: 0 }));

		case "terminal":
			return unchanged(withCycle(state, { terminal: true }));

		case "before-settle": {
			// An abort can end with an empty error message. Only a real provider error is a run error;
			// anything else falls through to the settled checks.
			if (input.outcome === "error" && input.errorMessage) {
				const stopped = stop(state, "run-error", `the model call failed: ${input.errorMessage}`, true, now);
				return { ...stopped, state: withCycle(stopped.state, { continued: false, worked: false, parked: false }) };
			}
			const segmentEnded = withCycle(state, { continued: false, worked: false, parked: false });
			if (input.outcome !== "completed" || !isActive(record) || state.cycle.terminal || isWaiting(state))
				return unchanged(segmentEnded);
			if (input.timerArmed) return unchanged(withCycle(segmentEnded, { parked: true }));
			const stalls = state.cycle.worked ? 0 : state.cycle.stalls + 1;
			if (stalls >= STALL_LIMIT) return stop(segmentEnded, "stalled", STALLED_DETAIL, true, now);
			const hint = record.detail && record.rejected > 0 ? rejectionHint(record.detail) : undefined;
			const counted = countContinuation(record, now);
			return {
				state: { ...withCycle(segmentEnded, { continued: true, stalls }), record: counted },
				effects: [{ type: "continue", text: continuationText(counted, hint), details: goalDetails(counted) }],
			};
		}

		case "settled": {
			const cycle = state.cycle;
			const reset = withCycle(state, { continued: false, terminal: false, worked: false, parked: false });
			if (!isActive(record)) return unchanged(reset);
			if (input.aborted) return { state: { ...reset, waiting: record.id }, effects: [{ type: "waiting" }] };
			if (cycle.parked || input.timerArmed || isWaiting(state)) return unchanged(reset);
			const detail = cycle.continued
				? "pi did not run the requested continuation, so the goal has no run"
				: "a run ended without a continuation, so the goal has no run";
			return stop(reset, "run-lost", detail, true, now);
		}

		case "woken":
			return unchanged({ ...state, waiting: undefined });

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
			const recovered = recover(input.found, input.kind, now);
			if (!recovered) return { state: initialLifecycle(), effects: [] };
			if (recovered !== input.found) {
				const effects: Effect[] = [{ type: "persist", record: recovered }];
				if (recovered.pauseReason)
					effects.push({
						type: "stopped",
						reason: recovered.pauseReason,
						detail: recovered.detail ?? "",
						phone: false,
					});
				return { state: initialLifecycle(recovered), effects };
			}
			const effects: Effect[] = [{ type: "remember", record: recovered }];
			// Only an armed timer of this session can wake the goal again. Without one, it waits for the human.
			const waits = isActive(recovered) && (!input.timerArmed || (input.kind === "reload" && input.waiting));
			if (waits && input.kind === "restart") effects.push({ type: "waiting" });
			return { state: initialLifecycle(recovered, waits ? recovered.id : undefined), effects };
		}
	}
}
