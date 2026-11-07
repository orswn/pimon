// A name and a log path stay reserved until the process is proven dead, because a live
// process that writes into a log a new job just claimed is silent corruption.
import type { JobIdentity, Liveness } from "./identity.ts";
import type { Lease } from "./leases.ts";
import type { LogSink } from "./logsink.ts";
import type { Matcher } from "./matcher.ts";
import { LIMITS, type JobOptions, type Kind, type MonitorOptions } from "./options.ts";

export interface JobState {
	options: JobOptions;
	sink: LogSink;
	matcher: Matcher | undefined;
	identity: JobIdentity | undefined;
	leaseFile: string | undefined;
	/** The session that started the job. Only that session is woken by it. */
	sessionId: string | undefined;
	startedAt: number;
	pid: number | undefined;
	tail: string[];
	totalLines: number;
	droppedLines: number;
	/** The newest matched lines of the pending batch, at most one digest worth. */
	pending: string[];
	/** Every matched line of the pending batch, including the ones `pending` no longer holds. */
	pendingTotal: number;
	suppressed: number;
	flushTimer: ReturnType<typeof setTimeout> | undefined;
	timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	pollTimer: ReturnType<typeof setInterval> | undefined;
	windowStartedAt: number;
	windowEvents: number;
	muted: boolean;
	mutedUntil: number;
	muteCycles: number;
	mutePermanent: boolean;
	muteReason: string | undefined;
	stopping: boolean;
	stopTask: Promise<StopOutcome> | undefined;
	unkillable: boolean;
	exitedAt: number | undefined;
	exitStatus: string | undefined;
	exited: Promise<void>;
	markExited: () => void;
	kill: (signal: NodeJS.Signals) => void;
	liveness: () => Liveness;
}

export interface StopOutcome {
	name: string;
	kind: Kind;
	result: "exited" | "killed" | "unkillable" | "already";
	text: string;
}

export interface OrphanRecord {
	file: string;
	lease: Lease;
	liveness: Liveness;
}

export interface Registry {
	active: Map<string, JobState>;
	completed: Map<string, JobState>;
	orphans: Map<string, OrphanRecord>;
	/** Lease files already reported, so each orphan is reported once per process. */
	reportedLeases: Set<string>;
	seq: number;
	agentDir: string;
	/** The session that is current in this process now. */
	sessionId: string | undefined;
	emit: (state: JobState, text: string) => void;
	notice: ((text: string) => void) | undefined;
	oldRegistryWarned: boolean;
}

export function createRegistry(agentDir: string): Registry {
	return {
		active: new Map(),
		completed: new Map(),
		orphans: new Map(),
		reportedLeases: new Set(),
		seq: 0,
		agentDir,
		sessionId: undefined,
		emit: () => {},
		notice: undefined,
		oldRegistryWarned: false,
	};
}

export type Delivery = "steer" | "notice";

export function routeDigest(jobSessionId: string | undefined, currentSessionId: string | undefined): Delivery {
	return jobSessionId === currentSessionId ? "steer" : "notice";
}

export function isOtherSession(reg: Registry, state: JobState): boolean {
	return routeDigest(state.sessionId, reg.sessionId) === "notice";
}

const OLD_REGISTRY_KEY = "__piBackgroundRegistry_v2";

export function oldRegistryWarning(holder: object): string | undefined {
	const old = (holder as Record<string, unknown>)[OLD_REGISTRY_KEY];
	if (typeof old !== "object" || old === null) return undefined;
	const active = (old as { active?: unknown }).active;
	if (!(active instanceof Map) || active.size === 0) return undefined;
	const names = [...active.keys()].map(String);
	return `${names.length} job(s) from the old background extension still run in this process: ${names.join(", ")}. pimon cannot manage them. Restart pi after they end.`;
}

export function nextId(reg: Registry): number {
	reg.seq += 1;
	return reg.seq;
}

/** Orphans hold reservations too: their process is alive and still writing. */
export function nameTaken(reg: Registry, name: string): string | undefined {
	const active = reg.active.get(name);
	if (active) return active.options.kind;
	if (reg.orphans.has(name)) return "orphaned";
	return undefined;
}

export function logFileTaken(reg: Registry, file: string): string | undefined {
	for (const state of reg.active.values()) {
		if (state.options.logFile === file) return state.options.name;
	}
	for (const orphan of reg.orphans.values()) {
		if (orphan.lease.logFile === file) return `${orphan.lease.name} (orphaned)`;
	}
	return undefined;
}

export function findJob(reg: Registry, name: string): JobState | undefined {
	return reg.active.get(name) ?? reg.completed.get(name);
}

export function activeJobs(reg: Registry, kind?: Kind): JobState[] {
	return [...reg.active.values()].filter((state) => !kind || state.options.kind === kind);
}

export function addJob(reg: Registry, state: JobState): void {
	reg.active.set(state.options.name, state);
	reg.completed.delete(state.options.name);
}

export function addOrphan(reg: Registry, record: OrphanRecord): void {
	reg.orphans.set(record.lease.name, record);
}

export function orphans(reg: Registry): OrphanRecord[] {
	return [...reg.orphans.values()];
}

export function dropOrphan(reg: Registry, name: string): void {
	reg.orphans.delete(name);
}

/** Idempotent, because `error` and `close` can both fire for one child. */
export function retireJob(reg: Registry, state: JobState, status: string): boolean {
	if (state.exitedAt !== undefined) return false;
	state.exitedAt = Date.now();
	state.exitStatus = status;
	state.unkillable = false;
	clearTimers(state);
	state.matcher?.dispose();
	state.sink.close();
	reg.active.delete(state.options.name);
	reg.completed.set(state.options.name, state);
	while (reg.completed.size > LIMITS.completedKept) {
		const oldest = reg.completed.keys().next();
		if (oldest.done) break;
		reg.completed.delete(oldest.value);
	}
	state.markExited();
	return true;
}

export function clearTimers(state: JobState): void {
	if (state.flushTimer) clearTimeout(state.flushTimer);
	if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
	if (state.pollTimer) clearInterval(state.pollTimer);
	state.flushTimer = undefined;
	state.timeoutTimer = undefined;
	state.pollTimer = undefined;
}

export function appendTail(state: JobState, line: string): void {
	state.totalLines += 1;
	state.tail.push(
		line.length > LIMITS.maxStoredLineChars ? `${line.slice(0, LIMITS.maxStoredLineChars)} …(truncated)` : line,
	);
	while (state.tail.length > LIMITS.memTailLines) {
		state.tail.shift();
		state.droppedLines += 1;
	}
}

export function isMonitor(state: JobState): state is JobState & { options: MonitorOptions } {
	return state.options.kind === "monitor" && state.options.mode !== undefined;
}

export function runtimeMs(state: JobState): number {
	return (state.exitedAt ?? Date.now()) - state.startedAt;
}

export function phaseOf(state: JobState): string {
	if (state.exitedAt !== undefined) return state.exitStatus ?? "ended";
	if (state.unkillable) return "unkillable, still holding its name and log";
	if (state.stopping) return "stopping";
	return "running";
}

/** Mode is always shown: a literal and a regex with the same text behave differently. */
export function describeOptions(options: JobOptions): string {
	if (options.kind === "background") {
		return `timeoutMs=${options.timeoutMs}; notifyExit=${options.notifyExit}`;
	}
	const mode = `${options.mode}${options.ignoreCase ? ", ignoreCase" : ""}`;
	return `match=${JSON.stringify(options.matchSource)} (${mode}); streams=${[...(options.streams ?? [])].join(",")}; once=${options.once}; debounceMs=${options.debounceMs}; maxPerMinute=${options.maxPerMinute}; timeoutMs=${options.timeoutMs}`;
}
