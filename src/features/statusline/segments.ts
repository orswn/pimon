import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type ThemeLike = Pick<Theme, "fg" | "bold">;

const SEP = " │ ";
const DOT = " · ";

export interface BusIdentity {
	name?: string | undefined;
	role?: string | undefined;
}

export function busSegment(bus: BusIdentity | undefined, theme: ThemeLike): string | undefined {
	if (!bus?.name) return undefined;
	const label = bus.role && bus.role !== bus.name ? `${bus.name}:${bus.role}` : bus.name;
	// TODO(okka): bring back a reliable view of unread and pending bus work.
	return theme.fg("muted", label);
}

/** A count is undefined while its feature has not published, so a disabled feature shows no letter. */
export interface WorkCounts {
	agents?: number | undefined;
	background?: number | undefined;
	monitor?: number | undefined;
	timers?: number | undefined;
}

export function countsSegment(counts: WorkCounts, theme: ThemeLike): string | undefined {
	const items: string[] = [];
	const add = (letter: string, count: number | undefined) => {
		if (count !== undefined) items.push(theme.fg(count > 0 ? "accent" : "dim", `${letter}:${count}`));
	};
	add("A", counts.agents);
	add("B", counts.background);
	add("M", counts.monitor);
	add("T", counts.timers);
	return items.length > 0 ? items.join(" ") : undefined;
}

export interface GoalIndicator {
	state?: string | undefined;
	turns?: number | undefined;
	/** Epoch ms of the goal's wake timer. */
	timerDueAt?: number | undefined;
}

function clock(epochMs: number): string {
	const date = new Date(epochMs);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// A wall clock time, not a countdown: the footer renders only on demand, so a countdown goes stale when pi is idle.
export function goalSegment(goal: GoalIndicator | undefined, theme: ThemeLike, now: number): string | undefined {
	if (goal?.state === "active") {
		const due = goal.timerDueAt;
		const wake = typeof due === "number" && due > now ? ` wake ${clock(due)}` : "";
		return theme.fg("accent", `goal ${goal.turns ?? 0}${wake}`);
	}
	if (goal?.state === "paused") return theme.fg("error", "goal paused");
	return undefined;
}

export interface GitStatus {
	branch: string;
	dirty: number;
	ahead: number;
	behind: number;
}

export function gitSegment(git: GitStatus | undefined, theme: ThemeLike): string | undefined {
	if (!git) return undefined;
	return [
		theme.fg("success", git.branch),
		git.dirty ? ` ${theme.fg("warning", `*${git.dirty}`)}` : "",
		git.ahead ? ` ${theme.fg("accent", `↑${git.ahead}`)}` : "",
		git.behind ? ` ${theme.fg("accent", `↓${git.behind}`)}` : "",
	].join("");
}

export function compactPath(path: string, home = process.env["HOME"]): string {
	const display = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
	const parts = display.split("/").filter(Boolean);
	if (display.length <= 35) return display || "/";
	if (display.startsWith("~/") && parts.length > 3)
		return `~/${parts
			.slice(1, -1)
			.map((part) => part[0])
			.join("/")}/${parts.at(-1)}`;
	if (display.startsWith("/") && parts.length > 3) return `…/${parts.slice(-2).join("/")}`;
	return display || "/";
}

export function fmt(n: number): string {
	if (!Number.isFinite(n)) return "0";
	if (n < 1_000) return `${Math.round(n)}`;
	if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

export function usageColor(percent: number): "error" | "warning" | "success" {
	if (percent >= 80) return "error";
	if (percent >= 50) return "warning";
	return "success";
}

export interface LineParts {
	loc: string;
	counts?: string | undefined;
	model: string;
	context: string;
	bus?: string | undefined;
	goal?: string | undefined;
	cost?: string | undefined;
	limits?: string | undefined;
}

// Early pi-tui visibleWidth calls with chars above U+00FF can leave its ASCII fast path about 3x slower for the
// process, and the editor measures each line of a long prompt with it. Measure the footer glyphs as ASCII.
// TODO(okka): drop footerWidth when pi-tui visibleWidth stays fast after non-Latin1 input.
const NON_LATIN1_GLYPHS = /[│↑↓…]/g;

export function footerWidth(text: string): number {
	return visibleWidth(text.replace(NON_LATIN1_GLYPHS, "-"));
}

// Narrow terminals drop the least important segment first, instead of truncating the model and context away.
const DROP_ORDER = ["counts", "bus", "limits", "cost", "goal"] as const;

export function layoutLine(parts: LineParts, width: number, theme: ThemeLike): string {
	const compose = (drop: number) => {
		const hidden = new Set<string>(DROP_ORDER.slice(0, drop));
		const show = (key: (typeof DROP_ORDER)[number]) => (hidden.has(key) ? undefined : parts[key]);
		const right = [
			show("counts"),
			[parts.model, show("bus"), show("goal")].filter(Boolean).join(theme.fg("dim", DOT)),
			parts.context,
			show("cost"),
			show("limits"),
		]
			.filter(Boolean)
			.join(theme.fg("dim", SEP));
		return { right, used: footerWidth(parts.loc) + footerWidth(right) };
	};
	let drop = 0;
	let line = compose(drop);
	while (line.used >= width && drop < DROP_ORDER.length) line = compose(++drop);
	const gap = " ".repeat(Math.max(1, width - line.used));
	return truncateToWidth(parts.loc + gap + line.right, width, "");
}
