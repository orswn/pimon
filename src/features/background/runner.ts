// A background job reports only on exit. A monitor that floods is muted, not killed. Nothing
// is declared finished on the strength of a pid, so a name and a log path stay reserved until
// identity says the process is gone.
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import {
	exitDigest,
	formatDuration,
	formatSeconds,
	MATCH_BUDGET,
	matchDigest,
	matchLabel,
	renderBlock,
} from "./digest.ts";
import { captureIdentity, captureOwner, type JobIdentity, type Liveness, verifyGroup } from "./identity.ts";
import { deleteLease, type Lease, leaseDir, writeLease } from "./leases.ts";
import { LineSplitter } from "./lines.ts";
import { LogSink } from "./logsink.ts";
import { createMatcher, type Matcher } from "./matcher.ts";
import { type JobOptions, LIMITS, type MonitorEdit, type StreamName } from "./options.ts";
import {
	activeJobs,
	addJob,
	appendTail,
	clearTimers,
	isMonitor,
	type JobState,
	type Registry,
	retireJob,
	runtimeMs,
	type StopOutcome,
} from "./registry.ts";

type StartResult = { ok: true; state: JobState } | { ok: false; error: string };

export function startJob(reg: Registry, options: JobOptions, sessionId?: string): StartResult {
	const sink = new LogSink(options.logFile, options.logMaxBytes);
	sink.open(header(options));

	let proc: ChildProcess;
	try {
		proc = spawn(options.command, [], {
			cwd: options.cwd,
			env: childEnv(),
			shell: true,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		sink.close();
		return { ok: false, error: `Failed to start ${options.kind} job: ${message(error)}` };
	}

	const pid = proc.pid;
	const identity = captureIdentity(pid);
	let markExited = () => {};
	const exited = new Promise<void>((resolve) => {
		markExited = resolve;
	});
	const now = Date.now();
	const state: JobState = {
		options,
		sink,
		matcher: undefined,
		identity,
		leaseFile: undefined,
		sessionId,
		startedAt: now,
		pid,
		tail: [],
		totalLines: 0,
		droppedLines: 0,
		pending: [],
		pendingTotal: 0,
		suppressed: 0,
		flushTimer: undefined,
		timeoutTimer: undefined,
		pollTimer: undefined,
		windowStartedAt: now,
		windowEvents: 0,
		muted: false,
		mutedUntil: 0,
		muteCycles: 0,
		mutePermanent: false,
		muteReason: undefined,
		stopping: false,
		stopTask: undefined,
		stopAwaited: false,
		unkillable: false,
		exitedAt: undefined,
		exitStatus: undefined,
		stopStatus: undefined,
		exited,
		markExited,
		kill: (signal) => signalGroup(pid, proc, signal),
		liveness: () => livenessOf(identity, pid),
	};

	if (identity) {
		const owner = captureOwner();
		const lease: Lease = {
			version: 1,
			name: options.name,
			kind: options.kind,
			command: options.command,
			cwd: options.cwd,
			logFile: options.logFile,
			createdAt: state.startedAt,
			identity,
			...(owner ? { owner } : {}),
		};
		const dir = leaseDir(reg.agentDir);
		state.leaseFile = writeLease(lease, dir);
		if (!state.leaseFile) {
			// Fail closed: a detached job with no durable record is the orphan leases exist to prevent.
			signalGroup(pid, proc, "SIGTERM");
			setTimeout(() => signalGroup(pid, proc, "SIGKILL"), LIMITS.killGraceMs).unref();
			sink.write("\n# pi: killed at startup, crash-recovery lease could not be written\n");
			sink.close();
			return {
				ok: false,
				error: `Could not write a crash-recovery lease in ${dir}, so ${options.kind} "${options.name}" was killed instead of left untracked. Fix that directory, or set PI_BACKGROUND_DIR to a writable one.`,
			};
		}
	}

	addJob(reg, state);
	if (isMonitor(state)) attachMatcher(reg, state);
	attach(reg, state, "stdout", proc.stdout);
	attach(reg, state, "stderr", proc.stderr);

	proc.on("error", (error) => finish(reg, state, `spawn failed: ${message(error)}`));
	proc.on("close", (code, signal) => {
		flush(reg, state);
		finish(reg, state, signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`);
	});

	// A job never delays pi quitting. Quit stops every active job itself.
	proc.unref();
	unrefStream(proc.stdout);
	unrefStream(proc.stderr);

	armTimeout(reg, state);
	return { ok: true, state };
}

function unrefStream(stream: NodeJS.ReadableStream | null): void {
	(stream as { unref?: () => void } | null)?.unref?.();
}

function header(options: JobOptions): string {
	return [
		`# pi ${options.kind} "${options.name}"`,
		`# command: ${options.command}`,
		`# cwd: ${options.cwd}`,
		`# started: ${new Date().toISOString()}`,
		"# stdout and stderr are merged, raw, unmodified",
	].join("\n");
}

function childEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	// A pi started inside a job must not inherit this session's bus identity.
	for (const key of Object.keys(env)) {
		if (key.startsWith("PI_BUS_")) delete env[key];
	}
	return env;
}

function livenessOf(identity: JobIdentity | undefined, pid: number | undefined): Liveness {
	if (identity) return verifyGroup(identity);
	if (pid === undefined) return "gone";
	try {
		process.kill(-pid, 0);
		return "ambiguous";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM" ? "ambiguous" : "gone";
	}
}

export function attachMatcher(reg: Registry, state: JobState): void {
	if (!isMonitor(state)) return;
	const options = state.options;
	// A replaced matcher can still report a late failure. Only the current one may act.
	const matcher: Matcher = createMatcher(options.mode, options.matchSource, options.ignoreCase, {
		onMatch: (line) => {
			if (state.matcher === matcher) onMatch(reg, state, line);
		},
		onFailure: (reason) => {
			if (state.matcher === matcher) muteForever(reg, state, reason);
		},
	});
	state.matcher = matcher;
}

function attach(reg: Registry, state: JobState, stream: StreamName, readable: NodeJS.ReadableStream | null): void {
	if (!readable) return;
	const splitter = new LineSplitter(LIMITS.splitterMaxLineChars, (line) => {
		try {
			handleLine(reg, state, stream, line);
		} catch (error) {
			state.sink.write(`\n# pi: line handling failed: ${message(error)}\n`);
		}
	});
	readable.setEncoding("utf8");
	readable.on("data", (chunk: string | Buffer) => {
		const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
		state.sink.write(text);
		splitter.push(text);
	});
	readable.on("end", () => splitter.end());
	readable.on("error", () => splitter.end());
}

export function handleLine(reg: Registry, state: JobState, stream: StreamName, line: string): void {
	appendTail(state, stream === "stderr" ? `[err] ${line}` : line);
	if (!isMonitor(state) || !state.matcher) return;
	if (!state.options.streams.has(stream)) return;

	// Cooldown is evaluated before the mute gate, or the window could never roll.
	if (state.muted && !state.mutePermanent && Date.now() >= state.mutedUntil) unmute(reg, state);
	if (state.muted) {
		state.suppressed += 1;
		return;
	}
	state.matcher.push(line);
}

function onMatch(reg: Registry, state: JobState, line: string): void {
	if (!isMonitor(state)) return;
	if (state.muted) {
		state.suppressed += 1;
		return;
	}
	state.pending.push(line);
	if (state.pending.length > MATCH_BUDGET.maxLines) state.pending.shift();
	state.pendingTotal += 1;
	state.flushTimer ??= setTimeout(() => flush(reg, state), state.options.debounceMs);
}

export function flush(reg: Registry, state: JobState): void {
	if (state.flushTimer) clearTimeout(state.flushTimer);
	state.flushTimer = undefined;
	if (state.pendingTotal === 0 || !isMonitor(state)) return;

	const options = state.options;
	const batch = state.pending;
	const total = state.pendingTotal;
	state.pending = [];
	state.pendingTotal = 0;

	const now = Date.now();
	if (now - state.windowStartedAt >= 60_000) {
		state.windowStartedAt = now;
		state.windowEvents = 0;
	}
	state.windowEvents += 1;
	if (state.windowEvents > options.maxPerMinute) {
		mute(reg, state, `exceeded ${options.maxPerMinute} notifications/minute`, batch, total);
		return;
	}

	emit(
		reg,
		state,
		matchDigest({
			name: options.name,
			command: options.generatedName ? options.command : undefined,
			matchSource: matchLabel(options),
			lines: batch,
			totalMatched: total,
			logFile: state.sink.path,
		}),
	);
	if (options.once) void stopJob(reg, state, "matched once", { reportUnkillable: true, normal: true });
}

// The batch that tripped the limit goes into the notice, so no matched line vanishes unreported.
function mute(reg: Registry, state: JobState, reason: string, batch: readonly string[], total: number): void {
	if (!isMonitor(state)) return;
	const options = state.options;
	state.muted = true;
	state.muteReason = reason;
	state.muteCycles += 1;
	const matched = [`It matched ${total} more line(s):`, ...renderBlock(batch, MATCH_BUDGET, total)];

	if (state.muteCycles >= LIMITS.muteCycleMax) {
		state.mutePermanent = true;
		emit(
			reg,
			state,
			[
				`Monitor "${options.name}" ${reason} for the ${state.muteCycles}th time and is now muted permanently.`,
				`Pattern: ${matchLabel(options)}`,
				...matched,
				"The process is still running and still logging. Nothing was killed.",
				`Narrow it with monitor action=edit name=${options.name} match=..., or read ${state.sink.path}.`,
			].join("\n"),
		);
		return;
	}

	const cooldown = options.muteCooldownMs;
	state.mutedUntil = Date.now() + cooldown;
	emit(
		reg,
		state,
		[
			`Monitor "${options.name}" ${reason} and is muted for ${formatDuration(cooldown)}.`,
			`Pattern: ${matchLabel(options)}`,
			...matched,
			"The process is still running and still logging. Nothing was killed.",
			`It resumes on its own. ${LIMITS.muteCycleMax - state.muteCycles} more flood(s) make the mute permanent.`,
		].join("\n"),
	);
}

function muteForever(reg: Registry, state: JobState, reason: string): void {
	if (!isMonitor(state)) return;
	const options = state.options;
	state.muted = true;
	state.mutePermanent = true;
	state.muteReason = reason;
	state.pending = [];
	state.pendingTotal = 0;
	emit(
		reg,
		state,
		[
			`Monitor "${options.name}" stopped matching: ${reason}.`,
			`Pattern: ${matchLabel(options)}`,
			"The process is still running and still logging. Only matching is disabled.",
			`Fix the pattern with monitor action=edit name=${options.name}, or read ${state.sink.path}.`,
		].join("\n"),
	);
}

function unmute(reg: Registry, state: JobState): void {
	const suppressed = state.suppressed;
	state.muted = false;
	state.mutedUntil = 0;
	state.windowEvents = 0;
	state.windowStartedAt = Date.now();
	state.suppressed = 0;
	if (suppressed === 0) return;
	emit(
		reg,
		state,
		[
			`Monitor "${state.options.name}" resumed after its cooldown.`,
			`${suppressed} line(s) went unmatched while it was muted; they are all in ${state.sink.path}.`,
		].join("\n"),
	);
}

function clearMute(state: JobState): boolean {
	const was = state.muted;
	state.muted = false;
	state.mutePermanent = false;
	state.mutedUntil = 0;
	state.muteReason = undefined;
	state.muteCycles = 0;
	state.suppressed = 0;
	state.windowEvents = 0;
	state.windowStartedAt = Date.now();
	return was;
}

/** Applies a validated edit to a running monitor. Returns whether the edit unmuted it. */
export function editMonitor(reg: Registry, state: JobState, updates: MonitorEdit): boolean {
	const rebuild = updates.matchSource !== undefined || updates.mode !== undefined || updates.ignoreCase !== undefined;
	Object.assign(state.options, updates);
	if (rebuild) {
		state.matcher?.dispose();
		state.matcher = undefined;
		if (state.flushTimer) clearTimeout(state.flushTimer);
		state.flushTimer = undefined;
		state.pending = [];
		state.pendingTotal = 0;
		attachMatcher(reg, state);
	}
	if (updates.timeoutMs !== undefined) armTimeout(reg, state);
	return clearMute(state);
}

function finish(reg: Registry, state: JobState, status: string): void {
	const stats = state.matcher?.stats();
	if (!retireJob(reg, state, state.stopStatus ?? status)) return;
	deleteLease(state.leaseFile);
	state.leaseFile = undefined;
	if (state.stopping || !state.options.notifyExit) return;
	const notes = [
		state.sink.note(),
		stats && stats.dropped > 0 ? `${stats.dropped} line(s) were dropped by the match queue under load.` : undefined,
	]
		.filter(Boolean)
		.join(" ");
	const digest = exitDigest({
		kind: state.options.kind,
		name: state.options.name,
		// An inline digest is the result of the call that holds the command.
		command: state.options.generatedName && !state.takeDigest ? state.options.command : undefined,
		status,
		runtimeMs: runtimeMs(state),
		tail: state.tail,
		totalLines: state.totalLines,
		logFile: state.sink.path,
		logNote: notes || undefined,
	});
	if (state.takeDigest) state.takeDigest(digest);
	else emit(reg, state, digest);
}

/** Resolves with the exit digest when the job ends within `timeoutMs`. Otherwise the digest wakes as usual. */
export function awaitExitDigest(state: JobState, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
	if (state.exitedAt !== undefined || signal?.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const done = (digest: string | undefined) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			state.takeDigest = undefined;
			resolve(digest);
		};
		const onAbort = () => done(undefined);
		const timer = setTimeout(() => done(undefined), timeoutMs);
		timer.unref();
		signal?.addEventListener("abort", onAbort, { once: true });
		state.takeDigest = done;
		// A silent or stopped job ends without a digest.
		void state.exited.then(() => done(undefined));
	});
}

function armTimeout(reg: Registry, state: JobState): void {
	if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
	state.timeoutTimer = undefined;
	if (state.options.timeoutMs <= 0) return;
	state.timeoutTimer = setTimeout(() => {
		emit(
			reg,
			state,
			[
				`${label(state)} hit its ${formatDuration(state.options.timeoutMs)} timeout and is being killed.`,
				...(state.options.generatedName ? [`Command: ${state.options.command}`] : []),
				`Partial output is in ${state.sink.path}.`,
			].join("\n"),
		);
		void stopJob(reg, state, "timeout", { reportUnkillable: true });
	}, state.options.timeoutMs);
	state.timeoutTimer.unref();
}

interface StopOptions {
	/** Teardown writes a distinguishable marker so a killed job is not a mystery. */
	marker?: string;
	afterKillMs?: number;
	/** At quit nobody is left to wake, so a survivor is not polled. */
	watch?: boolean;
	/** A stop the agent did not ask for has no tool result, so a survivor is reported by a wake. */
	reportUnkillable?: boolean;
	/** The job did its work. Its status is `stopped (<reason>)`, not the signal or abort. */
	normal?: boolean;
}

export function describeStop(result: StopOutcome, logFile: string): string {
	return [`${result.kind} "${result.name}": ${result.text}`, `Log kept at ${logFile}`].join("\n");
}

/** Concurrent calls share one stop, so a job is never retired twice. */
export function stopJob(
	reg: Registry,
	state: JobState,
	reason: string,
	options: StopOptions = {},
): Promise<StopOutcome> {
	if (state.stopTask) {
		// A joining caller that reads the outcome makes the unkillable wake a duplicate.
		if (!options.reportUnkillable) state.stopAwaited = true;
		return state.stopTask;
	}
	if (state.exitedAt !== undefined) {
		return Promise.resolve(outcome(state, "already", `already ended: ${state.exitStatus ?? "ended"}`));
	}
	state.stopTask = runStop(reg, state, reason, options);
	return state.stopTask;
}

async function runStop(reg: Registry, state: JobState, reason: string, options: StopOptions): Promise<StopOutcome> {
	const startedAt = Date.now();
	state.stopping = true;
	if (options.normal) state.stopStatus = `stopped (${reason})`;
	if (state.flushTimer) clearTimeout(state.flushTimer);
	if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
	state.flushTimer = undefined;
	state.timeoutTimer = undefined;
	state.sink.write(`\n# pi: ${options.marker ?? "stopping"} (${reason})\n`);

	if (state.script) {
		state.kill("SIGTERM");
		const ended = await exitWithin(state, LIMITS.killGraceMs);
		return outcome(
			state,
			ended ? "exited" : "unkillable",
			ended
				? `aborted in ${formatSeconds(Date.now() - startedAt)}`
				: `abort requested; the script did not end within ${formatSeconds(LIMITS.killGraceMs)}`,
		);
	}

	state.kill("SIGTERM");
	if (await exitWithin(state, LIMITS.killGraceMs)) {
		return outcome(state, "exited", `exited after SIGTERM in ${formatSeconds(Date.now() - startedAt)}`);
	}
	state.kill("SIGKILL");
	const killed = () => outcome(state, "killed", `killed with SIGKILL after ${formatSeconds(Date.now() - startedAt)}`);
	if (await exitWithin(state, options.afterKillMs ?? LIMITS.stopAfterKillMs)) return killed();
	// The group can be gone while an escaped grandchild still holds the pipes open.
	if (state.liveness() === "gone") {
		retireGone(reg, state, `killed (${reason}), identity gone`);
		return killed();
	}
	if (options.watch !== false) watchUnkillable(reg, state, reason);
	const survived = outcome(
		state,
		"unkillable",
		`still alive after SIGKILL (pid ${state.pid ?? "unknown"}, pgid ${state.identity?.pgid ?? state.pid ?? "unknown"}). It is polled every ${formatDuration(LIMITS.unkillablePollMs)} and you will be woken when it dies.`,
	);
	// runStop runs once per job, so this wakes at most once.
	if (options.reportUnkillable && !state.stopAwaited) emit(reg, state, describeStop(survived, state.sink.path));
	return survived;
}

function outcome(state: JobState, result: StopOutcome["result"], text: string): StopOutcome {
	return { name: state.options.name, kind: state.options.kind, result, text };
}

async function exitWithin(state: JobState, ms: number): Promise<boolean> {
	if (state.exitedAt !== undefined) return true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
	});
	const done = await Promise.race([state.exited.then(() => true as const), timeout]);
	if (timer) clearTimeout(timer);
	return done;
}

/** Stops every active job, and returns once each is dead or proven unkillable. */
export async function shutdownJobs(reg: Registry): Promise<void> {
	await Promise.all(
		activeJobs(reg).map((state) =>
			stopJob(reg, state, "session quit", {
				marker: "killed at session teardown",
				afterKillMs: LIMITS.quitAfterKillMs,
				watch: false,
			}),
		),
	);
}

function retireGone(reg: Registry, state: JobState, status: string): void {
	if (!retireJob(reg, state, status)) return;
	deleteLease(state.leaseFile);
	state.leaseFile = undefined;
}

// A process in uninterruptible sleep can outlive SIGKILL. It keeps its name and its log path
// until identity disappears, or a new job could write into a file this one still owns.
function watchUnkillable(reg: Registry, state: JobState, reason: string): void {
	if (state.exitedAt !== undefined || state.pollTimer) return;
	state.unkillable = true;
	state.pollTimer = setInterval(() => {
		if (state.exitedAt !== undefined) {
			clearTimers(state);
			return;
		}
		if (state.liveness() !== "gone") return;
		retireGone(reg, state, `killed (${reason}), identity gone`);
		emit(
			reg,
			state,
			`${label(state)} is gone after SIGKILL. Its name and log path (${state.sink.path}) are free again.`,
		);
	}, LIMITS.unkillablePollMs);
	// A stuck job must not hold pi open.
	state.pollTimer.unref();
}

export function emit(reg: Registry, state: JobState, text: string): void {
	try {
		reg.emit(state, text);
	} catch {
		// A dead session must not break job teardown.
	}
}

function label(state: JobState): string {
	return `${state.options.kind === "background" ? "Background job" : "Monitor"} "${state.options.name}"`;
}

function signalGroup(pid: number | undefined, proc: ChildProcess, signal: NodeJS.Signals): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			proc.kill(signal);
		} catch {
			// Already gone.
		}
	}
}

export function dirExists(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
