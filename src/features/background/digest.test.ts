import { describe, expect, it } from "vite-plus/test";
import {
	clampBlock,
	EXIT_BUDGET,
	exitDigest,
	formatDuration,
	formatSeconds,
	MATCH_BUDGET,
	matchDigest,
	renderBlock,
} from "./digest.ts";

const many = Array.from({ length: 100 }, (_, i) => `line ${i}`);

describe("clampBlock", () => {
	it("keeps at most maxLines, keeps the tail, and counts the dropped lines", () => {
		const block = clampBlock(many, EXIT_BUDGET);
		expect(block.lines).toHaveLength(EXIT_BUDGET.maxLines);
		expect(block.lines.at(-1)).toBe("line 99");
		expect(block.dropped).toBe(60);
	});

	it("clamps long lines and flags it", () => {
		const clamped = clampBlock(["x".repeat(5000), "tail"], EXIT_BUDGET);
		expect(clamped.lines[0]?.length).toBeLessThan(600);
		expect(clamped.clamped).toBe(true);
	});

	it("enforces the total char budget", () => {
		const budgeted = clampBlock(
			Array.from({ length: 40 }, () => "y".repeat(400)),
			EXIT_BUDGET,
		);
		const total = budgeted.lines.reduce((sum, line) => sum + line.length + 1, 0);
		expect(total).toBeLessThanOrEqual(EXIT_BUDGET.maxTotalChars);
	});
});

describe("exitDigest", () => {
	const digest = exitDigest({
		kind: "background",
		name: "tests",
		status: "exit code 1",
		runtimeMs: 42_000,
		tail: many,
		totalLines: 100,
		logFile: "/tmp/x.log",
	});

	it("stays small and names the log file", () => {
		expect(digest.length).toBeLessThan(3_500);
		expect(digest).toContain("/tmp/x.log");
	});

	it("contains no workflow directive", () => {
		expect(digest).not.toContain("action=logs");
		expect(digest).not.toContain("Continue");
	});

	it("leaves out the command and cwd that the start call already holds", () => {
		const lines = digest.split("\n");
		expect(lines[0]).toBe('Background job "tests" ended: exit code 1 after 42s.');
		expect(lines[1]).toBe("Output tail (40 of 100 line(s)):");
		expect(lines.at(-1)).toBe("Full log: /tmp/x.log");
		expect(lines.filter((line) => /^(Command|Cwd): /.test(line))).toEqual([]);
	});

	it("names the command when it is given, for a job with a generated name", () => {
		const named = exitDigest({
			kind: "background",
			name: "background-3",
			command: "pnpm test",
			status: "exit code 0",
			runtimeMs: 5,
			tail: [],
			totalLines: 0,
			logFile: "/tmp/z.log",
		});
		expect(named.split("\n").slice(0, 2)).toEqual([
			'Background job "background-3" ended: exit code 0 after 5ms.',
			"Command: pnpm test",
		]);
	});

	it("reports the real line count and the exit status", () => {
		expect(digest).toContain("of 100 line(s)");
		expect(digest).toContain("exit code 1");
	});

	it("handles no output", () => {
		const empty = exitDigest({
			kind: "background",
			name: "quiet",
			status: "exit code 0",
			runtimeMs: 5,
			tail: [],
			totalLines: 0,
			logFile: "/tmp/y.log",
		});
		expect(empty).toContain("<no output captured>");
	});
});

describe("matchDigest and renderBlock", () => {
	it("match digest respects its own budget and shows the pattern", () => {
		const match = matchDigest({
			name: "pr",
			command: "gh pr checks",
			matchSource: "failed",
			lines: many,
			totalMatched: 100,
			logFile: "/tmp/z.log",
		});
		expect(match.length).toBeLessThan(2_500);
		expect(match).toContain("Pattern: failed");
	});

	it("names the command only when it is given, for a monitor with a generated name", () => {
		const base = { name: "pr", matchSource: "failed", lines: ["x failed"], totalMatched: 1, logFile: "/tmp/z.log" };
		expect(matchDigest(base)).not.toContain("Command:");
		expect(matchDigest({ ...base, command: "gh pr checks" }).split("\n")[1]).toBe("Command: gh pr checks");
	});

	it("renderBlock reports no output", () => {
		expect(renderBlock([], EXIT_BUDGET).join("\n")).toContain("<no output captured>");
	});

	it("MATCH_BUDGET is tighter than EXIT_BUDGET", () => {
		expect(MATCH_BUDGET.maxLines).toBeLessThan(EXIT_BUDGET.maxLines);
	});
});

describe("durations", () => {
	it("formats ms, seconds, minutes, and hours", () => {
		expect(formatDuration(900)).toBe("900ms");
		expect(formatDuration(42_000)).toBe("42s");
		expect(formatDuration(9 * 60_000)).toBe("9m");
		expect(formatDuration(3 * 60 * 60_000)).toBe("3h 0m");
	});

	it("formats stop outcomes with one decimal", () => {
		expect(formatSeconds(300)).toBe("0.3s");
		expect(formatSeconds(2_000)).toBe("2.0s");
	});
});
