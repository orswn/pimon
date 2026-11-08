// Goal-specific text for the model. General goal rules live in the `goal` prompt section.
import type { GoalRecord } from "./state.ts";

/** Byte-stable across turns and wakes. Limits are absolutes, never a remaining count. */
export function goalContextText(record: GoalRecord): string {
	const lines = ["<active-goal>", "completion condition:", record.condition];
	if (record.check) lines.push(`verification command (run by the harness, not by you): ${record.check}`);
	lines.push(
		record.limits.maxRejected > 0
			? `There is no turn or time limit. The goal stops when goal_done is accepted, after ${record.limits.maxRejected} rejected claims, on a harness failure, or when you report a blocker.`
			: "There is no turn, time, or rejection limit. The goal stops when goal_done is accepted, on a harness failure, or when you report a blocker.",
		"</active-goal>",
	);
	return lines.join("\n");
}

export function startText(record: GoalRecord, headline: string): string {
	return `${headline}\n${goalContextText(record)}`;
}

export function conditionChangedText(record: GoalRecord): string {
	return `The goal condition changed. It replaces the earlier one.\n${goalContextText(record)}`;
}

export function conditionReminderText(record: GoalRecord): string {
	return `The active goal continues after compaction.\n${goalContextText(record)}`;
}

/** Short, because it is persisted history and every later request reads it again. */
export function continuationText(record: GoalRecord, hint?: string): string {
	const lines = [`Goal continuation ${record.turns + 1}.`];
	if (hint) lines.push(hint);
	lines.push(
		"Keep working toward the active goal. Call goal_done when the condition is provably met.",
		"To wait for external work, start it, then set a timer for when it should be done. A run that ends with no armed timer gets a continuation at once.",
	);
	return lines.join("\n");
}

export function rejectionHint(reason: string): string {
	return `Your last goal_done claim was rejected: ${reason}`;
}

export function stalePauseText(): string {
	return "The goal was paused or replaced before this verdict arrived. Do not continue it. Stop and wait for the user.";
}

export const CHECK_CHANGED_TEXT =
	"The check command changed while this claim was adjudicated. The verdict was discarded. Claim again.";
