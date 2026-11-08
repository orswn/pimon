import { describe, expect, it } from "vite-plus/test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	busSegment,
	clickedCount,
	compactPath,
	countsSegment,
	type CountRegion,
	goalSegment,
	layoutFooter,
	layoutLine,
	type LineParts,
	type ThemeLike,
} from "./segments.ts";

const theme: ThemeLike = { fg: (_color, text) => text, bold: (text) => text };
const NOW = new Date(2026, 10, 8, 14, 0, 0).getTime();

describe("bus segment", () => {
	it("shows the name alone", () => {
		expect(busSegment({ name: "mars" }, theme)).toBe("mars");
	});

	it("shows name and role when they differ", () => {
		expect(busSegment({ name: "impl-1", role: "worker" }, theme)).toBe("impl-1:worker");
	});

	it("hides a role that equals the name", () => {
		expect(busSegment({ name: "reviewer", role: "reviewer" }, theme)).toBe("reviewer");
	});

	it("shows nothing without a name", () => {
		expect(busSegment(undefined, theme)).toBeUndefined();
		expect(busSegment({ role: "worker" }, theme)).toBeUndefined();
	});
});

describe("goal segment", () => {
	it("shows the turn count for an active goal", () => {
		expect(goalSegment({ state: "active", turns: 7 }, theme, NOW)).toBe("goal 7");
	});

	it("shows paused in the error color", () => {
		const colored: ThemeLike = { fg: (color, text) => `<${color}>${text}`, bold: (text) => text };
		expect(goalSegment({ state: "paused", turns: 3 }, colored, NOW)).toBe("<error>goal paused");
	});

	it("shows nothing for other states", () => {
		for (const state of ["achieved", "cleared", "blocked", undefined]) {
			expect(goalSegment({ state, turns: 2 }, theme, NOW)).toBeUndefined();
		}
		expect(goalSegment(undefined, theme, NOW)).toBeUndefined();
	});

	it("shows waiting while an active goal waits for the next human message", () => {
		expect(goalSegment({ state: "active", turns: 5, waiting: true }, theme, NOW)).toBe("goal 5 waiting");
	});

	it("ignores a turn limit field", () => {
		expect(goalSegment({ state: "active", turns: 2, limit: 10 } as never, theme, NOW)).toBe("goal 2");
	});

	it("shows the local wake time of a future timer", () => {
		const due = new Date(2026, 10, 8, 15, 7, 30).getTime();
		expect(goalSegment({ state: "active", turns: 4, timerDueAt: due }, theme, NOW)).toBe("goal 4 wake 15:07");
		const nextMorning = new Date(2026, 10, 9, 9, 5).getTime();
		expect(goalSegment({ state: "active", turns: 4, timerDueAt: nextMorning }, theme, NOW)).toBe("goal 4 wake 09:05");
	});

	it("drops the wake time when the timer is past due", () => {
		expect(goalSegment({ state: "active", turns: 4, timerDueAt: NOW - 1 }, theme, NOW)).toBe("goal 4");
		expect(goalSegment({ state: "active", turns: 4, timerDueAt: NOW }, theme, NOW)).toBe("goal 4");
	});
});

describe("counts segment", () => {
	const colored: ThemeLike = { fg: (color, text) => `<${color}>${text}`, bold: (text) => text };

	it("shows agents, background, monitors, and timers in that order", () => {
		expect(countsSegment({ agents: 2, background: 2, monitor: 2, timers: 1 }, theme)).toBe("A:2 B:2 M:2 T:1");
	});

	it("shows a zero count as 0", () => {
		expect(countsSegment({ agents: 0, background: 0, monitor: 0, timers: 0 }, theme)).toBe("A:0 B:0 M:0 T:0");
	});

	it("dims a zero count and accents a non-zero count", () => {
		expect(countsSegment({ agents: 0, background: 1, monitor: 0, timers: 3 }, colored)).toBe(
			"<dim>A:0 <accent>B:1 <dim>M:0 <accent>T:3",
		);
	});

	it("hides the letters of a feature that never published", () => {
		expect(countsSegment({ background: 1, monitor: 0, timers: 0 }, theme)).toBe("B:1 M:0 T:0");
		expect(countsSegment({ agents: 2 }, theme)).toBe("A:2");
		expect(countsSegment({}, theme)).toBeUndefined();
	});
});

describe("compact path", () => {
	it("keeps short paths and shortens long ones", () => {
		expect(compactPath("/home/u/src", "/home/u")).toBe("~/src");
		expect(compactPath("/home/u/Projects/some-long-name/deeper/leaf-directory", "/home/u")).toBe(
			"~/P/s/d/leaf-directory",
		);
		expect(compactPath("/var/lib/something/very/long/path/to/leaf", "/home/u")).toBe("…/to/leaf");
	});
});

describe("line layout", () => {
	const parts: LineParts = {
		loc: "L".repeat(10),
		model: "M".repeat(10),
		context: "C".repeat(10),
		bus: "B".repeat(10),
		goal: "G".repeat(10),
		cost: "$".repeat(10),
		limits: "%".repeat(10),
	};
	// Joined with " · " between model, bus, goal and " │ " between groups.
	const full = 10 + 10 + 3 + 10 + 3 + 10 + 3 + 10 + 3 + 10 + 3 + 10;

	const shown = (width: number) => {
		const line = layoutLine(parts, width, theme);
		return ["B", "G", "$", "%"].filter((mark) => line.includes(mark.repeat(10)));
	};

	it("keeps every segment when the line fits", () => {
		expect(shown(full + 1)).toEqual(["B", "G", "$", "%"]);
	});

	it("drops bus first, then limits, then cost, then goal", () => {
		expect(shown(full)).toEqual(["G", "$", "%"]);
		expect(shown(full - 13)).toEqual(["G", "$"]);
		expect(shown(full - 26)).toEqual(["G"]);
		expect(shown(full - 39)).toEqual([]);
	});

	it("shows the counts on the right, before the model and a group separator", () => {
		const line = layoutLine({ ...parts, counts: "A:0 B:1" }, 200, theme);
		expect(line.startsWith(`${"L".repeat(10)} `)).toBe(true);
		expect(line).not.toContain(`${"L".repeat(10)} │`);
		expect(line).toContain(` A:0 B:1 │ ${"M".repeat(10)}`);
	});

	it("drops the counts before the bus", () => {
		const withCounts = { ...parts, counts: "A:0 B:1" };
		const wide = full + 3 + 7;
		expect(layoutLine(withCounts, wide + 1, theme)).toContain("A:0 B:1");
		const narrow = layoutLine(withCounts, wide, theme);
		expect(narrow).not.toContain("A:0");
		expect(narrow).toContain("B".repeat(10));
		expect(layoutLine(withCounts, full, theme)).not.toContain("B".repeat(10));
	});

	it("never drops model and context", () => {
		const line = layoutLine(parts, 40, theme);
		expect(line.length).toBeLessThanOrEqual(40);
		expect(line).toContain("L".repeat(10));
		expect(layoutLine(parts, 60, theme)).toContain("M".repeat(10));
		expect(layoutLine(parts, 60, theme)).toContain("C".repeat(10));
	});

	it("pads the gap so the right side ends at the width", () => {
		const line = layoutLine(parts, full + 5, theme);
		expect(line).toHaveLength(full + 5);
		expect(line.endsWith("%".repeat(10))).toBe(true);
	});
});

describe("count click regions", () => {
	const parts = { loc: "L".repeat(10), model: "M".repeat(10), context: "C".repeat(10), bus: "B".repeat(10) };
	const all = { agents: 2, background: 12, monitor: 0, timers: 1 };
	const at = (line: string, text: string) => line.indexOf(text);
	const region = (line: string, kind: CountRegion["kind"], text: string): CountRegion => ({
		kind,
		start: at(line, text),
		end: at(line, text) + text.length,
	});

	it("keeps the line of layoutLine", () => {
		const layout = layoutFooter(parts, all, 200, theme);
		expect(layout.line).toBe(layoutLine({ ...parts, counts: countsSegment(all, theme) }, 200, theme));
	});

	it("gives each shown letter the columns of its item", () => {
		const { line, regions } = layoutFooter(parts, all, 200, theme);
		expect(line).toContain(" A:2 B:12 M:0 T:1 │ ");
		expect(regions).toEqual([
			region(line, "agents", "A:2"),
			region(line, "background", "B:12"),
			region(line, "monitor", "M:0"),
			region(line, "timers", "T:1"),
		]);
	});

	it("gives regions only to the published letters", () => {
		const { line, regions } = layoutFooter(parts, { background: 0, monitor: 3, timers: 0 }, 120, theme);
		expect(regions.map((item) => item.kind)).toEqual(["background", "monitor", "timers"]);
		expect(regions[1]).toEqual(region(line, "monitor", "M:3"));
		expect(layoutFooter(parts, {}, 120, theme).regions).toEqual([]);
	});

	it("gives no regions when the counts are dropped", () => {
		const shown = layoutFooter(parts, all, 200, theme);
		const used = 200 - (shown.line.match(/ +(?=A:)/)?.[0].length ?? 0);
		expect(layoutFooter(parts, all, used + 1, theme).regions).toHaveLength(4);
		const narrow = layoutFooter(parts, all, used, theme);
		expect(narrow.line).not.toContain("A:2");
		expect(narrow.regions).toEqual([]);
	});

	it("measures a long loc with footer glyphs as the layout does", () => {
		const loc = `…/to/leaf · main ↑1 ↓2 ${"x".repeat(60)}`;
		const { line, regions } = layoutFooter({ ...parts, loc }, all, 160, theme);
		expect(regions).toEqual([
			region(line, "agents", "A:2"),
			region(line, "background", "B:12"),
			region(line, "monitor", "M:0"),
			region(line, "timers", "T:1"),
		]);
	});

	it("counts wide chars in loc by column", () => {
		const loc = "~/項目/日本語 · main 😀";
		const { line, regions } = layoutFooter({ ...parts, loc }, all, 160, theme);
		const column = (text: string) => visibleWidth(line.slice(0, line.indexOf(text)));
		expect(regions[0]).toEqual({ kind: "agents", start: column("A:2"), end: column("A:2") + 3 });
		expect(regions[3]).toEqual({ kind: "timers", start: column("T:1"), end: column("T:1") + 3 });
		expect(regions[0]?.start).toBeGreaterThan(line.indexOf("A:2"));
	});

	it("maps a left click on row 0 to the letter under it", () => {
		const { line, regions } = layoutFooter(parts, all, 200, theme);
		const click = (x: number, extra: Partial<Parameters<typeof clickedCount>[0]> = {}) =>
			clickedCount({ type: "click", button: "left", x, y: 0, ...extra }, regions);
		expect(click(at(line, "A:2"))).toBe("agents");
		expect(click(at(line, "A:2") + 2)).toBe("agents");
		expect(click(at(line, "B:12") + 3)).toBe("background");
		expect(click(at(line, "M:0"))).toBe("monitor");
		expect(click(at(line, "T:1") + 1)).toBe("timers");
	});

	it("ignores clicks outside the letters and other gestures", () => {
		const { line, regions } = layoutFooter(parts, all, 200, theme);
		const click = (x: number, extra: Partial<Parameters<typeof clickedCount>[0]> = {}) =>
			clickedCount({ type: "click", button: "left", x, y: 0, ...extra }, regions);
		const a = at(line, "A:2");
		expect(click(a + 3)).toBeUndefined();
		expect(click(a - 1)).toBeUndefined();
		expect(click(at(line, "T:1") + 3)).toBeUndefined();
		expect(click(at(line, "│"))).toBeUndefined();
		expect(click(at(line, "M".repeat(10)))).toBeUndefined();
		expect(click(0)).toBeUndefined();
		expect(click(a, { y: 1 })).toBeUndefined();
		expect(click(a, { button: "right" })).toBeUndefined();
		expect(click(a, { button: "middle" })).toBeUndefined();
		expect(click(a, { type: "press" })).toBeUndefined();
		expect(click(a, { type: "release" })).toBeUndefined();
		expect(click(a, { type: "drag" })).toBeUndefined();
	});
});
