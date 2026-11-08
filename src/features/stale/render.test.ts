import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import type { Gap } from "./gap.ts";
import { renderGap } from "./render.ts";

const theme = { fg: (color: string, text: string) => `[${color}]${text}[/]` } as unknown as Theme;
const gap: Gap = {
	gapMs: 134 * 60_000,
	idle: true,
	now: 0,
	offsetMinutes: 0,
	host: { kind: "suspend", ms: 110 * 60_000 },
	pi: "restart",
};
const message = { details: gap, content: "<session-gap>\nLast activity: 2h 14m ago.\n</session-gap>" };
const lines = (expanded: boolean, withDetails = true) =>
	renderGap({ ...message, details: withDetails ? gap : undefined }, { expanded, outputPad: 0 }, theme)
		.render(200)
		.map((line) => line.trimEnd());

describe("renderGap", () => {
	it("shows one dim line when collapsed", () => {
		expect(lines(false)).toEqual(["[dim]session gap: 2h 14m · suspended 1h 50m · pi restarted[/]"]);
	});

	it("adds the full text when expanded", () => {
		expect(lines(true).join("\n")).toContain("pi restarted\n<session-gap>\nLast activity: 2h 14m ago.\n</session-gap>");
	});

	it("shows a plain label without details", () => {
		expect(lines(false, false)).toEqual(["[dim]session gap[/]"]);
	});
});
