import { StringEnum } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	getPackageDir,
	keyHint,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { defineFeature, type WakeMessage } from "../../core/feature.ts";
import { clampBlock, formatDuration, LOGS_BUDGET, renderBlock, STATUS_BUDGET } from "./digest.ts";
import { describeLiveness, verifyGroup } from "./identity.ts";
import { deleteLease } from "./leases.ts";
import { readTail } from "./logsink.ts";
import { buildOptions, type Kind, LIMITS, newestDefaultLog, parseMonitorEdit } from "./options.ts";
import { BACKGROUND_PROMPT, SCRIPTS_PROMPT, TIMER_PROMPT } from "./prompt.ts";
import { foreignLogFile, foreignOwner, refreshOrphans, sweepLeases } from "./recovery.ts";
import {
	activeJobs,
	createRegistry,
	describeOptions,
	dropOrphan,
	findJob,
	isMonitor,
	isOtherSession,
	type JobState,
	logFileTaken,
	nameTaken,
	nextId,
	oldRegistryWarning,
	orphans,
	phaseOf,
	type Registry,
	routeDigest,
	runtimeMs,
} from "./registry.ts";
import { awaitExitDigest, describeStop, dirExists, editMonitor, shutdownJobs, startJob, stopJob } from "./runner.ts";
import {
	CODEMODE_PACKAGE,
	createEngineCache,
	installedVersion,
	ownEngineVersion,
	versionSkewWarning,
} from "./script-engine.ts";
import { createScriptStore, createScriptTools, SCRIPT_LIMITS, stopScriptJobs, takeStoppedNotice } from "./scripts.ts";
import {
	armedTimers,
	cancelTimer,
	cancelTimers,
	clearAllTimers,
	createTimerStore,
	fireTimersNow,
	flushTimers,
	listTimers,
	pendingTimers,
	setTimer,
	TIMER_LIMITS,
	type TimerFilter,
	type TimerInfo,
	type TimerResult,
	type TimerStore,
	type TimerWake,
} from "./timers.ts";

export interface BackgroundService {
	timers: {
		armed(sessionId: string): readonly TimerInfo[];
		/** Fired timers that wait for the next runtime bind. They still wake their session. */
		pending(sessionId: string): readonly TimerInfo[];
		cancel(filter: TimerFilter): number;
		fireNow(filter: TimerFilter): number;
	};
}

declare module "../../core/services.ts" {
	interface ServiceMap {
		background: BackgroundService;
	}
}

declare module "../../core/events.ts" {
	interface PimonEvents {
		"timers:changed": { sessionId: string };
	}
}

interface LogsResult {
	name: string;
	logFile: string;
	lines: string[];
	source: "file" | "memory";
	note?: string | undefined;
}

type ActionResult = string | LogsResult;

const KIND_ACTIONS = {
	background: ["start", "list", "status", "logs", "stop"],
	monitor: ["start", "edit", "list", "status", "logs", "stop"],
} as const;

const configSchema = Type.Object(
	{
		maxScriptJobs: Type.Integer({ minimum: 1, maximum: 16, default: SCRIPT_LIMITS.defaultMaxScriptJobs }),
		inlineWaitMs: Type.Integer({ minimum: 0, maximum: 30_000, default: 5_000 }),
	},
	{ additionalProperties: false },
);

export const background = defineFeature({
	id: "background",
	description: "Background jobs that wake the agent on exit, and output monitors that wake it on a matching line",
	defaultEnabled: true,
	configSchema,
	setup(ctx): BackgroundService {
		const reg = ctx.reloadState("registry", 1, () => createRegistry(ctx.agentDir));
		reg.agentDir = ctx.agentDir;
		reg.emit = (state, text) => deliver((message) => ctx.wake(message), reg, state, text);
		const timers = ctx.reloadState("timers", 1, createTimerStore);
		const wakeTimer = (message: TimerWake) => ctx.wake(message);
		const timersChanged = (sessionId: string) => ctx.events.emit("timers:changed", { sessionId });
		timers.wake = wakeTimer;
		timers.changed = timersChanged;

		ctx.promptSection({
			name: "background",
			requiresTools: ["background", "monitor"],
			render: () => BACKGROUND_PROMPT,
		});
		ctx.promptSection({ name: "timer", requiresTools: ["timer"], render: () => TIMER_PROMPT });
		ctx.promptSection({
			name: "scripts",
			requiresTools: ["background_codemode", "monitor_codemode"],
			render: () => SCRIPTS_PROMPT,
		});
		ctx.pi.registerTool(createTool(reg, "background", ctx.config.inlineWaitMs));
		ctx.pi.registerTool(createTool(reg, "monitor", 0));
		ctx.pi.registerTool(createTimerTool(timers));
		const scripts = ctx.reloadState("scripts", 1, createScriptStore);
		const engine = ctx.reloadState("engine", 1, createEngineCache);
		for (const tool of createScriptTools({
			reg,
			engine,
			maxScriptJobs: ctx.config.maxScriptJobs,
			bindSession: (extensionCtx) => bindSession(reg, extensionCtx),
			onEngineLoad: () => {
				const warning = versionSkewWarning(ownEngineVersion(), installedVersion(getPackageDir(), CODEMODE_PACKAGE));
				if (warning) ctx.log.warn(warning);
			},
		}))
			ctx.pi.registerTool(tool);
		registerCommand(ctx.pi, reg, "background");
		registerCommand(ctx.pi, reg, "monitor");
		registerTimersCommand(ctx.pi, timers);

		ctx.onSessionStart((event, extensionCtx) => {
			bindSession(reg, extensionCtx);
			bindTimers(timers, extensionCtx);
			timers.wake = wakeTimer;
			timers.changed = timersChanged;
			// Without a UI, this report and digests from another session are dropped: such a session has no
			// place to show them, and `background list` shows orphans.
			const notify = (text: string, level: "info" | "warning") => {
				if (extensionCtx.hasUI) extensionCtx.ui.notify(text, level);
			};
			const notice = sessionStartNotice(reg, event.reason);
			if (notice) notify(notice, "info");
			const stopped = takeStoppedNotice(scripts, extensionCtx.sessionManager.getSessionId());
			if (stopped) notify(stopped, "info");
			if (!reg.oldRegistryWarned) {
				const warning = oldRegistryWarning(globalThis);
				if (warning) {
					reg.oldRegistryWarned = true;
					notify(warning, "warning");
				}
			}
			const report = sweepLeases(reg);
			if (report) notify(report, "warning");
		});

		// After every session_start handler, so goal recovery still sees the timers that fired while unbound.
		ctx.events.on("pimon:session-ready", () => flushTimers(timers));

		ctx.onSessionShutdown(async (event) => {
			// Before the tool context of each script goes stale.
			await stopScriptJobs(reg, scripts, event.reason);
			if (event.reason === "quit") clearAllTimers(timers);
			if (timers.wake === wakeTimer) {
				timers.wake = undefined;
				timers.notice = undefined;
				timers.changed = undefined;
				// A reload keeps the session. Without host bindings pi skips session_start after it.
				if (event.reason !== "reload") timers.sessionId = undefined;
			}
			// Reload and session replacement keep jobs on purpose: killing a test suite
			// because the user typed /reload is a worse failure than an orphan.
			if (event.reason !== "quit") return;
			await shutdownJobs(reg);
		});

		return {
			timers: {
				armed: (sessionId) => armedTimers(timers, sessionId),
				pending: (sessionId) => pendingTimers(timers, sessionId),
				cancel: (filter) => cancelTimers(timers, filter),
				fireNow: (filter) => fireTimersNow(timers, filter),
			},
		};
	},
});

function bindTimers(timers: TimerStore, extensionCtx: ExtensionContext): void {
	timers.sessionId = extensionCtx.sessionManager.getSessionId();
	timers.notice = extensionCtx.hasUI ? (text) => extensionCtx.ui.notify(text, "info") : undefined;
}

export const TIMER_DESCRIPTION =
	'Wake this session later. action="set" arms a timer that starts or steers a run with its reason when it fires. Use it to come back to slow external work. During an active goal, also set one while waiting on a job, monitor, or bus reply. Timers end with the pi process.';

export const timerParameters = Type.Object({
	action: StringEnum(["set", "list", "cancel"] as const),
	name: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: TIMER_LIMITS.maxNameChars,
			description: "Timer name (default timer-<n>). set with an existing name replaces that timer",
		}),
	),
	delaySeconds: Type.Optional(
		Type.Integer({ minimum: 1, maximum: TIMER_LIMITS.maxDelaySeconds, description: "Seconds until it fires (set)" }),
	),
	reason: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: TIMER_LIMITS.maxReasonChars,
			description: "What to check when it fires (set)",
		}),
	),
});

function runTimerAction(
	timers: TimerStore,
	sessionId: string,
	params: Record<string, unknown>,
	now = Date.now(),
): TimerResult {
	const action = str(params["action"]);
	switch (action) {
		case "set":
			return setTimer(timers, sessionId, params, now);
		case "list":
			return listTimers(timers, sessionId, now);
		case "cancel":
			return cancelTimer(timers, sessionId, params["name"]);
		default:
			return { ok: false, text: `Unsupported timer action: ${action || "<missing>"}. Use set, list, or cancel.` };
	}
}

function createTimerTool(timers: TimerStore) {
	return defineTool({
		name: "timer",
		label: "Timer",
		description: TIMER_DESCRIPTION,
		exposure: "direct",
		parameters: timerParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, extensionCtx) {
			const raw = params as Record<string, unknown>;
			const result = runTimerAction(timers, extensionCtx.sessionManager.getSessionId(), raw);
			if (!result.ok) throw new Error(result.text);
			return { content: [{ type: "text", text: result.text }], details: { action: raw["action"] } };
		},
	});
}

function registerTimersCommand(pi: ExtensionAPI, timers: TimerStore): void {
	pi.registerCommand("timers", {
		description: "List the timers of this session, or cancel one with /timers cancel <name>",
		handler: async (args, extensionCtx) => {
			const [subcommand, rest] = splitFirst(args.trim());
			const params =
				subcommand === "" || subcommand === "list"
					? { action: "list" }
					: subcommand === "cancel"
						? { action: "cancel", name: rest }
						: undefined;
			const result = params
				? runTimerAction(timers, extensionCtx.sessionManager.getSessionId(), params)
				: { ok: false, text: `Unknown timers command: ${subcommand}. Use /timers or /timers cancel <name>.` };
			if (extensionCtx.hasUI) extensionCtx.ui.notify(result.text, result.ok ? "info" : "error");
		},
	});
}

export function sessionStartNotice(reg: Registry, reason: string): string | undefined {
	const active = activeJobs(reg);
	if (reason === "reload") return active.length > 0 ? `Kept ${active.length} running job(s) across reload` : undefined;
	if (reason !== "new" && reason !== "resume" && reason !== "fork") return undefined;
	const others = active.filter((state) => isOtherSession(reg, state));
	if (others.length === 0) return undefined;
	return `${others.length} job(s) from another session are still running: ${others.map((state) => state.options.name).join(", ")}. Their digests show here as notices only.`;
}

function bindSession(reg: Registry, extensionCtx: ExtensionContext): void {
	reg.sessionId = extensionCtx.sessionManager.getSessionId();
	reg.notice = extensionCtx.hasUI ? (text) => extensionCtx.ui.notify(text, "info") : undefined;
}

function deliver(wake: (message: WakeMessage) => void, reg: Registry, state: JobState, text: string): void {
	if (routeDigest(state.sessionId, reg.sessionId) === "notice") {
		reg.notice?.(text.split("\n")[0] ?? text);
		return;
	}
	wake({
		customType: state.options.kind,
		content: text,
		display: true,
		details: {
			name: state.options.name,
			command: state.options.command,
			cwd: state.options.cwd,
			logFile: state.options.logFile,
			status: state.exitStatus,
		},
	});
}

export const backgroundParameters = Type.Object({
	action: StringEnum(KIND_ACTIONS.background),
	command: Type.Optional(Type.String({ description: "Shell command to run (start)" })),
	name: Type.Optional(Type.String({ description: "Job name; letters, digits, dot, dash, underscore" })),
	cwd: Type.Optional(Type.String({ description: "Working directory (default: session cwd)" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Kill the job after this long; 0 disables (default 1800000)" })),
	notifyExit: Type.Optional(Type.Boolean({ description: "Wake on exit with a bounded output digest (default true)" })),
	logFile: Type.Optional(Type.String({ description: "Log file path; relative paths resolve against cwd" })),
	lines: Type.Optional(Type.Number({ description: "Lines to return for logs (default 50)" })),
	fromFile: Type.Optional(
		Type.Boolean({ description: "Read logs from the file instead of the memory tail (default true)" }),
	),
});

export const monitorParameters = Type.Object({
	action: StringEnum(KIND_ACTIONS.monitor),
	command: Type.Optional(Type.String({ description: "Shell command to watch (start)" })),
	name: Type.Optional(Type.String({ description: "Job name; letters, digits, dot, dash, underscore" })),
	match: Type.Optional(
		Type.String({
			description: "Required for start. Literal substring, or a regex with regex=true. Matched per line.",
		}),
	),
	regex: Type.Optional(Type.Boolean({ description: "Treat match as a regex" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive match" })),
	stream: Type.Optional(StringEnum(["stdout", "stderr", "both"] as const, { description: "Default stdout" })),
	once: Type.Optional(Type.Boolean({ description: "Stop after the first matching batch" })),
	notifyExit: Type.Optional(Type.Boolean({ description: "Wake if the watched command exits (default true)" })),
	debounceMs: Type.Optional(Type.Number({ description: "Batch matches for this long (default 250)" })),
	maxPerMinute: Type.Optional(Type.Number({ description: "Mute notifications above this rate (default 6)" })),
	timeoutMs: Type.Optional(Type.Number({ description: "Kill the watcher after this long; 0 disables (default 0)" })),
	logFile: Type.Optional(Type.String({ description: "Log file path; relative paths resolve against cwd" })),
	cwd: Type.Optional(Type.String({ description: "Working directory (default: session cwd)" })),
	lines: Type.Optional(Type.Number({ description: "Lines to return for logs (default 50)" })),
	fromFile: Type.Optional(
		Type.Boolean({ description: "Read logs from the file instead of the memory tail (default true)" }),
	),
});

export const BACKGROUND_DESCRIPTION =
	"Run a long-running local command in the background. It reports nothing while running and wakes you once when the process exits; read output with action=logs. A job that exits within a few seconds returns its digest at once. Use for tests, builds, and benchmarks. Pass timeoutMs=0 for a server that should run until stopped. Shell jobs and monitors survive reloads and session switches; pi quit stops them.";
export const MONITOR_DESCRIPTION =
	"Watch a command's output and wake the agent when a line matches. Use for CI/PR polling, log watching, and readiness probes.";

function createTool(reg: Registry, kind: Kind, inlineWaitMs: number) {
	const isBackground = kind === "background";
	return defineTool({
		name: kind,
		label: isBackground ? "Background" : "Monitor",
		description: isBackground ? BACKGROUND_DESCRIPTION : MONITOR_DESCRIPTION,
		parameters: isBackground ? backgroundParameters : monitorParameters,
		async execute(_toolCallId, params, signal, _onUpdate, extensionCtx) {
			bindSession(reg, extensionCtx);
			const raw = params as Record<string, unknown>;
			const result = await runAction(reg, kind, raw, extensionCtx.cwd, { inlineWaitMs, signal });
			return typeof result === "string"
				? { content: [{ type: "text", text: result }], details: { action: raw["action"] } }
				: { content: [{ type: "text", text: renderLogs(result) }], details: result };
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
			const details = result.details as Partial<LogsResult> | undefined;
			if (!details?.lines || details.name === undefined || details.logFile === undefined)
				return new Text(textOf(result), 0, 0);
			let text = `${theme.fg("success", `Logs for ${details.name}`)} ${theme.fg("dim", `(${details.lines.length} line(s), ${details.source})`)}`;
			text += `\n${theme.fg("dim", details.logFile)}`;
			if (!expanded) {
				text += `\n${theme.fg("muted", keyHint("app.tools.expand", "to expand"))}`;
				return new Text(text, 0, 0);
			}
			text += `\n${details.lines.join("\n")}`;
			return new Text(text, 0, 0);
		},
	});
}

export async function runAction(
	reg: Registry,
	kind: Kind,
	params: Record<string, unknown>,
	defaultCwd: string,
	options: StartOptions = {},
): Promise<ActionResult> {
	const action = str(params["action"]);
	switch (action) {
		case "start":
			return start(reg, kind, params, defaultCwd, options);
		case "edit":
			return kind === "monitor"
				? edit(reg, params)
				: "background jobs cannot be edited. Stop the job and start a new one.";
		case "list":
			return list(reg, kind);
		case "status":
			return status(reg, str(params["name"]));
		case "logs":
			return logs(reg, str(params["name"]), params["lines"], params["fromFile"] !== false);
		case "stop":
			return stop(reg, kind, str(params["name"]));
		default:
			return `Unsupported ${kind} action: ${action || "<missing>"}. Use ${KIND_ACTIONS[kind].join(", ")}.`;
	}
}

interface StartOptions {
	/** How long a `background` start waits for the exit digest. 0 returns at once. */
	inlineWaitMs?: number | undefined;
	signal?: AbortSignal | undefined;
}

async function start(
	reg: Registry,
	kind: Kind,
	params: Record<string, unknown>,
	defaultCwd: string,
	{ inlineWaitMs = 0, signal }: StartOptions,
): Promise<string> {
	if (
		kind === "background" &&
		(params["match"] !== undefined || params["regex"] !== undefined || params["debounceMs"] !== undefined)
	) {
		return "background does not match output. It wakes you once on exit; use monitor for pattern matching.";
	}
	// A sibling pi may have crashed since the last look: find its leases before a name or log path is chosen.
	sweepLeases(reg);
	const options = buildOptions(kind, params, {
		defaultCwd,
		nextId: () => nextId(reg),
		isNameTaken: (name) => nameTaken(reg, name),
		isLogFileTaken: (file) => logFileTaken(reg, file) ?? foreignLogFile(reg, file),
		activeCount: () => reg.active.size,
		dirExists,
	});
	if (typeof options === "string") return options;

	const started = startJob(reg, options, reg.sessionId);
	if (!started.ok) return started.error;
	if (kind === "background" && inlineWaitMs > 0) {
		const digest = await awaitExitDigest(started.state, inlineWaitMs, signal);
		if (digest !== undefined) return digest;
	}
	return describeStart(started.state, defaultCwd);
}

function describeStart(state: JobState, sessionCwd: string): string {
	const options = state.options;
	const lines = [
		`Started ${options.kind} "${options.name}" (pid ${state.pid ?? "unknown"}).`,
		...(options.cwd === sessionCwd ? [] : [`Cwd: ${options.cwd}`]),
		`Log: ${options.logFile}`,
	];
	if (isMonitor(state)) {
		const monitor = state.options;
		lines.push(
			`Watching ${[...monitor.streams].join(",")} for ${JSON.stringify(monitor.matchSource)} as a ${monitor.mode}${monitor.ignoreCase ? ", ignoring case" : ""}.`,
		);
	} else {
		lines.push(
			options.notifyExit
				? `You will be woken once when it exits${options.timeoutMs > 0 ? `, or after ${formatDuration(options.timeoutMs)}` : ""}.`
				: "Silent job: no wake on exit.",
		);
	}
	if (!state.identity)
		lines.push(
			"No process identity available, so no crash-recovery lease was written: if pi dies hard, this job is untracked.",
		);
	return lines.join("\n");
}

function edit(reg: Registry, params: Record<string, unknown>): string {
	const name = str(params["name"]);
	if (!name) return "edit requires name";
	const state = reg.active.get(name);
	if (!state) return unknownActive(reg, name);
	if (!isMonitor(state)) return `"${name}" is a background job and cannot be edited.`;
	if (state.script && (params["timeoutMs"] !== undefined || params["stream"] !== undefined))
		return `"${name}" is a script monitor. Its deadline and stream are fixed at start; edit cannot change timeoutMs or stream.`;

	const updates = parseMonitorEdit(params, state.options);
	if (typeof updates === "string") return updates;
	const unmuted = editMonitor(reg, state, updates);
	return `Edited monitor "${name}"${unmuted ? " and unmuted it" : ""}: ${describeOptions(state.options)}`;
}

function list(reg: Registry, kind: Kind): string {
	refreshOrphans(reg);
	const items = activeJobs(reg, kind);
	const strays = orphans(reg).filter((record) => record.lease.kind === kind);
	const blocks: string[] = [];

	for (const state of items) {
		const flags = [
			state.muted ? (state.mutePermanent ? "muted permanently" : "muted") : undefined,
			state.unkillable ? "unkillable" : undefined,
		]
			.filter(Boolean)
			.join(", ");
		const other = isOtherSession(reg, state) ? " (other session)" : "";
		const script = state.script !== undefined;
		blocks.push(
			[
				`- ${state.options.name} [${state.options.kind}${script ? " script" : ""}${flags ? ` ${flags}` : ""}]${other}${script ? "" : ` pid ${state.pid ?? "?"}`} up ${formatDuration(runtimeMs(state))}`,
				`  state: ${phaseOf(state)}`,
				script ? `  code: ${state.options.command}` : `  command: ${state.options.command}`,
				`  ${describeOptions(state.options)}`,
				`  cwd: ${state.options.cwd}`,
				`  log: ${state.sink.path}`,
			].join("\n"),
		);
	}

	for (const record of strays) {
		blocks.push(
			[
				`- ${record.lease.name} [${record.lease.kind} orphaned; capture unavailable] pid ${record.lease.identity.pid}`,
				`  state: ${describeLiveness(record.liveness)}`,
				`  command: ${record.lease.command}`,
				`  started: ${new Date(record.lease.createdAt).toISOString()}`,
				`  log: ${record.lease.logFile}`,
				"  left behind by an earlier pi. Its name and log path are reserved; output capture is gone.",
			].join("\n"),
		);
	}

	if (blocks.length > 0) return blocks.join("\n");

	const done = [...reg.completed.values()].filter((state) => state.options.kind === kind);
	return done.length === 0
		? `No active ${kind} jobs`
		: `No active ${kind} jobs. Recently finished: ${done
				.slice(-5)
				.map((state) => `${state.options.name}${state.script ? " script" : ""} (${state.exitStatus})`)
				.join(", ")}`;
}

function status(reg: Registry, name: string): string {
	if (!name) return "status requires name";
	refreshOrphans(reg);
	const state = findJob(reg, name);
	if (!state) {
		const record = reg.orphans.get(name);
		if (record) {
			return [
				`${name} [${record.lease.kind}] orphaned; capture unavailable`,
				`Liveness: ${describeLiveness(record.liveness)}`,
				`Pid: ${record.lease.identity.pid} (pgid ${record.lease.identity.pgid})`,
				`Command: ${record.lease.command}`,
				`Cwd: ${record.lease.cwd}`,
				`Started: ${new Date(record.lease.createdAt).toISOString()}`,
				`Log: ${record.lease.logFile}`,
				"An earlier pi started this. Its stdout and stderr cannot be reattached, so there will be no exit digest.",
			].join("\n");
		}
		const earlier = newestDefaultLog(name);
		if (earlier) return `Newest log with this name from another or an earlier pi process: ${earlier}`;
		return unknownAny(reg, name);
	}

	const running = state.exitedAt === undefined;
	const stats = state.matcher?.stats();
	const other = isOtherSession(reg, state) ? " (other session)" : "";
	const script = state.script !== undefined;
	const head = [
		`${state.options.name} [${state.options.kind}${script ? " script" : ""}]${other} ${phaseOf(state)}`,
		`Runtime: ${formatDuration(runtimeMs(state))}${running ? "" : " (finished)"}`,
		...(script ? [] : [`Pid: ${state.pid ?? "unknown"}`]),
		script ? `Code: ${state.options.command}` : `Command: ${state.options.command}`,
		`Cwd: ${state.options.cwd}`,
		describeOptions(state.options),
		`Lines captured: ${state.totalLines}${state.droppedLines > 0 ? ` (${state.droppedLines} older line(s) only in the log file)` : ""}`,
		`Log: ${state.sink.path} (${state.sink.written} bytes this file)`,
	];
	if (running && state.identity) head.push(`Identity: ${describeLiveness(state.liveness())}`);
	if (state.muted) {
		const why = state.muteReason ? ` (${state.muteReason})` : "";
		head.push(
			state.mutePermanent
				? `Muted permanently${why}. Matching is off until you edit or restart it.`
				: `Muted${why} for another ${formatDuration(Math.max(0, state.mutedUntil - Date.now()))}. It resumes on its own.`,
		);
	}
	if (stats && stats.dropped > 0)
		head.push(`Match queue dropped ${stats.dropped} line(s) under load; the log file is complete.`);
	const note = state.sink.note();
	if (note) head.push(note);
	return [...head, ...renderBlock(state.tail, STATUS_BUDGET, state.totalLines)].join("\n");
}

function logs(reg: Registry, name: string, rawLines: unknown, fromFile: boolean): LogsResult | string {
	if (!name) return "logs requires name";
	refreshOrphans(reg);
	const state = findJob(reg, name);
	const record = state ? undefined : reg.orphans.get(name);
	const earlier = state || record ? undefined : newestDefaultLog(name);
	const logFile = state ? state.sink.path : (record?.lease.logFile ?? earlier);
	if (logFile === undefined) return unknownAny(reg, name);

	const requested = clampNumber(rawLines, 50, 1, LOGS_BUDGET.maxLines);
	const useFile = fromFile || !state;
	const sinkBroken = state ? state.sink.error !== undefined : false;

	let raw: string[] = [];
	let readError: string | undefined;
	if (useFile && !sinkBroken) {
		const tail = readTail(logFile, requested, LIMITS.logTailBytes);
		raw = tail.lines;
		readError = tail.error;
	} else if (state) {
		raw = state.tail.slice(-requested);
	}

	const block = clampBlock(raw, LOGS_BUDGET);
	const lines = raw.length === 0 ? ["<no output captured>"] : block.lines;
	const notes = [
		state?.sink.note(),
		readError ? `Log could not be read (${readError}).` : undefined,
		record ? "Orphaned job: this is the recorded log path from an earlier pi." : undefined,
		earlier
			? "Not tracked by this pi process. This is the newest log with this name from another or an earlier pi process."
			: undefined,
		block.dropped > 0
			? `Truncated to ${block.lines.length} of ${raw.length} line(s) to stay within ${LOGS_BUDGET.maxTotalChars} chars.`
			: undefined,
	].filter(Boolean);
	return {
		name,
		logFile,
		lines,
		source: useFile && !sinkBroken && !readError ? "file" : "memory",
		note: notes.length > 0 ? notes.join(" ") : undefined,
	};
}

async function stop(reg: Registry, kind: Kind, name: string): Promise<string> {
	refreshOrphans(reg);
	if (!name) {
		const active = activeJobs(reg, kind).map((state) => state.options.name);
		return active.length === 0
			? `No active ${kind} jobs`
			: `stop requires name. Active ${kind} jobs: ${active.join(", ")}. Use name=all to stop all of them.`;
	}
	if (name === "all") {
		const items = activeJobs(reg, kind);
		if (items.length === 0) return `No active ${kind} jobs`;
		const outcomes = await Promise.all(items.map((state) => stopJob(reg, state, "stopped by agent")));
		return outcomes.map((result) => `${result.kind} "${result.name}": ${result.text}`).join("\n");
	}
	const state = reg.active.get(name);
	if (!state) return stopOrphan(reg, name);
	const result = await stopJob(reg, state, "stopped by agent");
	return describeStop(result, state.sink.path);
}

function unknownActive(reg: Registry, name: string): string {
	const live = [...reg.active.keys()];
	return `No running job or monitor named "${name}".${live.length > 0 ? ` Running now: ${live.join(", ")}.` : " Nothing is running."}`;
}

function unknownAny(reg: Registry, name: string): string {
	const known = [...new Set([...reg.active.keys(), ...reg.orphans.keys()])];
	return `No job or monitor named "${name}".${known.length > 0 ? ` Known names: ${known.join(", ")}.` : " Nothing is running."}`;
}

// Signals an orphan only when identity verifies. Ambiguity must not authorize a kill.
function stopOrphan(reg: Registry, name: string): string {
	const record = reg.orphans.get(name);
	if (!record) {
		const owner = foreignOwner(reg, name);
		return owner === undefined
			? unknownActive(reg, name)
			: `"${name}" belongs to a running pi (pid ${owner}). Stop it from that session.`;
	}

	const liveness = verifyGroup(record.lease.identity);
	if (liveness === "gone") {
		deleteLease(record.file);
		dropOrphan(reg, name);
		return `Orphan "${name}" is already gone. Its lease was removed and the name is free again.`;
	}
	if (liveness !== "alive") {
		record.liveness = liveness;
		return [
			`Refusing to signal orphan "${name}": ${describeLiveness(liveness)}.`,
			`Recorded pid ${record.lease.identity.pid}, pgid ${record.lease.identity.pgid}. Signalling an unverified group could hit an unrelated process.`,
			`Inspect it yourself, or read ${record.lease.logFile}.`,
		].join("\n");
	}
	try {
		process.kill(-record.lease.identity.pgid, "SIGTERM");
	} catch (error) {
		return `Could not signal orphan "${name}": ${error instanceof Error ? error.message : String(error)}`;
	}
	record.liveness = verifyGroup(record.lease.identity);
	if (record.liveness === "gone") {
		deleteLease(record.file);
		dropOrphan(reg, name);
		return `Orphan "${name}" was signalled and is gone. Lease removed, name free.`;
	}
	return `SIGTERM sent to orphan "${name}" (pgid ${record.lease.identity.pgid}). It is ${describeLiveness(record.liveness)}; the name stays reserved until it is gone.`;
}

function renderLogs(result: LogsResult): string {
	return [
		`Logs for ${result.name} (${result.source}): ${result.logFile}`,
		...(result.note ? [result.note] : []),
		"```text",
		...result.lines,
		"```",
	].join("\n");
}

function registerCommand(pi: ExtensionAPI, reg: Registry, kind: Kind): void {
	pi.registerCommand(kind, {
		description:
			kind === "background"
				? "Start, inspect, and stop long-running local commands (reports on exit only)"
				: "Start, edit, inspect, and stop output monitors that wake the LLM on a match",
		handler: async (args, extensionCtx) => {
			bindSession(reg, extensionCtx);
			const notify = (text: string, level: "info" | "error") => {
				if (extensionCtx.hasUI) extensionCtx.ui.notify(text, level);
			};
			const trimmed = args.trim();
			if (!trimmed || trimmed === "help" || trimmed === "--help") {
				notify(usage(kind), "info");
				return;
			}
			const [subcommand, rest] = splitFirst(trimmed);
			const params = parseCliParams(kind, subcommand, rest);
			if (typeof params === "string") {
				notify(`${params}\n\n${usage(kind)}`, "error");
				return;
			}
			const result = await runAction(reg, kind, params, extensionCtx.cwd);
			notify(typeof result === "string" ? result : renderLogs(result), "info");
		},
	});
}

export function parseCliParams(kind: Kind, subcommand: string, rest: string): Record<string, unknown> | string {
	const known: readonly string[] = KIND_ACTIONS[kind];
	if (!known.includes(subcommand)) return `Unknown ${kind} command: ${subcommand}`;

	if (subcommand === "list") return { action: "list" };
	if (subcommand === "status" || subcommand === "stop") return { action: subcommand, name: tokenize(rest)[0] ?? "" };
	if (subcommand === "logs") {
		const tokens = tokenize(rest);
		const flags = parseFlags(validFlags(kind, subcommand), tokens.slice(1));
		if (typeof flags === "string") return flags;
		return { action: "logs", name: tokens[0] ?? "", lines: flags["lines"], fromFile: flags["fromFile"] };
	}
	if (subcommand === "edit") {
		const tokens = tokenize(rest);
		const flags = parseFlags(validFlags(kind, subcommand), tokens.slice(1));
		if (typeof flags === "string") return flags;
		return { action: "edit", name: tokens[0] ?? "", ...flags };
	}

	const marker = " -- ";
	const index = rest.indexOf(marker);
	if (index === -1) return "Missing command separator. Put the command after -- .";
	const command = rest.slice(index + marker.length).trim();
	if (!command) return "Missing command after --";
	const flags = parseFlags(validFlags(kind, subcommand), tokenize(rest.slice(0, index)));
	if (typeof flags === "string") return flags;
	return { action: "start", command, ...flags };
}

const BOOLEAN_FLAGS = new Set(["ignore-case", "once", "no-exit", "exit", "from-memory", "regex"]);

const SHARED_START_FLAGS = ["name", "cwd", "timeout-ms", "no-exit", "exit", "log-file"];
const MONITOR_MATCH_FLAGS = ["match", "regex", "ignore-case", "stream", "once", "debounce-ms", "max-per-minute"];

function validFlags(kind: Kind, subcommand: string): readonly string[] {
	if (subcommand === "logs") return ["lines", "from-memory"];
	if (subcommand === "edit") return [...MONITOR_MATCH_FLAGS, "no-exit", "exit", "timeout-ms"];
	return kind === "monitor" ? [...SHARED_START_FLAGS, ...MONITOR_MATCH_FLAGS] : SHARED_START_FLAGS;
}

function parseFlags(allowed: readonly string[], tokens: string[]): Record<string, unknown> | string {
	const params: Record<string, unknown> = {};
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		if (!token.startsWith("--")) return `Unexpected argument: ${token}`;
		const raw = token.slice(2);
		const equals = raw.indexOf("=");
		const key = equals === -1 ? raw : raw.slice(0, equals);
		if (!key) return `Invalid flag: ${token}`;
		if (!allowed.includes(key))
			return `Unknown flag --${key}. Valid flags: ${allowed.map((flag) => `--${flag}`).join(", ")}`;
		let value: string | boolean;
		if (BOOLEAN_FLAGS.has(key)) {
			value = equals === -1 ? true : raw.slice(equals + 1) !== "false";
		} else if (equals !== -1) {
			value = raw.slice(equals + 1);
		} else {
			const next = tokens[++index];
			if (next === undefined || next.startsWith("--")) return `Missing value for --${key}`;
			value = next;
		}
		switch (key) {
			case "no-exit":
				params["notifyExit"] = false;
				break;
			case "exit":
				params["notifyExit"] = true;
				break;
			case "from-memory":
				params["fromFile"] = false;
				break;
			default:
				params[key.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())] = value;
		}
	}
	return params;
}

function usage(kind: Kind): string {
	const prefix = `/${kind}`;
	const shared = [
		"  --name <name>",
		"  --cwd <path>",
		"  --timeout-ms <n>",
		"  --no-exit                 Do not wake on exit",
		"  --log-file <path>",
	];
	const monitorOnly = [
		"  --match <text>            Required. Literal substring unless --regex",
		"  --regex                   Treat --match as a regex, run in an isolated worker",
		"  --ignore-case",
		"  --stream stdout|stderr|both",
		"  --once",
		"  --debounce-ms <n>",
		"  --max-per-minute <n>",
	];
	return [
		"Usage:",
		`  ${prefix} start [options] -- <command>`,
		...(kind === "monitor" ? [`  ${prefix} edit <name> [options]`] : []),
		`  ${prefix} list`,
		`  ${prefix} status <name>`,
		`  ${prefix} logs <name> [--lines <n>] [--from-memory]`,
		`  ${prefix} stop <name|all>`,
		"",
		"Options:",
		...shared,
		...(kind === "monitor" ? monitorOnly : []),
		"",
		kind === "background"
			? `Background jobs report only when they exit. Read output with ${prefix} logs.`
			: "Monitors match a literal substring by default. Catch-alls are rejected, floods are muted for 60s, and regexes run isolated.",
		"",
		"Example:",
		kind === "background"
			? `  ${prefix} start --name tests -- pnpm test`
			: `  ${prefix} start --name pr --match 'All checks passed' -- gh pr checks 123 --watch`,
	].join("\n");
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.round(parsed)));
}

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
	return result.content?.find((item) => item.type === "text")?.text ?? "";
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function splitFirst(input: string): [string, string] {
	const index = input.search(/\s/);
	return index === -1 ? [input, ""] : [input.slice(0, index), input.slice(index + 1)];
}

export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;
	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}
		if ((char === "'" || char === '"') && !quote) {
			quote = char;
			continue;
		}
		if (char === quote) {
			quote = undefined;
			continue;
		}
		if (/\s/.test(char) && !quote) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}
