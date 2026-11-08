import { clockTime } from "../background/timers.ts";

// Pure goal state. Each transition bumps `generation`. Async work captures it and checks it again
// after each await, so a pause during a model call invalidates the verdict that call returns.

export type GoalState = "active" | "paused" | "achieved" | "achieved-unverified" | "cleared";

export type PauseReason =
	| "user-input"
	// Kept so that goals saved by older versions still render their pause reason.
	| "deadline"
	| "turn-limit"
	| "tool-missing"
	| "interrupted"
	| "rejected-claims"
	| "blocked"
	| "unverified"
	| "run-error"
	| "run-lost"
	| "navigation"
	| "fork"
	// Kept so that goals saved by older versions still render their pause reason.
	| "wake-source-lost"
	| "stalled";

interface GoalLimits {
	/** 0 disables the stop. */
	maxRejected: number;
}

export interface ObjectiveChange {
	at: number;
	/** The human message that asked for the change. */
	request: string;
}

export interface GoalRecord {
	id: string;
	generation: number;
	/** The human's words. The objective of a goal saved without `setBy`. */
	condition: string;
	/** The end state the model wrote. Missing on a human goal means it is not defined yet. */
	objective?: string | undefined;
	/** Missing on goals saved before goals had an objective. */
	setBy?: "human" | "model" | undefined;
	/** Human-requested objective changes, oldest first. */
	changes?: ObjectiveChange[] | undefined;
	check?: string | undefined;
	state: GoalState;
	pauseReason?: PauseReason | undefined;
	detail?: string | undefined;
	autonomy: "full";
	createdAt: number;
	updatedAt: number;
	startedAt: number;
	turns: number;
	/** Continuations sent for this goal. Missing on goals saved before it was counted. */
	continuations?: number | undefined;
	rejected: number;
	limits: GoalLimits;
}

const MAX_CONDITION_CHARS = 4000;
const MAX_CHANGES = 10;
const MAX_CHANGE_CHARS = 1000;

const DEFAULT_LIMITS: GoalLimits = {
	// No turn or time cap. The rejected-claim stop fires only when the loop cannot converge.
	maxRejected: 5,
};

export function validateCondition(condition: string): string | undefined {
	const trimmed = condition.trim();
	if (!trimmed) return "A goal needs a condition. Say what must be true for it to be done.";
	if (trimmed.length > MAX_CONDITION_CHARS)
		return `A condition is at most ${MAX_CONDITION_CHARS} characters, this one is ${trimmed.length}. Put the detail in a file and point the goal at it.`;
	return undefined;
}

export function validateObjective(objective: string): string | undefined {
	const trimmed = objective.trim();
	if (!trimmed) return "Nothing changed: the objective is empty. Say what must be true for the goal to be done.";
	if (trimmed.length > MAX_CONDITION_CHARS)
		return `Nothing changed: an objective is at most ${MAX_CONDITION_CHARS} characters, this one is ${trimmed.length}. Put the detail in a file and point the goal at it.`;
	return undefined;
}

export const clipText = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

export function createGoal(params: {
	condition: string;
	objective?: string | undefined;
	setBy?: GoalRecord["setBy"];
	check?: string;
	limits?: Partial<GoalLimits>;
	now: number;
	id: string;
}): GoalRecord {
	return {
		id: params.id,
		generation: 1,
		condition: params.condition.trim(),
		...(params.objective === undefined ? {} : { objective: params.objective.trim() }),
		...(params.setBy === undefined ? {} : { setBy: params.setBy }),
		check: params.check?.trim() || undefined,
		state: "active",
		autonomy: "full",
		createdAt: params.now,
		updatedAt: params.now,
		startedAt: params.now,
		turns: 0,
		rejected: 0,
		limits: { ...DEFAULT_LIMITS, ...params.limits },
	};
}

/** Undefined while a goal set with /goal waits for the model to write its objective. */
export function objectiveOf(record: GoalRecord): string | undefined {
	return record.setBy === undefined ? record.condition : record.objective;
}

export function isActive(record: GoalRecord | undefined): record is GoalRecord {
	return record?.state === "active";
}

export function isTerminal(record: GoalRecord | undefined): boolean {
	return record?.state === "achieved" || record?.state === "achieved-unverified" || record?.state === "cleared";
}

function next(record: GoalRecord, patch: Partial<GoalRecord>, now: number): GoalRecord {
	return { ...record, ...patch, generation: record.generation + 1, updatedAt: now };
}

export function countTurn(record: GoalRecord, now: number): GoalRecord {
	return { ...record, turns: record.turns + 1, updatedAt: now };
}

export function countContinuation(record: GoalRecord, now: number): GoalRecord {
	return { ...record, continuations: (record.continuations ?? 0) + 1, updatedAt: now };
}

export function countRejection(record: GoalRecord, reason: string, now: number): GoalRecord {
	return { ...record, rejected: record.rejected + 1, detail: reason, updatedAt: now };
}

/** A new verifier invalidates any verdict in flight, so it is a real transition. */
export function setCheck(record: GoalRecord, check: string | undefined, now: number): GoalRecord {
	return next(record, { check: check?.trim() || undefined }, now);
}

export function pause(record: GoalRecord, reason: PauseReason, detail: string, now: number): GoalRecord {
	return next(record, { state: "paused", pauseReason: reason, detail }, now);
}

export function achieve(record: GoalRecord, detail: string, now: number): GoalRecord {
	return next(record, { state: "achieved", pauseReason: undefined, detail }, now);
}

/** `request` is the human message that asked for the change. A first definition has none. */
export function setObjective(
	record: GoalRecord,
	objective: string,
	request: string | undefined,
	now: number,
): GoalRecord {
	const patch: Partial<GoalRecord> = { objective: objective.trim(), setBy: record.setBy ?? "human" };
	if (request !== undefined)
		patch.changes = [...(record.changes ?? []), { at: now, request: clipText(request, MAX_CHANGE_CHARS) }].slice(
			-MAX_CHANGES,
		);
	return next(record, patch, now);
}

export function clear(record: GoalRecord, now: number): GoalRecord {
	return next(record, { state: "cleared", pauseReason: undefined }, now);
}

/** Resume restarts the budgets, so a resumed goal does not start exhausted. */
export function resume(record: GoalRecord, now: number): { record?: GoalRecord; error?: string } {
	if (record.state !== "paused") return { error: `Nothing to resume: the goal is ${record.state}.` };
	return {
		record: next(
			record,
			{ state: "active", pauseReason: undefined, detail: undefined, startedAt: now, turns: 0, rejected: 0 },
			now,
		),
	};
}

export function exceededBudget(record: GoalRecord): { reason: PauseReason; detail: string } | undefined {
	if (record.limits.maxRejected > 0 && record.rejected >= record.limits.maxRejected)
		return {
			reason: "rejected-claims",
			detail: `${record.rejected} claims rejected, the limit is ${record.limits.maxRejected}.`,
		};
	return undefined;
}

/** `restart`: a new process or a session switch. `reload`: /reload in the same process. */
export type RecoverKind = "restart" | "reload" | "navigation" | "fork";

/**
 * A goal found active on load stays active. Branch navigation and a fork are human actions on
 * another branch or session, so they pause it. Whether an active goal waits is the lifecycle's choice.
 */
export function recover(record: GoalRecord | undefined, kind: RecoverKind, now: number): GoalRecord | undefined {
	if (!record || record.state !== "active") return record;
	if (kind === "navigation")
		return pause(record, "navigation", "You navigated to a different branch while this goal was running.", now);
	if (kind === "fork")
		return pause(record, "fork", "This session is a fork; the goal belongs to the original session.", now);
	return record;
}

interface BranchEntry {
	type?: string;
	customType?: string;
	data?: unknown;
	timestamp?: string;
}

/**
 * A fork copies the goal entries of its source with their old times, under a new header. A goal
 * that was saved in this session file is never older than its header.
 * Known limit: a backward wall clock step after the header can make an own goal look copied. The
 * goal then pauses as a fork, and `/goal resume` saves a newer entry.
 */
export function copiedFromAnotherSession(
	entries: readonly unknown[],
	headerTime: string | undefined,
	customType = "goal",
): boolean {
	const header = headerTime ? Date.parse(headerTime) : Number.NaN;
	if (Number.isNaN(header)) return false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as BranchEntry | undefined;
		if (entry?.type !== "custom" || entry.customType !== customType || !looksLikeGoal(entry.data)) continue;
		const saved = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
		return !Number.isNaN(saved) && saved < header;
	}
	return false;
}

function looksLikeGoal(data: unknown): data is GoalRecord {
	if (!data || typeof data !== "object") return false;
	const value = data as Partial<GoalRecord>;
	return (
		typeof value.id === "string" &&
		typeof value.condition === "string" &&
		typeof value.state === "string" &&
		typeof value.generation === "number"
	);
}

/** Older versions saved a `waiting` field. It is ignored, and the next write drops it. */
function withoutWait(record: GoalRecord): GoalRecord {
	if (!("waiting" in record)) return record;
	const { waiting: _waiting, ...rest } = record as GoalRecord & { waiting?: unknown };
	return rest;
}

/** Newest wins, and only within the given branch. */
export function latestFromEntries(entries: readonly unknown[], customType = "goal"): GoalRecord | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as BranchEntry | undefined;
		if (entry?.type !== "custom" || entry.customType !== customType) continue;
		if (looksLikeGoal(entry.data)) return withoutWait(entry.data);
	}
	return undefined;
}

export function describe(record: GoalRecord | undefined, now: number): string {
	if (!record || isTerminal(record)) {
		if (record?.state === "achieved") return `Goal achieved: ${objectiveOf(record) ?? record.condition}`;
		if (record?.state === "achieved-unverified")
			return `Goal achieved but unverified: ${record.condition}\n${record.detail ?? ""}`.trim();
		return "No goal set.";
	}
	const minutes = Math.round((now - record.startedAt) / 60_000);
	const limit = record.limits.maxRejected > 0 ? `/${record.limits.maxRejected}` : " (no limit)";
	const lines = [
		record.setBy ? `Goal (${record.state}, set by the ${record.setBy})` : `Goal (${record.state})`,
		`objective: ${objectiveOf(record) ?? "not defined yet"}`,
	];
	if (record.setBy) lines.push(`request: ${record.condition}`);
	if (record.changes?.length)
		lines.push("changes:", ...record.changes.map((change) => `- ${clockTime(change.at)} ${change.request}`));
	lines.push(`turns: ${record.turns}   elapsed: ${minutes}m   rejected claims: ${record.rejected}${limit}`);
	if (record.check) lines.push(`check: ${record.check}`);
	if (record.pauseReason) lines.push(`paused: ${record.pauseReason}${record.detail ? ` (${record.detail})` : ""}`);
	else if (record.detail) lines.push(`last verdict: ${record.detail}`);
	return lines.join("\n");
}
