import { describe, expect, it } from "vite-plus/test";
import { busSegment, compactPath, goalSegment, layoutLine, type LineParts, type ThemeLike } from "./segments.ts";

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
