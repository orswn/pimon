// Pure reducer for the run lifecycle of a goal. The adapter turns pi events into inputs and runs
// the effects. Commands and tools change the record through `state.ts` directly.
import { conditionReminderText, continuationText, rejectionHint } from "./policy.ts";
import {
	countTurn,
	type GoalRecord,
	isActive,
	type PauseReason,
	pause,
	recover,
	WAKE_SOURCE_LOST_DETAIL,
} from "./state.ts";

export const CONTINUE_MESSAGE = "goal-continue";
export const START_MESSAGE = "goal-start";
export const CONDITION_MESSAGE = "goal-condition";
export const STALL_LIMIT = 3;
export const STALLED_DETAIL = `The agent ended ${STALL_LIMIT} runs in a row without work and without a timer.`;

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
	/** `at` is later than every entry already on the branch. */
	| { type: "start-landed"; goal: string; at: number }
	| { type: "settled"; aborted: boolean; timerArmed: boolean }
	| { type: "compacted" }
	| { type: "blocked"; message: string; detail?: string | undefined }
	| { type: "turn-end"; stopReason?: string | undefined }
	| { type: "recover"; found: GoalRecord | undefined; kind: "restart" | "navigation"; timerArmed: boolean };

export type Effect =
	/** Store the record and append it to the session. */
	| { type: "persist"; record: GoalRecord }
	/** Keep the record in memory only. */
	| { type: "remember"; record: GoalRecord }
	| { type: "continue"; text: string; details: GoalMessageDetails }
	| { type: "stopped"; reason: PauseReason; detail: string; phone: boolean }
	| { type: "condition"; text: string; details: GoalMessageDetails };

export interface GoalMessageDetails {
	goal: string;
	generation: number;
}

export interface Step {
	state: Lifecycle;
	effects: Effect[];
}

export function initialLifecycle(record?: GoalRecord): Lifecycle {
	return { record, cycle: { continued: false, terminal: false, worked: false, stalls: 0, parked: false } };
}

export function goalDetails(record: GoalRecord): GoalMessageDetails {
	return { goal: record.id, generation: record.generation };
}

function stop(state: Lifecycle, reason: PauseReason, detail: string, phone: boolean, now: number): Step {
	if (!isActive(state.record)) return { state, effects: [] };
	const paused = pause(state.record, reason, detail, now);
	return {
		state: { record: paused, cycle: { ...state.cycle, stalls: 0 } },
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
			if (input.outcome !== "completed" || !isActive(record) || state.cycle.terminal) return unchanged(segmentEnded);
			if (input.timerArmed) return unchanged(withCycle(segmentEnded, { parked: true }));
			const stalls = state.cycle.worked ? 0 : state.cycle.stalls + 1;
			if (stalls >= STALL_LIMIT) return stop(segmentEnded, "stalled", STALLED_DETAIL, true, now);
			const hint = record.detail && record.rejected > 0 ? rejectionHint(record.detail) : undefined;
			return {
				state: withCycle(segmentEnded, { continued: true, stalls }),
				effects: [{ type: "continue", text: continuationText(record, hint), details: goalDetails(record) }],
			};
		}

		case "settled": {
			const cycle = state.cycle;
			const reset = withCycle(state, { continued: false, terminal: false, worked: false, parked: false });
			if (input.aborted) return stop(reset, "user-input", "the run was interrupted", true, now);
			if (!isActive(record) || cycle.parked || input.timerArmed) return unchanged(reset);
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
			const recovered = recover(input.found, input.kind, now, { timerArmed: input.timerArmed });
			const fresh = initialLifecycle(recovered);
			const effects: Effect[] = [];
			if (recovered && recovered !== input.found) {
				effects.push({ type: "persist", record: recovered });
				const detail = recovered.detail ?? WAKE_SOURCE_LOST_DETAIL;
				if (recovered.pauseReason)
					effects.push({ type: "stopped", reason: recovered.pauseReason, detail, phone: false });
			} else if (recovered) {
				effects.push({ type: "remember", record: recovered });
			}
			return { state: fresh, effects };
		}
	}
}
