import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Kind = "monitor" | "background";
export type StreamName = "stdout" | "stderr";
/** `any` matches every line. Only script monitors without a match use it. */
export type MatchMode = "literal" | "regex" | "any";

interface BaseOptions {
	kind: Kind;
	name: string;
	command: string;
	cwd: string;
	timeoutMs: number;
	notifyExit: boolean;
	logFile: string;
	logMaxBytes: number;
	/** The name came from `<kind>-<n>`, so it does not say what the job runs. */
	generatedName?: boolean;
}

interface MonitorExtras {
	mode: MatchMode;
	matchSource: string;
	ignoreCase: boolean;
	streams: Set<StreamName>;
	once: boolean;
	debounceMs: number;
	maxPerMinute: number;
	muteCooldownMs: number;
}

export type JobOptions = BaseOptions & Partial<MonitorExtras>;
export type MonitorOptions = BaseOptions & MonitorExtras;

export const LIMITS = {
	maxActiveJobs: 12,
	completedKept: 30,
	memTailLines: 400,
	maxStoredLineChars: 4_000,
	splitterMaxLineChars: 16_000,
	matchQueueMax: 200,
	matchDeadlineMs: 1_000,
	workerStartMs: 3_000,
	muteCooldownMs: 60_000,
	muteCycleMax: 3,
	unkillablePollMs: 2_000,
	maxCommandChars: 8_000,
	maxNameChars: 64,
	maxMatchChars: 500,
	maxTimeoutMs: 24 * 60 * 60_000,
	defaultBackgroundTimeoutMs: 30 * 60_000,
	defaultDebounceMs: 250,
	maxDebounceMs: 60_000,
	defaultMaxPerMinute: 6,
	maxMaxPerMinute: 600,
	logMaxBytes: 32 * 1024 * 1024,
	logTailBytes: 512 * 1024,
	killGraceMs: 2_000,
	stopAfterKillMs: 1_000,
	quitAfterKillMs: 500,
} as const;

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_NAMES = new Set(["all", "none", "self"]);

// Patterns that match every non-empty line. A catch-all wakes the agent once per output line.
const CATCH_ALL_SOURCES = new Set([
	".",
	".+",
	".*",
	".+?",
	".*?",
	"^",
	"$",
	"^.*$",
	"^.+$",
	"[\\s\\S]+",
	"[^]+",
	"\\S|\\s",
]);

// A literal goes to String.includes, which has no escapes. A literal that looks like a pattern
// is rejected, because "FAILED|passed" as a literal never fires.
const REGEX_METACHARS = /[\\^$.|?*+()[\]{}]/;

// Nested unbounded quantifiers and quantified alternations are the classic exponential shapes.
export function hasNestedQuantifier(source: string): boolean {
	for (let index = 0; index < source.length; index++) {
		if (source[index] !== "(" || source[index - 1] === "\\") continue;
		let depth = 0;
		let end = -1;
		for (let scan = index; scan < source.length; scan++) {
			if (source[scan] === "\\") {
				scan++;
				continue;
			}
			if (source[scan] === "(") depth++;
			else if (source[scan] === ")") {
				depth--;
				if (depth === 0) {
					end = scan;
					break;
				}
			}
		}
		if (end === -1) continue;
		if (!/^(?:[*+]|\{\d+,\}?)/.test(source.slice(end + 1))) continue;
		const body = source.slice(index + 1, end).replace(/\\./g, "");
		if (/[*+]|\{\d+,\}/.test(body) || body.includes("|")) return true;
	}
	return false;
}

// Recursive mkdirSync hangs instead of failing under these pseudo-filesystems.
const FORBIDDEN_LOG_ROOTS = ["/proc", "/sys", "/dev", "/run"];

export interface BuildDeps {
	defaultCwd: string;
	nextId: () => number;
	isNameTaken: (name: string) => string | undefined;
	isLogFileTaken: (file: string) => string | undefined;
	activeCount: () => number;
	dirExists: (dir: string) => boolean;
	/** A monitor without match matches every line instead of failing. */
	matchAnyWithoutMatch?: boolean;
}

export function buildOptions(kind: Kind, raw: Record<string, unknown>, deps: BuildDeps): JobOptions | string {
	if (deps.activeCount() >= LIMITS.maxActiveJobs) {
		return `Too many active jobs (${LIMITS.maxActiveJobs}). Stop one before starting another.`;
	}

	const command = str(raw["command"]).trim();
	if (!command) return "Missing required command";
	if (command.length > LIMITS.maxCommandChars)
		return `Command is too long (${command.length} chars, max ${LIMITS.maxCommandChars})`;

	const name = resolveName(kind, raw["name"], deps);
	if (typeof name !== "string") return name.error;

	const cwdRaw = str(raw["cwd"]).trim();
	const cwd = cwdRaw ? (path.isAbsolute(cwdRaw) ? cwdRaw : path.resolve(deps.defaultCwd, cwdRaw)) : deps.defaultCwd;
	if (!deps.dirExists(cwd)) return `Working directory does not exist: ${cwd}`;

	const logFile = resolveLogFile(raw["logFile"], name, kind, cwd);
	const forbidden = FORBIDDEN_LOG_ROOTS.find((root) => logFile === root || logFile.startsWith(`${root}/`));
	if (forbidden) return `Log file cannot live under ${forbidden}: ${logFile}`;
	const logConflict = deps.isLogFileTaken(logFile);
	if (logConflict) return `Log file is already used by active job "${logConflict}": ${logFile}`;

	const timeoutMs = numberIn(
		raw["timeoutMs"],
		kind === "background" ? LIMITS.defaultBackgroundTimeoutMs : 0,
		0,
		LIMITS.maxTimeoutMs,
	);
	if (typeof timeoutMs !== "number") return timeoutMs.error;

	const base: BaseOptions = {
		kind,
		name,
		command,
		cwd,
		timeoutMs,
		notifyExit: raw["notifyExit"] !== false,
		logFile,
		logMaxBytes: LIMITS.logMaxBytes,
		...(str(raw["name"]).trim() === "" ? { generatedName: true } : {}),
	};

	if (kind === "background") return base;

	const extras = buildMonitorExtras(raw, deps.matchAnyWithoutMatch === true);
	return typeof extras === "string" ? extras : { ...base, ...extras };
}

function buildMonitorExtras(raw: Record<string, unknown>, matchAnyWithoutMatch: boolean): MonitorExtras | string {
	const compiled =
		matchAnyWithoutMatch && str(raw["match"]) === ""
			? ({ mode: "any", source: "", ignoreCase: false } as const)
			: compileMatch(raw["match"], raw["ignoreCase"] === true, raw["regex"] === true);
	if (typeof compiled === "string") return compiled;

	const streams = parseStreams(raw["stream"] === undefined ? "stdout" : str(raw["stream"]));
	if (typeof streams === "string") return streams;

	const debounceMs = numberIn(raw["debounceMs"], LIMITS.defaultDebounceMs, 0, LIMITS.maxDebounceMs);
	if (typeof debounceMs !== "number") return debounceMs.error;

	const maxPerMinute = numberIn(raw["maxPerMinute"], LIMITS.defaultMaxPerMinute, 1, LIMITS.maxMaxPerMinute);
	if (typeof maxPerMinute !== "number") return maxPerMinute.error;

	return {
		mode: compiled.mode,
		matchSource: compiled.source,
		ignoreCase: compiled.ignoreCase,
		streams,
		once: raw["once"] === true,
		debounceMs,
		maxPerMinute,
		// Not in the tool schema. Tests shorten it.
		muteCooldownMs: LIMITS.muteCooldownMs,
	};
}

export interface MonitorEdit {
	mode?: MatchMode;
	matchSource?: string;
	ignoreCase?: boolean;
	streams?: Set<StreamName>;
	once?: boolean;
	notifyExit?: boolean;
	debounceMs?: number;
	maxPerMinute?: number;
	timeoutMs?: number;
}

export function parseMonitorEdit(raw: Record<string, unknown>, current: MonitorOptions): MonitorEdit | string {
	const updates: MonitorEdit = {};
	if (raw["match"] !== undefined || raw["ignoreCase"] !== undefined || raw["regex"] !== undefined) {
		if (current.mode === "any" && raw["match"] === undefined)
			return `"${current.name}" matches every line. ignoreCase and regex need match; pass match too.`;
		const source = raw["match"] === undefined ? current.matchSource : raw["match"];
		const ignoreCase = raw["ignoreCase"] === undefined ? current.ignoreCase : raw["ignoreCase"] === true;
		const asRegex = raw["regex"] === undefined ? current.mode === "regex" : raw["regex"] === true;
		const compiled = compileMatch(source, ignoreCase, asRegex);
		if (typeof compiled === "string") return compiled;
		updates.mode = compiled.mode;
		updates.matchSource = compiled.source;
		updates.ignoreCase = compiled.ignoreCase;
	}
	if (raw["stream"] !== undefined) {
		const streams = parseStreams(str(raw["stream"]));
		if (typeof streams === "string") return streams;
		updates.streams = streams;
	}
	if (raw["once"] !== undefined) updates.once = raw["once"] === true;
	if (raw["notifyExit"] !== undefined) updates.notifyExit = raw["notifyExit"] !== false;
	if (raw["debounceMs"] !== undefined) {
		const value = numberIn(raw["debounceMs"], LIMITS.defaultDebounceMs, 0, LIMITS.maxDebounceMs);
		if (typeof value !== "number") return value.error;
		updates.debounceMs = value;
	}
	if (raw["maxPerMinute"] !== undefined) {
		const value = numberIn(raw["maxPerMinute"], LIMITS.defaultMaxPerMinute, 1, LIMITS.maxMaxPerMinute);
		if (typeof value !== "number") return value.error;
		updates.maxPerMinute = value;
	}
	if (raw["timeoutMs"] !== undefined) {
		const value = numberIn(raw["timeoutMs"], 0, 0, LIMITS.maxTimeoutMs);
		if (typeof value !== "number") return value.error;
		updates.timeoutMs = value;
	}
	if (Object.keys(updates).length === 0)
		return "Nothing to edit. Pass at least one of match, regex, ignoreCase, stream, once, notifyExit, debounceMs, maxPerMinute, timeoutMs.";
	return updates;
}

interface CompiledMatch {
	mode: MatchMode;
	source: string;
	ignoreCase: boolean;
}

export function compileMatch(rawSource: unknown, ignoreCase: boolean, asRegex: boolean): CompiledMatch | string {
	const source = str(rawSource);
	if (!source.trim())
		return "monitor requires match. There is no default, because a default wakes the agent on every line.";
	if (source.length > LIMITS.maxMatchChars)
		return `match is too long (${source.length} chars, max ${LIMITS.maxMatchChars})`;

	if (!asRegex) {
		const meta = REGEX_METACHARS.exec(source);
		if (meta) {
			return `match is a literal substring by default and contains the regex character ${JSON.stringify(meta[0])}. Backslashes are not escapes here; String.includes has no escaping. Pass regex=true to match it as a regex.`;
		}
		return { mode: "literal", source, ignoreCase };
	}

	if (CATCH_ALL_SOURCES.has(source.trim()))
		return `regex "${source}" fires on every line. Give a pattern that only appears in the event you care about.`;
	if (hasNestedQuantifier(source)) {
		return `regex "${source}" nests unbounded quantifiers, the classic exponential-backtracking shape. Rewrite it without a quantified group whose body is also unbounded.`;
	}
	let compiled: RegExp;
	try {
		// No global or sticky flag: lastIndex state across lines would skip matches.
		compiled = new RegExp(source, ignoreCase ? "i" : "");
	} catch (error) {
		return `Invalid match regex: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (compiled.test("")) return `regex "${source}" also matches an empty line, so it fires on every line. Narrow it.`;
	return { mode: "regex", source, ignoreCase };
}

export function parseStreams(value: string): Set<StreamName> | string {
	if (value === "stdout") return new Set<StreamName>(["stdout"]);
	if (value === "stderr") return new Set<StreamName>(["stderr"]);
	if (value === "both") return new Set<StreamName>(["stdout", "stderr"]);
	return "stream must be stdout, stderr, or both";
}

export function resolveLogFile(value: unknown, name: string, kind: Kind, cwd: string): string {
	const raw = str(value).trim();
	if (!raw) return path.join(defaultLogDir(), `${kind}-${safeFileName(name)}-${Date.now()}.log`);
	// Relative paths resolve against the job cwd, not the process cwd.
	return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);
}

export function defaultLogDir(): string {
	return path.join(os.tmpdir(), "pi-background-logs");
}

/** The newest default log of a job with this name, also from an earlier pi process. */
export function newestDefaultLog(name: string): string | undefined {
	let entries: string[];
	try {
		entries = fs.readdirSync(defaultLogDir());
	} catch {
		return undefined;
	}
	const safe = safeFileName(name).replace(/[.]/g, "\\.");
	const pattern = new RegExp(`^(?:background|monitor)-${safe}-(\\d+)\\.log$`);
	let newest: { file: string; stamp: number } | undefined;
	for (const entry of entries) {
		const stamp = Number(pattern.exec(entry)?.[1] ?? Number.NaN);
		if (Number.isFinite(stamp) && (!newest || stamp > newest.stamp)) newest = { file: entry, stamp };
	}
	return newest ? path.join(defaultLogDir(), newest.file) : undefined;
}

export function safeFileName(name: string): string {
	return name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, LIMITS.maxNameChars);
}

function resolveName(kind: Kind, rawName: unknown, deps: BuildDeps): string | { error: string } {
	const given = str(rawName).trim();
	if (!given) {
		for (let attempt = 0; attempt < 1_000; attempt++) {
			const candidate = `${kind}-${deps.nextId()}`;
			if (!deps.isNameTaken(candidate)) return candidate;
		}
		return { error: "Could not allocate a job name" };
	}
	if (given.length > LIMITS.maxNameChars) return { error: `name is too long (max ${LIMITS.maxNameChars} chars)` };
	if (RESERVED_NAMES.has(given.toLowerCase())) return { error: `name "${given}" is reserved` };
	if (!NAME_PATTERN.test(given))
		return {
			error: `name "${given}" is invalid. Use letters, digits, dot, dash, underscore; start with a letter or digit.`,
		};
	const taken = deps.isNameTaken(given);
	if (taken) return { error: `A ${taken} job named "${given}" is already running. Stop it or pick another name.` };
	return given;
}

function numberIn(value: unknown, fallback: number, min: number, max: number): number | { error: string } {
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return { error: `Expected a number, got ${JSON.stringify(value)}` };
	if (parsed < min || parsed > max) return { error: `Value ${parsed} is out of range (${min}..${max})` };
	return Math.round(parsed);
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}
