// Pure goal state. Each transition bumps `generation`. Async work captures it and checks it again
// after each await, so a pause during a model call invalidates the verdict that call returns.

export type GoalState = "active" | "paused" | "achieved" | "achieved-unverified" | "cleared";

export type PauseReason =
	| "user-input"
	// Kept so that goals saved by older versions still render their pause reason.
	| "deadline"
	| "turn-limit"
	| "tool-missing"
	| "rejected-claims"
	| "blocked"
	| "unverified"
	| "run-error"
	| "run-lost"
	| "interrupted"
	| "navigation"
	| "wake-source-lost";

export interface GoalLimits {
	/** 0 disables the stop. */
	maxRejected: number;
}

export interface GoalWait {
	token: string;
	reason: string;
	deadline?: number | undefined;
	generation: number;
}

export interface GoalRecord {
	id: string;
	generation: number;
	condition: string;
	check?: string | undefined;
	state: GoalState;
	pauseReason?: PauseReason | undefined;
	detail?: string | undefined;
	autonomy: "full";
	createdAt: number;
	updatedAt: number;
	startedAt: number;
	/** Set when the goal starts to run, which is later than createdAt. */
	evidenceFrom?: number | undefined;
	turns: number;
	rejected: number;
	limits: GoalLimits;
	/** Present only while the active goal yields to an external event. */
	waiting?: GoalWait | undefined;
}

export const MAX_CONDITION_CHARS = 4000;

export const DEFAULT_LIMITS: GoalLimits = {
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

export function createGoal(params: {
	condition: string;
	check?: string;
	limits?: Partial<GoalLimits>;
	now: number;
	id: string;
}): GoalRecord {
	return {
		id: params.id,
		generation: 1,
		condition: params.condition.trim(),
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

export function countRejection(record: GoalRecord, reason: string, now: number): GoalRecord {
	return { ...record, rejected: record.rejected + 1, detail: reason, updatedAt: now };
}

/** A new verifier invalidates any verdict in flight, so it is a real transition. */
export function setCheck(record: GoalRecord, check: string | undefined, now: number): GoalRecord {
	const updated = next(record, { check: check?.trim() || undefined }, now);
	return updated.waiting ? { ...updated, waiting: { ...updated.waiting, generation: updated.generation } } : updated;
}

export function beginWait(record: GoalRecord, wait: Omit<GoalWait, "generation">, now: number): GoalRecord {
	const updated = next(record, { waiting: undefined }, now);
	return { ...updated, waiting: { ...wait, generation: updated.generation } };
}

/** Only the token of the armed wait can consume it. */
export function consumeWait(record: GoalRecord, token: string, now: number): GoalRecord | undefined {
	if (record.state !== "active" || !record.waiting || record.waiting.token !== token) return undefined;
	return next(record, { waiting: undefined }, now);
}

export function pause(record: GoalRecord, reason: PauseReason, detail: string, now: number): GoalRecord {
	return next(record, { state: "paused", pauseReason: reason, detail, waiting: undefined }, now);
}

export function achieve(record: GoalRecord, verified: boolean, detail: string, now: number): GoalRecord {
	return next(
		record,
		{ state: verified ? "achieved" : "achieved-unverified", pauseReason: undefined, detail, waiting: undefined },
		now,
	);
}

export function clear(record: GoalRecord, now: number): GoalRecord {
	return next(record, { state: "cleared", pauseReason: undefined, waiting: undefined }, now);
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

export const WAKE_SOURCE_LOST_DETAIL = "The wait was armed in another process, so its wake source is lost.";

/**
 * A goal found active on load has no run behind it, so it pauses. A wait stays armed only when
 * this process armed it, because only then can its wake source still deliver.
 */
export function recover(
	record: GoalRecord | undefined,
	kind: "restart" | "navigation",
	now: number,
	options: { armedHere: boolean },
): GoalRecord | undefined {
	if (!record || record.state !== "active") return record;
	const wait = record.waiting;
	if (wait && !options.armedHere) return pause(record, "wake-source-lost", WAKE_SOURCE_LOST_DETAIL, now);
	if (wait && wait.generation === record.generation && wait.token && wait.reason) return record;
	return kind === "restart"
		? pause(record, "interrupted", "The session was reloaded or restarted while this goal was running.", now)
		: pause(record, "navigation", "You navigated to a different branch while this goal was running.", now);
}

interface BranchEntry {
	type?: string;
	customType?: string;
	data?: unknown;
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

/** Newest wins, and only within the given branch. */
export function latestFromEntries(entries: readonly unknown[], customType = "goal"): GoalRecord | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as BranchEntry | undefined;
		if (entry?.type !== "custom" || entry.customType !== customType) continue;
		if (looksLikeGoal(entry.data)) return entry.data;
	}
	return undefined;
}

export function describe(record: GoalRecord | undefined, now: number): string {
	if (!record || isTerminal(record)) {
		if (record?.state === "achieved") return `Goal achieved: ${record.condition}`;
		if (record?.state === "achieved-unverified")
			return `Goal achieved but unverified: ${record.condition}\n${record.detail ?? ""}`.trim();
		return "No goal set.";
	}
	const minutes = Math.round((now - record.startedAt) / 60_000);
	const limit = record.limits.maxRejected > 0 ? `/${record.limits.maxRejected}` : " (no limit)";
	const lines = [
		`Goal (${record.state}${record.waiting ? ", waiting" : ""}): ${record.condition}`,
		"autonomy: full",
		`turns: ${record.turns}   elapsed: ${minutes}m   rejected claims: ${record.rejected}${limit}`,
	];
	if (record.check) lines.push(`check: ${record.check}`);
	if (record.waiting) {
		const until = record.waiting.deadline ? ` (until ${new Date(record.waiting.deadline).toISOString()})` : "";
		lines.push(`waiting: ${record.waiting.reason}${until}`);
	}
	if (record.pauseReason) lines.push(`paused: ${record.pauseReason}${record.detail ? ` (${record.detail})` : ""}`);
	else if (record.detail) lines.push(`last verdict: ${record.detail}`);
	return lines.join("\n");
}
