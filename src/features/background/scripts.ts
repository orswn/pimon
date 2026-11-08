// A script job is a registry job without an OS process. It runs a codemode script in pimon's
// sandbox, with the tool context of the call that started it. That context goes stale at reload
// and session switch, so every script job stops at session shutdown.
import type { AgentTool, AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { CodemodeResult, CodemodeTool } from "@earendil-works/pi-codemode";
import { defineTool, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatDuration, SCRIPT_EXIT_BUDGET, type ScriptOutcome, scriptExitDigest } from "./digest.ts";
import { clampText } from "./lines.ts";
import { LogSink } from "./logsink.ts";
import { buildOptions, type JobOptions, type Kind, LIMITS } from "./options.ts";
import {
	activeJobs,
	addJob,
	appendTail,
	isMonitor,
	type JobState,
	logFileTaken,
	nameTaken,
	nextId,
	type Registry,
	retireJob,
	runtimeMs,
} from "./registry.ts";
import { attachMatcher, emit, flush, handleLine, stopJob } from "./runner.ts";
import { type EngineCache, loadEngine, runScript } from "./script-engine.ts";

export const SCRIPT_LIMITS = {
	maxEmitChars: 16 * 1024,
	minSleepMs: 1,
	maxSleepMs: 3_600_000,
	maxCodeChars: 100_000,
	defaultMaxScriptJobs: 4,
} as const;

const CUT_MARK = "[cut]";
const LOG_FILE_MODE = 0o600;

export interface ScriptStore {
	/** Script jobs stopped at a session shutdown, by session id. Shown once when that session starts again. */
	stopped: Map<string, { reason: string; names: string[] }>;
}

export function createScriptStore(): ScriptStore {
	return { stopped: new Map() };
}

export function runningScripts(reg: Registry): JobState[] {
	return activeJobs(reg).filter((state) => state.script !== undefined);
}

/** Aborts every running script job and keeps their names for the next start of their session. A quit keeps nothing. */
export async function stopScriptJobs(reg: Registry, store: ScriptStore, reason: string): Promise<void> {
	const running = runningScripts(reg);
	if (running.length === 0) return;
	for (const state of running) {
		if (state.sessionId === undefined || reason === "quit") continue;
		const entry = store.stopped.get(state.sessionId) ?? { reason, names: [] };
		entry.reason = reason;
		entry.names.push(state.options.name);
		store.stopped.set(state.sessionId, entry);
	}
	await Promise.all(
		running.map((state) => stopJob(reg, state, `session ${reason}`, { marker: "stopped at session shutdown" })),
	);
}

/** The notice for script jobs of this session that a shutdown stopped. Each notice shows once. */
export function takeStoppedNotice(store: ScriptStore, sessionId: string): string | undefined {
	const entry = store.stopped.get(sessionId);
	if (!entry) return undefined;
	store.stopped.delete(sessionId);
	const when = entry.reason === "reload" ? "reload" : "session switch";
	return `Script jobs stopped at ${when}: ${entry.names.join(", ")}`;
}

function textOf(result: { content?: ReadonlyArray<{ type: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

/** Same rule as pi's codemode tool: a tool with an output schema resolves to its structured content, also on error. */
export function toScriptValue(tool: Pick<AgentTool, "name" | "outputSchema">, outcome: AgentToolCallOutcome): unknown {
	const { result } = outcome;
	if (tool.outputSchema && result.structuredContent !== undefined) return result.structuredContent;
	const text = textOf(result);
	if (outcome.isError) throw new Error(text || `Tool "${tool.name}" failed`);
	return text;
}

export function emitLine(text: unknown): string {
	if (typeof text !== "string") throw new TypeError("emit(text) takes a string");
	const line = text.replace(/\r?\n/g, "\\n");
	if (line.length <= SCRIPT_LIMITS.maxEmitChars) return line;
	return `${line.slice(0, SCRIPT_LIMITS.maxEmitChars - CUT_MARK.length)}${CUT_MARK}`;
}

export function sleepMs(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < SCRIPT_LIMITS.minSleepMs ||
		value > SCRIPT_LIMITS.maxSleepMs
	)
		throw new RangeError(`sleep(ms) takes ${SCRIPT_LIMITS.minSleepMs} to ${SCRIPT_LIMITS.maxSleepMs} ms`);
	return value;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		timer.unref();
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function valueText(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? String(value);
}

function outcomeOf(result: CodemodeResult): ScriptOutcome {
	if (result.ok) return "ok";
	if (result.error.kind === "timeout") return "timeout";
	if (result.error.kind === "aborted") return "aborted";
	return "error";
}

function scriptLabel(code: string): string {
	const first = code.trim().split("\n")[0] ?? "";
	return `script: ${first.length > 80 ? `${first.slice(0, 80)}…` : first}`;
}

function header(kind: Kind, name: string, code: string): string {
	return [
		`# pi ${kind}_codemode "${name}"`,
		`# started: ${new Date().toISOString()}`,
		"# script:",
		...code.split("\n").map((line) => `# | ${line}`),
		"# emitted lines follow; console output, text(), and the return value follow when the script ends",
	].join("\n");
}

interface ScriptStartDeps {
	reg: Registry;
	maxScriptJobs: number;
	ctx: ExtensionToolContext;
	engine: EngineCache;
	/** Called once, when this start loads the sandbox. */
	onEngineLoad?: () => void;
}

/** Starts a script job. Returns the start text; throws with the reason when nothing started. */
export async function startScriptJob(
	kind: Kind,
	params: Record<string, unknown>,
	deps: ScriptStartDeps,
): Promise<string> {
	const { reg, ctx } = deps;
	const code = typeof params["code"] === "string" ? params["code"] : "";
	if (!code.trim()) throw new Error("Missing required code");
	if (code.length > SCRIPT_LIMITS.maxCodeChars)
		throw new Error(`code is too long (${code.length} chars, max ${SCRIPT_LIMITS.maxCodeChars})`);

	const engine = await loadEngine(deps.engine, deps.onEngineLoad);
	// No await below: the registry checks and the registration must not interleave with another start.

	const tools = scriptTools(ctx);
	const running = runningScripts(reg);
	if (running.length >= deps.maxScriptJobs) {
		throw new Error(
			`Too many script jobs: ${running.length} of ${deps.maxScriptJobs} run now (${running.map((state) => state.options.name).join(", ")}). Stop one with background action=stop before starting another.`,
		);
	}

	const options = buildOptions(
		kind,
		{
			name: params["name"],
			timeoutMs: params["timeoutMs"],
			notifyExit: kind === "monitor" ? params["notifyExit"] === true : params["notifyExit"],
			command: scriptLabel(code),
			...(kind === "monitor"
				? {
						match: params["match"],
						regex: params["regex"],
						ignoreCase: params["ignoreCase"],
						once: params["once"],
						debounceMs: params["debounceMs"],
						maxPerMinute: params["maxPerMinute"],
					}
				: {}),
		},
		{
			defaultCwd: ctx.cwd,
			nextId: () => nextId(reg),
			isNameTaken: (name) => nameTaken(reg, name),
			isLogFileTaken: (file) => logFileTaken(reg, file),
			activeCount: () => reg.active.size,
			dirExists: () => true,
			matchAnyWithoutMatch: true,
		},
	);
	if (typeof options === "string") throw new Error(options);

	const abort = new AbortController();
	const state = createScriptState(reg, options, code, abort);
	const globals = scriptGlobals(reg, state);
	runScript(engine, { code, tools, globals, signal: abort.signal, timeoutMs: options.timeoutMs })
		.then(
			(result) => finishScript(reg, state, result),
			(error: unknown) =>
				finishScript(reg, state, {
					ok: false,
					error: { kind: "sandbox", message: error instanceof Error ? error.message : String(error) },
					output: [],
					calls: [],
				}),
		)
		.catch(() => {
			// A dead session must not break job teardown.
		});
	return describeScriptStart(state);
}

function createScriptState(reg: Registry, options: JobOptions, code: string, abort: AbortController): JobState {
	const sink = new LogSink(options.logFile, options.logMaxBytes, {}, LOG_FILE_MODE);
	sink.open(header(options.kind, options.name, code));
	let markExited = () => {};
	const exited = new Promise<void>((resolve) => {
		markExited = resolve;
	});
	const now = Date.now();
	const state: JobState = {
		options,
		script: { code, abort },
		sink,
		matcher: undefined,
		identity: undefined,
		leaseFile: undefined,
		sessionId: reg.sessionId,
		startedAt: now,
		pid: undefined,
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
		exited,
		markExited,
		kill: () => abort.abort(new Error("Script job stopped")),
		liveness: () => (state.exitedAt === undefined ? "alive" : "gone"),
	};
	addJob(reg, state);
	if (isMonitor(state)) attachMatcher(reg, state);
	return state;
}

/** Every tool the starting call could call, so the same exposure rules apply as for pi's codemode tool. */
function scriptTools(ctx: ExtensionToolContext): CodemodeTool[] {
	return ctx.tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		execute: async (args, { signal }) => toScriptValue(tool, await ctx.executeTool(tool.name, args, { signal })),
	}));
}

function scriptGlobals(reg: Registry, state: JobState): CodemodeTool[] {
	return [
		{
			name: "emit",
			execute: (text) => {
				const line = emitLine(text);
				if (state.exitedAt !== undefined) return;
				state.sink.write(`${line}\n`);
				handleLine(reg, state, "stdout", line);
			},
		},
		{
			name: "sleep",
			execute: (ms, { signal }) => sleep(sleepMs(ms), signal),
		},
	];
}

function scriptErrorLine(result: CodemodeResult): string | undefined {
	return result.ok ? undefined : `Script ${outcomeOf(result)}: ${result.error.message}`;
}

function outputLines(result: CodemodeResult): string[] {
	const lines: string[] = [];
	for (const item of result.output) {
		if (item.type === "text") lines.push(...item.text.split("\n"));
		else lines.push(`[image ${item.mimeType}]`);
	}
	if (result.ok && result.value !== undefined) lines.push(`Returned: ${valueText(result.value)}`);
	return lines;
}

function finishScript(reg: Registry, state: JobState, result: CodemodeResult): void {
	for (const line of outputLines(result)) {
		state.sink.write(`${line}\n`);
		appendTail(state, line);
	}
	const errorLine = scriptErrorLine(result);
	if (errorLine !== undefined) {
		state.sink.write(`${errorLine}\n`);
		appendTail(state, clampText(errorLine.replace(/\r?\n/g, "\\n"), SCRIPT_EXIT_BUDGET.maxLineChars));
	}
	if (state.stopping) {
		state.pending = [];
		state.pendingTotal = 0;
	} else {
		flush(reg, state);
	}
	const outcome = outcomeOf(result);
	if (!retireJob(reg, state, outcome)) return;
	if (state.stopping) return;
	if (!state.options.notifyExit && outcome !== "timeout") return;
	emit(
		reg,
		state,
		scriptExitDigest({
			kind: state.options.kind,
			name: state.options.name,
			outcome,
			runtimeMs: runtimeMs(state),
			tail: state.tail,
			totalLines: state.totalLines,
			logFile: state.sink.path,
		}),
	);
}

function describeScriptStart(state: JobState): string {
	const options = state.options;
	const lines = [`Started ${options.kind} script "${options.name}".`, `Log: ${options.logFile}`];
	if (isMonitor(state)) {
		const monitor = state.options;
		lines.push(
			monitor.mode === "any"
				? "Every emitted line wakes you, batched."
				: `Emitted lines that match ${JSON.stringify(monitor.matchSource)} as a ${monitor.mode}${monitor.ignoreCase ? ", ignoring case" : ""} wake you.`,
		);
	}
	const deadline = options.timeoutMs > 0 ? ` It times out after ${formatDuration(options.timeoutMs)}.` : "";
	lines.push(
		options.notifyExit
			? `You will be woken once when it ends.${deadline}`
			: `It does not wake you when it ends.${deadline}`,
	);
	lines.push(
		`Read its log with ${options.kind} action=logs name=${options.name}. Stop it with ${options.kind} action=stop name=${options.name}.`,
		SCRIPT_LIFETIME_NOTE,
	);
	return lines.join("\n");
}

const SCRIPT_LIFETIME_NOTE =
	"Script jobs stop at /reload, session switch, and quit. Its tool calls run outside your turn.";

const SCRIPT_GLOBALS_TEXT =
	"The script calls pi tools and MCP tools through tools.<name>(args), logs lines with emit(text), and waits with sleep(ms). No searchTools, describeTool, or models; store() does not persist.";
const SCRIPT_LIFECYCLE_TEXT =
	"Script tool calls run outside your turn, so do not let a script edit files you edit. Script jobs stop at /reload, session switch, and quit.";

export const BACKGROUND_CODEMODE_DESCRIPTION = `Run a codemode script as a background job. ${SCRIPT_GLOBALS_TEXT} The tool returns at once; the exit wakes you with the result. ${SCRIPT_LIFECYCLE_TEXT} Use background, not this tool, to stop it or read its log.`;

export const MONITOR_CODEMODE_DESCRIPTION = `Run a codemode script as a monitor. Each emit(text) call is one line; lines that match wake you. Use sleep(ms) between checks. The script calls pi tools and MCP tools through tools.<name>(args). No searchTools, describeTool, or models; store() does not persist. ${SCRIPT_LIFECYCLE_TEXT} Use monitor, not this tool, to stop it or read its log.`;

const codeParameter = Type.String({
	description: `Codemode script: an async function body, at most ${SCRIPT_LIMITS.maxCodeChars} chars`,
});
const nameParameter = Type.Optional(Type.String({ description: "Job name; letters, digits, dot, dash, underscore" }));

export const backgroundCodemodeParameters = Type.Object({
	code: codeParameter,
	name: nameParameter,
	timeoutMs: Type.Optional(
		Type.Number({
			description: `Abort the script after this long; 0 disables (default 1800000, max ${LIMITS.maxTimeoutMs})`,
		}),
	),
	notifyExit: Type.Optional(Type.Boolean({ description: "Wake on exit with a digest (default true)" })),
});

const sameAsMonitor = "Same as monitor.";

export const monitorCodemodeParameters = Type.Object({
	code: codeParameter,
	name: nameParameter,
	match: Type.Optional(Type.String({ description: "Same as monitor. Without match, every emitted line wakes you" })),
	regex: Type.Optional(Type.Boolean({ description: sameAsMonitor })),
	ignoreCase: Type.Optional(Type.Boolean({ description: sameAsMonitor })),
	once: Type.Optional(Type.Boolean({ description: sameAsMonitor })),
	debounceMs: Type.Optional(Type.Number({ description: sameAsMonitor })),
	maxPerMinute: Type.Optional(Type.Number({ description: sameAsMonitor })),
	timeoutMs: Type.Optional(Type.Number({ description: "Abort the script after this long; 0 disables (default 0)" })),
});

interface ScriptToolDeps {
	reg: Registry;
	engine: EngineCache;
	maxScriptJobs: number;
	bindSession: (ctx: ExtensionToolContext) => void;
	onEngineLoad: () => void;
}

export function createScriptTools(deps: ScriptToolDeps) {
	const make = (kind: Kind) =>
		defineTool({
			name: `${kind}_codemode`,
			label: kind === "background" ? "Background Codemode" : "Monitor Codemode",
			description: kind === "background" ? BACKGROUND_CODEMODE_DESCRIPTION : MONITOR_CODEMODE_DESCRIPTION,
			promptSnippet:
				kind === "background"
					? "Run a codemode script as a background job that wakes you on exit"
					: "Run a codemode script whose emitted lines wake you on a match",
			// Scripts must not start scripts.
			exposure: "model-only",
			parameters: kind === "background" ? backgroundCodemodeParameters : monitorCodemodeParameters,
			async execute(_toolCallId, params, _signal, _onUpdate, extensionCtx) {
				deps.bindSession(extensionCtx);
				const text = await startScriptJob(kind, params as Record<string, unknown>, {
					reg: deps.reg,
					maxScriptJobs: deps.maxScriptJobs,
					ctx: extensionCtx,
					engine: deps.engine,
					onEngineLoad: deps.onEngineLoad,
				});
				return { content: [{ type: "text", text }], details: { kind } };
			},
		});
	return [make("background"), make("monitor")] as const;
}
