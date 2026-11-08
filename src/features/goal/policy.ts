// Goal-specific text for the model. General goal rules live in the `goal` prompt section.
import { type GoalRecord, objectiveOf } from "./state.ts";

const KEEP_WORKING = "Keep working toward the objective. Call goal_done when it holds now.";

const SHOWN_CHANGES = 3;

const DEFINE_OBJECTIVE_TEXT =
	'First call goal_set action="edit" with an objective that states this request as a self-contained end state. Take the details from this conversation. If the request is unclear, call notify kind="blocked" with your question.';

/** Byte-stable across turns and wakes. Limits are absolutes, never a remaining count. */
export function goalContextText(record: GoalRecord): string {
	const objective = objectiveOf(record);
	const lines = ["<active-goal>"];
	if (objective === undefined) lines.push("objective: not defined yet");
	else lines.push("objective:", objective);
	if (record.setBy && record.condition !== objective) lines.push("human request:", record.condition);
	const changes = record.changes?.slice(-SHOWN_CHANGES) ?? [];
	if (changes.length > 0) lines.push("human changes, oldest first:", ...changes.map((change) => `- ${change.request}`));
	if (record.check) lines.push(`check command (run by the harness when you call goal_done): ${record.check}`);
	const failedChecks =
		record.check && record.limits.maxRejected > 0 ? `, after ${record.limits.maxRejected} failed checks` : "";
	lines.push(
		`There is no turn or time limit. The goal stops when goal_done is accepted${failedChecks}, on a harness failure, or when you report a blocker.`,
		"</active-goal>",
	);
	return lines.join("\n");
}

export function startText(record: GoalRecord, headline: string): string {
	const text = `${headline}\n${goalContextText(record)}`;
	return objectiveOf(record) === undefined ? `${text}\n${DEFINE_OBJECTIVE_TEXT}` : text;
}

export function checkCommandChangedText(record: GoalRecord): string {
	return `The goal check command changed.\n${goalContextText(record)}`;
}

export function resumedText(record: GoalRecord): string {
	return `Goal resumed. ${KEEP_WORKING}\n${goalContextText(record)}`;
}

export function objectiveReplacedText(record: GoalRecord): string {
	return `Objective replaced. It is the goal from now on. The earlier objective no longer counts.\n${goalContextText(record)}`;
}

export function conditionReminderText(record: GoalRecord): string {
	return `The active goal continues after compaction.\n${goalContextText(record)}`;
}

/** Short, because it is persisted history and every later request reads it again. */
export function continuationText(record: GoalRecord, hint?: string): string {
	const lines = [`Goal continuation ${record.continuations ?? 0}.`];
	if (hint) lines.push(hint);
	lines.push(KEEP_WORKING);
	return lines.join("\n");
}

export function rejectionHint(reason: string): string {
	return `Your last goal_done claim was rejected: ${reason}`;
}

export const GOAL_DONE_TEXT =
	"Goal done. Write the final message for the human now: what is true, the proof, and anything left undone. Do not call more tools.";

export const checkPassedText = (check: string) => `Check passed: ${check} exited 0. ${GOAL_DONE_TEXT}`;

export const checkFailedText = (code: number, tail: string) =>
	`Check failed: exit ${code}${tail ? `:\n${tail}` : ""}\nKeep working: close that gap, then call goal_done again.`;

export function stalePauseText(): string {
	return "The goal was paused or replaced before this verdict arrived. Do not continue it. Stop and wait for the human.";
}

export const CHECK_CHANGED_TEXT =
	"The check command changed while this claim was checked. The verdict was discarded. Claim again.";
