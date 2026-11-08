import { describe, expect, it } from "vite-plus/test";
import {
	type BuildDeps,
	buildOptions,
	compileMatch,
	hasNestedQuantifier,
	type JobOptions,
	LIMITS,
	type MonitorOptions,
	parseMonitorEdit,
	parseStreams,
	resolveLogFile,
	safeFileName,
} from "./options.ts";

function deps(over: Partial<BuildDeps> = {}): BuildDeps {
	let n = 0;
	return {
		defaultCwd: "/tmp",
		nextId: () => ++n,
		isNameTaken: () => undefined,
		isLogFileTaken: () => undefined,
		activeCount: () => 0,
		dirExists: () => true,
		...over,
	};
}

function built(kind: "background" | "monitor", raw: Record<string, unknown>, over?: Partial<BuildDeps>): JobOptions {
	const result = buildOptions(kind, raw, deps(over));
	if (typeof result === "string") throw new Error(result);
	return result;
}

const rejects = (kind: "background" | "monitor", raw: Record<string, unknown>, over?: Partial<BuildDeps>) =>
	typeof buildOptions(kind, raw, deps(over)) === "string";

describe("literal matching contract", () => {
	it("rejects a missing or empty match", () => {
		expect(typeof compileMatch(undefined, false, false)).toBe("string");
		expect(typeof compileMatch("   ", false, false)).toBe("string");
	});

	it("accepts a plain phrase as a literal", () => {
		expect(compileMatch("All checks passed", false, false)).toMatchObject({ mode: "literal" });
	});

	it.each(["FAILED|passed", "port \\d+", "a.b", "x*", "^start", "end$", "(group)", "[abc]", "a{2}", "a+", "a?"])(
		"literal rejects %j and points at regex=true",
		(meta) => {
			expect(compileMatch(meta, false, false)).toEqual(expect.stringContaining("regex=true"));
		},
	);

	it("literal rejection does not promise backslash escaping", () => {
		expect(compileMatch("a.b", false, false)).toEqual(expect.stringContaining("no escaping"));
	});

	it("literal honors ignoreCase", () => {
		expect(compileMatch("failed", true, false)).toEqual({ mode: "literal", source: "failed", ignoreCase: true });
	});

	it("parseStreams accepts both and rejects junk", () => {
		expect(parseStreams("both")).toEqual(new Set(["stdout", "stderr"]));
		expect(typeof parseStreams("stdin")).toBe("string");
	});
});

describe("regex opt-in and ReDoS rejection", () => {
	it("accepts an alternation as a regex", () => {
		expect(compileMatch("FAILED|passed", false, true)).toMatchObject({ mode: "regex" });
	});

	it.each([".+", ".*", "^", "a?", "([", "a".repeat(LIMITS.maxMatchChars + 1)])(
		"rejects catch-all, empty-matching, invalid, or overlong regex %j",
		(bad) => {
			expect(typeof compileMatch(bad, false, true)).toBe("string");
		},
	);

	it.each(["(a+)+b", "(a*)*b", "(a|aa)+$", "(\\s*)*x", "([a-zA-Z]+)*!", "(foo+)+bar"])(
		"rejects nested quantifier %s",
		(bad) => {
			expect(compileMatch(bad, false, true)).toEqual(expect.stringContaining("exponential"));
		},
	);

	it.each([
		"FAILED|passed",
		"All checks (passed|failed)",
		"\\berror\\b",
		"Listening on port \\d+",
		"^\\s*at .*\\.ts:\\d+",
		"(ERROR|WARN): [a-z]+",
		"Tests:\\s+\\d+ failed",
	])("accepts realistic regex %s", (good) => {
		expect(typeof compileMatch(good, false, true)).toBe("object");
	});

	it("hasNestedQuantifier flags only quantified groups with unbounded bodies", () => {
		expect(hasNestedQuantifier("(passed|failed)")).toBe(false);
		expect(hasNestedQuantifier("(a+)b")).toBe(false);
		expect(hasNestedQuantifier("(a|aa)+")).toBe(true);
		expect(hasNestedQuantifier("(a+){2,}")).toBe(true);
	});
});

describe("buildOptions", () => {
	it("background needs a command and no match", () => {
		expect(buildOptions("background", {}, deps())).toBe("Missing required command");
		expect(rejects("monitor", { command: "x" })).toBe(true);
		const bg = built("background", { command: "pnpm test" });
		expect(bg.name).toBe("background-1");
		expect(bg.timeoutMs).toBe(LIMITS.defaultBackgroundTimeoutMs);
		expect(bg.notifyExit).toBe(true);
		expect(bg.mode).toBeUndefined();
		expect(bg.matchSource).toBeUndefined();
	});

	it("monitor defaults", () => {
		const mon = built("monitor", { command: "tail -f x", match: "ERROR " });
		expect(mon.mode).toBe("literal");
		expect(built("monitor", { command: "x", match: "a|b", regex: true }).mode).toBe("regex");
		expect(mon.streams).toEqual(new Set(["stdout"]));
		expect(mon.timeoutMs).toBe(0);
		expect(mon.debounceMs).toBe(LIMITS.defaultDebounceMs);
		expect(mon.maxPerMinute).toBe(6);
		expect(built("monitor", { command: "x", match: "y", maxPerMinute: 600 }).maxPerMinute).toBe(600);
	});

	it("validates names", () => {
		expect(rejects("background", { command: "x", name: "all" })).toBe(true);
		expect(rejects("background", { command: "x", name: "a/b" })).toBe(true);
		expect(rejects("background", { command: "x", name: ".hidden" })).toBe(true);
		expect(rejects("background", { command: "x", name: "a.b-c_1" })).toBe(false);
		expect(rejects("background", { command: "x", name: "a".repeat(LIMITS.maxNameChars + 1) })).toBe(true);
	});

	it("reports which kind holds a taken name, and which job holds a log file", () => {
		expect(buildOptions("background", { command: "x", name: "dup" }, deps({ isNameTaken: () => "monitor" }))).toEqual(
			expect.stringContaining("monitor"),
		);
		expect(
			buildOptions("background", { command: "x", logFile: "/tmp/shared.log" }, deps({ isLogFileTaken: () => "other" })),
		).toEqual(expect.stringContaining("other"));
	});

	it("rejects bad cwd, command, timeout, job count, rate limit, and debounce", () => {
		expect(rejects("background", { command: "x", cwd: "/nope" }, { dirExists: () => false })).toBe(true);
		expect(rejects("background", { command: "x".repeat(LIMITS.maxCommandChars + 1) })).toBe(true);
		expect(rejects("background", { command: "x", timeoutMs: "soon" })).toBe(true);
		expect(rejects("background", { command: "x", timeoutMs: -1 })).toBe(true);
		expect(rejects("background", { command: "x", timeoutMs: LIMITS.maxTimeoutMs + 1 })).toBe(true);
		expect(rejects("background", { command: "x" }, { activeCount: () => LIMITS.maxActiveJobs })).toBe(true);
		expect(rejects("monitor", { command: "x", match: "y", maxPerMinute: 0 })).toBe(true);
		expect(rejects("monitor", { command: "x", match: "y", debounceMs: LIMITS.maxDebounceMs + 1 })).toBe(true);
	});

	it("has no separate match length cap: monitors match the whole split line", () => {
		expect(LIMITS).not.toHaveProperty("matchTestChars");
		expect(LIMITS.splitterMaxLineChars).toBe(16_000);
	});

	it("resolves log paths", () => {
		expect(built("background", { command: "x", cwd: "/tmp", logFile: "out.log" }).logFile).toBe("/tmp/out.log");
		expect(built("background", { command: "x" }).logFile).toContain("pi-background-logs");
		expect(safeFileName("a/b c")).toBe("a_b_c");
		expect(resolveLogFile("/tmp/../tmp/a.log", "n", "background", "/tmp")).toBe("/tmp/a.log");
	});

	it.each(["/proc", "/sys", "/dev", "/run"])("rejects a log file under %s", (root) => {
		expect(buildOptions("background", { command: "x", logFile: `${root}/pi/x.log` }, deps())).toEqual(
			expect.stringContaining(root),
		);
	});

	it("allows a log path that merely mentions proc", () => {
		expect(rejects("background", { command: "x", logFile: "/tmp/proc-notes.log" })).toBe(false);
	});
});

describe("parseMonitorEdit", () => {
	const current = built("monitor", { command: "x", match: "boom" }) as MonitorOptions;

	it("rejects an empty, catch-all, or metacharacter literal edit", () => {
		expect(typeof parseMonitorEdit({}, current)).toBe("string");
		expect(typeof parseMonitorEdit({ match: ".*", regex: true }, current)).toBe("string");
		expect(typeof parseMonitorEdit({ match: "a|b" }, current)).toBe("string");
	});

	it("ignoreCase alone keeps the existing pattern and mode", () => {
		expect(parseMonitorEdit({ ignoreCase: true }, current)).toEqual({
			ignoreCase: true,
			matchSource: "boom",
			mode: "literal",
		});
	});

	it("can switch a literal to a regex", () => {
		expect(parseMonitorEdit({ match: "a|b", regex: true }, current)).toMatchObject({ mode: "regex" });
	});

	it("accepts rate-limit and timeout changes and rejects out-of-range values", () => {
		expect(parseMonitorEdit({ maxPerMinute: 100 }, current)).toEqual({ maxPerMinute: 100 });
		expect(typeof parseMonitorEdit({ maxPerMinute: 10_000 }, current)).toBe("string");
		expect(parseMonitorEdit({ timeoutMs: 1_000 }, current)).toEqual({ timeoutMs: 1_000 });
	});
});
