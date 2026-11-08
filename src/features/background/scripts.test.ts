import { statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import { Value } from "typebox/value";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { planFeature } from "../../core/config.ts";
import { background } from "./index.ts";
import { LogSink } from "./logsink.ts";
import { createMatcher } from "./matcher.ts";
import { buildOptions, type BuildDeps, LIMITS } from "./options.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
	createEngineCache,
	type LoadedEngine,
	ownEngineVersion,
	runScript,
	versionSkewWarning,
} from "./script-engine.ts";
import {
	BACKGROUND_CODEMODE_DESCRIPTION,
	backgroundCodemodeParameters,
	createScriptStore,
	createScriptTools,
	emitLine,
	MONITOR_CODEMODE_DESCRIPTION,
	monitorCodemodeParameters,
	SCRIPT_LIMITS,
	sleepMs,
	startScriptJob,
	takeStoppedNotice,
	toScriptValue,
} from "./scripts.ts";
import { createRegistry, describeOptions } from "./registry.ts";

const root = mkdtempSync(join(tmpdir(), "pimon-scripts-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function outcome(text: string, isError: boolean, structuredContent?: unknown): AgentToolCallOutcome {
	return {
		toolCall: { type: "toolCall", id: "c1", name: "t", arguments: {} },
		result: {
			content: text ? [{ type: "text", text }] : [],
			details: {},
			...(structuredContent === undefined ? {} : { structuredContent: structuredContent as never }),
		},
		isError,
	};
}

describe("script tool results", () => {
	it("resolves to the text parts joined by newlines", () => {
		const value = toScriptValue(
			{ name: "t" },
			{
				...outcome("", false),
				result: {
					content: [
						{ type: "text", text: "a" },
						{ type: "text", text: "b" },
					],
					details: {},
				},
			},
		);
		expect(value).toBe("a\nb");
	});

	it("rejects with the result text when the result is an error", () => {
		expect(() => toScriptValue({ name: "t" }, outcome("no such file", true))).toThrow("no such file");
		expect(() => toScriptValue({ name: "t" }, outcome("", true))).toThrow('Tool "t" failed');
	});

	it("resolves a tool with an output schema to its structured content, also on error, as pi's codemode does", () => {
		const schema = { type: "object" };
		expect(toScriptValue({ name: "t", outputSchema: schema }, outcome("x", true, { ok: false }))).toEqual({
			ok: false,
		});
		expect(toScriptValue({ name: "t", outputSchema: schema }, outcome("x", false, { ok: true }))).toEqual({ ok: true });
		expect(toScriptValue({ name: "t" }, outcome("x", false, { ok: true }))).toBe("x");
	});
});

describe("script globals", () => {
	it("emit keeps one line and cuts long text with a mark", () => {
		expect(emitLine("ready")).toBe("ready");
		expect(emitLine("a\nb\r\nc")).toBe("a\\nb\\nc");
		const cut = emitLine("x".repeat(20_000));
		expect(cut).toHaveLength(SCRIPT_LIMITS.maxEmitChars);
		expect(cut.endsWith("[cut]")).toBe(true);
		expect(emitLine("y".repeat(SCRIPT_LIMITS.maxEmitChars))).toHaveLength(SCRIPT_LIMITS.maxEmitChars);
		expect(() => emitLine(5)).toThrow("emit(text) takes a string");
	});

	it.each([0, 0.5, 3_600_001, Number.NaN, "5", undefined])("sleep refuses %j", (value) => {
		expect(() => sleepMs(value)).toThrow("sleep(ms) takes 1 to 3600000 ms");
	});

	it("sleep accepts 1 to 3600000 ms", () => {
		expect(sleepMs(1)).toBe(1);
		expect(sleepMs(3_600_000)).toBe(3_600_000);
	});
});

describe("script monitor options", () => {
	it("list the same fields with and without match", () => {
		const base = {
			kind: "monitor",
			name: "m",
			command: "script: x",
			cwd: root,
			timeoutMs: 0,
			notifyExit: false,
			logFile: join(root, "m.log"),
			logMaxBytes: 1024,
			streams: new Set(["stdout"]),
			once: false,
			debounceMs: 250,
			maxPerMinute: 20,
			ignoreCase: false,
		} as const;
		expect(describeOptions({ ...base, mode: "any", matchSource: "" } as never)).toBe(
			"match=every line; streams=stdout; once=false; debounceMs=250; maxPerMinute=20; timeoutMs=0",
		);
		expect(describeOptions({ ...base, mode: "literal", matchSource: "a" } as never)).toBe(
			'match="a" (literal); streams=stdout; once=false; debounceMs=250; maxPerMinute=20; timeoutMs=0',
		);
	});
});

describe("stopped script notices", () => {
	it("names the reason and shows once", () => {
		const store = createScriptStore();
		store.stopped.set("s1", { reason: "reload", names: ["a", "b"] });
		store.stopped.set("s2", { reason: "resume", names: ["c"] });
		expect(takeStoppedNotice(store, "s1")).toBe("Script jobs stopped at reload: a, b");
		expect(takeStoppedNotice(store, "s1")).toBeUndefined();
		expect(takeStoppedNotice(store, "s2")).toBe("Script jobs stopped at session switch: c");
		expect(takeStoppedNotice(store, "s3")).toBeUndefined();
	});
});

describe("script tools", () => {
	const tools = createScriptTools({
		reg: createRegistry(root),
		engine: createEngineCache(),
		maxScriptJobs: 4,
		bindSession: () => {},
		onEngineLoad: () => {},
	});

	it("are model-only, so scripts cannot start scripts", () => {
		expect(tools.map((tool) => [tool.name, tool.exposure])).toEqual([
			["background_codemode", "model-only"],
			["monitor_codemode", "model-only"],
		]);
	});

	it("say what a script can do and when it stops", () => {
		expect(BACKGROUND_CODEMODE_DESCRIPTION).toBe(
			"Run a codemode script as a background job. The script calls pi tools and MCP tools through tools.<name>(args), logs lines with emit(text), and waits with sleep(ms). No searchTools, describeTool, or models; store() does not persist. The tool returns at once; the exit wakes you with the result. Script tool calls run outside your turn, so do not let a script edit files you edit. Script jobs stop at /reload, session switch, and quit. Use background, not this tool, to stop it or read its log.",
		);
		expect(MONITOR_CODEMODE_DESCRIPTION).toBe(
			"Run a codemode script as a monitor. Each emit(text) call is one line; lines that match wake you. Use sleep(ms) between checks. The script calls pi tools and MCP tools through tools.<name>(args). No searchTools, describeTool, or models; store() does not persist. Script tool calls run outside your turn, so do not let a script edit files you edit. Script jobs stop at /reload, session switch, and quit. Use monitor, not this tool, to stop it or read its log.",
		);
	});

	it("require code and take the monitor options", () => {
		expect(Value.Check(backgroundCodemodeParameters, { code: "return 1" })).toBe(true);
		expect(Value.Check(backgroundCodemodeParameters, {})).toBe(false);
		expect(Value.Check(backgroundCodemodeParameters, { code: "x", match: "y" })).toBe(true);
		expect(Object.keys(backgroundCodemodeParameters.properties)).toEqual(["code", "name", "timeoutMs", "notifyExit"]);
		expect(Object.keys(monitorCodemodeParameters.properties)).toEqual([
			"code",
			"name",
			"match",
			"regex",
			"ignoreCase",
			"once",
			"debounceMs",
			"maxPerMinute",
			"timeoutMs",
		]);
	});

	it("allow 1 to 16 script jobs, 4 by default", () => {
		expect(planFeature(background, undefined)).toMatchObject({ state: "enabled", config: { maxScriptJobs: 4 } });
		expect(planFeature(background, { maxScriptJobs: 16 })).toMatchObject({ state: "enabled" });
		expect(planFeature(background, { maxScriptJobs: 0 })).toMatchObject({ state: "invalid" });
		expect(planFeature(background, { maxScriptJobs: 17 })).toMatchObject({ state: "invalid" });
	});
});

describe("script monitor matching", () => {
	const deps: BuildDeps = {
		defaultCwd: root,
		nextId: () => 1,
		isNameTaken: () => undefined,
		isLogFileTaken: () => undefined,
		activeCount: () => 0,
		dirExists: () => true,
	};

	it("matches every line when a script monitor has no match", () => {
		const options = buildOptions("monitor", { command: "script: x" }, { ...deps, matchAnyWithoutMatch: true });
		expect(options).toMatchObject({ mode: "any", matchSource: "", timeoutMs: 0 });
		expect(buildOptions("monitor", { command: "x" }, deps)).toBe(
			"monitor requires match. There is no default, because a default wakes the agent on every line.",
		);
		const seen: string[] = [];
		const matcher = createMatcher("any", "", false, { onMatch: (line) => seen.push(line), onFailure: () => {} });
		matcher.push("a");
		matcher.push("");
		matcher.dispose();
		matcher.push("b");
		expect(seen).toEqual(["a", ""]);
	});

	it("keeps the shell defaults for a script background job", () => {
		expect(buildOptions("background", { command: "script: x" }, deps)).toMatchObject({
			timeoutMs: LIMITS.defaultBackgroundTimeoutMs,
			notifyExit: true,
		});
	});
});

describe("script engine", () => {
	function spyEngine(seen: Record<string, unknown>[]): LoadedEngine {
		class FakeSandbox {
			constructor(options: Record<string, unknown>) {
				seen.push(options);
			}
			execute = async () => ({ ok: true, value: undefined, output: [], calls: [] });
			close = async () => {};
		}
		return { module: { CodemodeSandbox: FakeSandbox } as never, wasm: Promise.resolve({}) };
	}

	it("passes a 128 MiB limit and no deadline for timeoutMs 0 to the sandbox", async () => {
		const seen: Record<string, unknown>[] = [];
		const run = { code: "1", tools: [], globals: [], signal: new AbortController().signal };
		await runScript(spyEngine(seen), { ...run, timeoutMs: 0 });
		await runScript(spyEngine(seen), { ...run, timeoutMs: 200 });
		expect(seen.map((options) => [options["memoryLimitBytes"], options["timeoutMs"]])).toEqual([
			[128 * 1024 * 1024, Number.POSITIVE_INFINITY],
			[128 * 1024 * 1024, 200],
		]);
	});

	it("refuses code over 100000 chars without loading the sandbox", async () => {
		const engine = createEngineCache();
		const ctx = { cwd: root, tools: [], executeTool: async () => ({}) } as unknown as ExtensionToolContext;
		await expect(
			startScriptJob(
				"background",
				{ code: "x".repeat(100_001) },
				{ reg: createRegistry(root), maxScriptJobs: 4, ctx, engine },
			),
		).rejects.toThrow("code is too long (100001 chars, max 100000)");
		expect(engine.loaded).toBe(false);
	});

	it("finds the version of its own sandbox package", () => {
		expect(ownEngineVersion()).toBe("1.5.0");
	});

	it("warns only on a different major or minor version", () => {
		expect(versionSkewWarning("1.5.0", "1.5.3")).toBeUndefined();
		expect(versionSkewWarning("1.5.0", undefined)).toBeUndefined();
		expect(versionSkewWarning("1.5.0", "1.6.0")).toBe(
			"Script jobs use @earendil-works/pi-codemode 1.5.0, but pi ships 1.6.0. Scripts can behave differently from pi's codemode tool. Update pimon's dependency to match pi.",
		);
		expect(versionSkewWarning("1.5.0", "2.5.0")).toBeDefined();
	});
});

describe("script log file", () => {
	it("is created with mode 0600 when a mode is given", () => {
		const file = join(root, "script.log");
		const sink = new LogSink(file, 1024, {}, 0o600);
		sink.open("# header");
		sink.close();
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});
});
