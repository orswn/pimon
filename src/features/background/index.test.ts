import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import {
	BACKGROUND_DESCRIPTION,
	backgroundParameters,
	LIFETIME_NOTE,
	MONITOR_DESCRIPTION,
	monitorParameters,
	parseCliParams,
	sessionStartNotice,
	tokenize,
} from "./index.ts";
import { LIMITS } from "./options.ts";
import { createRegistry, type JobState } from "./registry.ts";

function fakeJob(name: string, sessionId: string): JobState {
	return { options: { name, kind: "background" }, sessionId } as unknown as JobState;
}

describe("session start notices", () => {
	const reg = createRegistry("/agent");
	reg.active.set("mine", fakeJob("mine", "s1"));
	reg.active.set("theirs", fakeJob("theirs", "s0"));
	reg.active.set("other", fakeJob("other", "s0"));
	reg.sessionId = "s1";

	it("counts kept jobs on reload", () => {
		expect(sessionStartNotice(reg, "reload")).toBe("Kept 3 running job(s) across reload");
	});

	it.each(["new", "resume", "fork"])("names jobs from another session on %s", (reason) => {
		expect(sessionStartNotice(reg, reason)).toBe(
			"2 job(s) from another session are still running: theirs, other. Their digests show here as notices only.",
		);
	});

	it("says nothing at startup or with no jobs", () => {
		expect(sessionStartNotice(reg, "startup")).toBeUndefined();
		expect(sessionStartNotice(createRegistry("/agent"), "reload")).toBeUndefined();
		expect(sessionStartNotice(createRegistry("/agent"), "new")).toBeUndefined();
	});
});

describe("tool text", () => {
	it("describes the true lifetime of a job", () => {
		expect(LIFETIME_NOTE).toBe(
			"It keeps running across reloads and session switches until it exits, times out, or is stopped. pi quit stops it. Only this session is woken by it.",
		);
	});

	it("background tells servers to disable the timeout", () => {
		expect(BACKGROUND_DESCRIPTION).toContain("Pass timeoutMs=0 for a server that should run until stopped.");
		expect(MONITOR_DESCRIPTION).toContain("match is a literal substring by default");
	});
});

describe("schemas", () => {
	it("background accepts only its own actions", () => {
		expect(Value.Check(backgroundParameters, { action: "logs", name: "x" })).toBe(true);
		expect(Value.Check(backgroundParameters, { action: "edit" })).toBe(false);
		expect(Value.Check(backgroundParameters, { action: "restart" })).toBe(false);
	});

	it("monitor accepts edit and checks the stream enum", () => {
		expect(Value.Check(monitorParameters, { action: "edit", stream: "both" })).toBe(true);
		expect(Value.Check(monitorParameters, { action: "start", stream: "stdin" })).toBe(false);
	});

	it("numeric fields keep accepting fractions, which the options code rounds", () => {
		expect(Value.Check(monitorParameters, { action: "start", debounceMs: 12.5 })).toBe(true);
		expect(LIMITS.defaultDebounceMs).toBe(250);
	});
});

describe("CLI parsing", () => {
	it("parses a start with flags and a command after --", () => {
		expect(parseCliParams("monitor", "start", "--name pr --match 'All checks passed' -- gh pr checks 1")).toEqual({
			action: "start",
			command: "gh pr checks 1",
			name: "pr",
			match: "All checks passed",
		});
	});

	it("rejects an unknown flag and lists the valid ones", () => {
		expect(parseCliParams("background", "start", "--matc x -- true")).toBe(
			"Unknown flag --matc. Valid flags: --name, --cwd, --timeout-ms, --no-exit, --exit, --log-file",
		);
		expect(parseCliParams("background", "start", "--match x -- true")).toEqual(
			expect.stringContaining("Unknown flag --match"),
		);
		expect(parseCliParams("monitor", "logs", "watch --tail 5")).toEqual(
			expect.stringContaining("Valid flags: --lines, --from-memory"),
		);
	});

	it("maps the boolean and kebab-case flags", () => {
		expect(parseCliParams("monitor", "edit", "w --ignore-case --max-per-minute 5 --no-exit")).toEqual({
			action: "edit",
			name: "w",
			ignoreCase: true,
			maxPerMinute: "5",
			notifyExit: false,
		});
		expect(parseCliParams("background", "logs", "b --lines 9 --from-memory")).toEqual({
			action: "logs",
			name: "b",
			lines: "9",
			fromFile: false,
		});
	});

	it("rejects unknown subcommands and a start without --", () => {
		expect(parseCliParams("background", "edit", "x")).toBe("Unknown background command: edit");
		expect(parseCliParams("background", "start", "sleep 1")).toEqual(expect.stringContaining("separator"));
	});

	it("tokenizes quotes and escapes", () => {
		expect(tokenize(`a "b c" 'd\\e' f\\ g`)).toEqual(["a", "b c", "d\\e", "f g"]);
	});
});
