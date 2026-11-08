import { clampText } from "./lines.ts";

export interface Budget {
	maxLines: number;
	maxLineChars: number;
	maxTotalChars: number;
}

interface ClampedBlock {
	lines: string[];
	dropped: number;
	clamped: boolean;
}

export const EXIT_BUDGET: Budget = { maxLines: 40, maxLineChars: 500, maxTotalChars: 2_000 };
export const MATCH_BUDGET: Budget = { maxLines: 20, maxLineChars: 500, maxTotalChars: 1_500 };
export const STATUS_BUDGET: Budget = { maxLines: 40, maxLineChars: 500, maxTotalChars: 3_000 };
export const LOGS_BUDGET: Budget = { maxLines: 1_000, maxLineChars: 2_000, maxTotalChars: 40_000 };

/** Keeps the tail: the newest lines are the ones worth spending budget on. */
export function clampBlock(lines: readonly string[], budget: Budget): ClampedBlock {
	const kept = lines.slice(-budget.maxLines).map((line) => clampText(line, budget.maxLineChars));
	const clamped = kept.some((line, index) => line !== lines[lines.length - kept.length + index]);
	let total = kept.reduce((sum, line) => sum + line.length + 1, 0);
	while (kept.length > 1 && total > budget.maxTotalChars) {
		total -= (kept.shift() ?? "").length + 1;
	}
	return { lines: kept, dropped: lines.length - kept.length, clamped };
}

export function renderBlock(lines: readonly string[], budget: Budget, totalKnown?: number): string[] {
	if (lines.length === 0) return ["```text", "<no output captured>", "```"];
	const block = clampBlock(lines, budget);
	const total = totalKnown ?? lines.length;
	const cut = block.clamped ? ", long lines cut" : "";
	const header =
		block.dropped > 0 || total > block.lines.length
			? `Output tail (${block.lines.length} of ${total} line(s)${cut}):`
			: `Output (${block.lines.length} line(s)${cut}):`;
	return [header, "```text", ...block.lines, "```"];
}

interface ExitInfo {
	kind: "monitor" | "background";
	name: string;
	command: string;
	cwd: string;
	status: string;
	runtimeMs: number;
	tail: readonly string[];
	totalLines: number;
	logFile: string;
	logNote?: string | undefined;
}

export function exitDigest(info: ExitInfo): string {
	const noun = info.kind === "background" ? "Background job" : "Monitor";
	const lines = [
		`${noun} "${info.name}" ended: ${info.status} after ${formatDuration(info.runtimeMs)}.`,
		`Command: ${info.command}`,
		`Cwd: ${info.cwd}`,
		...renderBlock(info.tail, EXIT_BUDGET, info.totalLines),
		`Full log: ${info.logFile}`,
	];
	if (info.logNote) lines.push(info.logNote);
	return lines.join("\n");
}

export const SCRIPT_EXIT_BUDGET: Budget = { maxLines: 20, maxLineChars: 500, maxTotalChars: 2_000 };

export type ScriptOutcome = "ok" | "error" | "aborted" | "timeout";

interface ScriptExitInfo {
	kind: "background" | "monitor";
	name: string;
	outcome: ScriptOutcome;
	runtimeMs: number;
	tail: readonly string[];
	totalLines: number;
	logFile: string;
}

export function scriptExitDigest(info: ScriptExitInfo): string {
	const noun = info.kind === "background" ? "Background script" : "Monitor script";
	return [
		`${noun} "${info.name}" ended: ${info.outcome} after ${formatDuration(info.runtimeMs)}.`,
		...renderBlock(info.tail, SCRIPT_EXIT_BUDGET, info.totalLines),
		`Full log: ${info.logFile}`,
	].join("\n");
}

interface MatchInfo {
	name: string;
	command: string;
	matchSource: string;
	lines: readonly string[];
	totalMatched: number;
	logFile: string;
}

export function matchDigest(info: MatchInfo): string {
	return [
		`Monitor "${info.name}" matched ${info.totalMatched} line(s).`,
		`Command: ${info.command}`,
		`Pattern: ${info.matchSource}`,
		...renderBlock(info.lines, MATCH_BUDGET, info.totalMatched),
		`Full log: ${info.logFile}`,
	].join("\n");
}

export function formatDuration(ms: number): string {
	if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 90) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 90) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatSeconds(ms: number): string {
	return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}
