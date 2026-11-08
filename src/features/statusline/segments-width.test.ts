import { describe, expect, it, vi } from "vite-plus/test";

const measured = vi.hoisted(() => [] as string[]);
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
	return {
		...actual,
		visibleWidth: (text: string) => {
			measured.push(text);
			return actual.visibleWidth(text);
		},
	};
});

const { visibleWidth } = await import("@earendil-works/pi-tui");
const { compactPath, footerWidth, gitSegment, layoutLine } = await import("./segments.ts");

const theme = { fg: (_color: string, text: string) => `\x1b[2m${text}\x1b[22m`, bold: (text: string) => text };

describe("footer width", () => {
	it("gives pi-tui no text above U+00FF", () => {
		measured.length = 0;
		layoutLine(
			{
				loc: [
					compactPath("/var/lib/something/very/long/path/to/leaf", "/home/u"),
					gitSegment({ branch: "main", dirty: 2, ahead: 1, behind: 3 }, theme),
				].join(theme.fg("dim", " · ")),
				model: theme.fg("accent", "faux - faux-1 - off"),
				context: theme.fg("success", "0/200k (0%)"),
				cost: theme.fg("dim", "12k/3k"),
			},
			120,
			theme,
		);
		expect(measured.length).toBeGreaterThan(0);
		expect(measured.filter((text) => /[^\x20-\xff]/.test(text.replaceAll("\x1b", "")))).toEqual([]);
	});

	it("measures the footer glyphs as pi-tui does", () => {
		for (const text of ["a │ b", "↑1 ↓2", "…/a/b", "\x1b[2m · \x1b[22m"])
			expect(footerWidth(text)).toBe(visibleWidth(text));
	});
});
