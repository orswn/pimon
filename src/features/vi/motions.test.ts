import { describe, expect, it } from "vite-plus/test";
import { cells, clampNormal, type Find, motion, type MotionKey, type Pos } from "./motions.ts";

/** `|` marks the cursor. */
function at(text: string): { lines: string[]; cursor: Pos } {
	const lines = text.split("\n");
	const line = lines.findIndex((l) => l.includes("|"));
	const col = (lines[line] ?? "").indexOf("|");
	lines[line] = (lines[line] ?? "").replace("|", "");
	return { lines, cursor: { line, col } };
}

function show(lines: readonly string[], pos: Pos): string {
	return lines.map((l, i) => (i === pos.line ? `${l.slice(0, pos.col)}|${l.slice(pos.col)}` : l)).join("\n");
}

function move(text: string, key: MotionKey, count = 1, extra: { lastFind?: Find; operator?: boolean } = {}) {
	const { lines, cursor } = at(text);
	const target = motion(lines, cursor, { key }, { count, hasCount: count !== 1, ...extra });
	return target && show(lines, target.pos);
}

describe("cells", () => {
	it("splits graphemes and keeps a paste marker as one cell", () => {
		expect(cells("ab")).toEqual([0, 1, 2]);
		expect(cells("a👍🏽b")).toEqual([0, 1, 5, 6]);
		expect(cells("x[paste #1 +12 lines]y")).toEqual([0, 1, 21, 22]);
	});
});

describe("motions", () => {
	it.each([
		["h at col 0 does not wrap", "a\n|bc", "h", 1, undefined],
		["3h stops at col 0", "a|bc", "h", 3, "|abc"],
		["l stops at the line end", "ab|c", "l", 1, "abc|"],
		["l steps over a whole marker", "|[paste #1 +12 lines]x", "l", 1, "[paste #1 +12 lines]|x"],
		["w goes to the next word", "|foo bar", "w", 1, "foo |bar"],
		["w splits keyword and punctuation", "|foo.bar", "w", 1, "foo|.bar"],
		["W skips punctuation", "|foo.bar baz", "W", 1, "foo.bar |baz"],
		["w crosses a line break", "foo |bar\nbaz", "w", 1, "foo bar\n|baz"],
		["w stops on an empty line", "|foo\n\nbar", "w", 1, "foo\n|\nbar"],
		["3w counts words", "|a b c d", "w", 3, "a b c |d"],
		["w treats a marker as a word", "|a [paste #1 +12 lines] b", "w", 2, "a [paste #1 +12 lines] |b"],
		["b goes back a word", "foo ba|r", "b", 1, "foo |bar"],
		["b crosses a line break", "foo\n|bar", "b", 1, "|foo\nbar"],
		["b stops on an empty line", "foo\n\n|bar", "b", 1, "foo\n|\nbar"],
		["e goes to the word end", "|foo bar", "e", 1, "fo|o bar"],
		["e from a word end goes to the next end", "fo|o bar", "e", 1, "foo ba|r"],
		["e skips empty lines", "fo|o\n\nbar", "e", 1, "foo\n\nba|r"],
		["0 goes to col 0", "  ab|c", "0", 1, "|  abc"],
		["^ goes to the first non-blank", "  ab|c", "^", 1, "  |abc"],
		["$ goes to the last char", "|abc", "$", 1, "ab|c"],
		["2$ goes to the next line end", "|abc\nde", "$", 2, "abc\nd|e"],
		["G goes to the last line", "|a\nb\n  c", "G", 1, "a\nb\n  |c"],
		["2G goes to line 2", "|a\n b\nc", "G", 2, "a\n |b\nc"],
		["gg goes to the first line", "a\nb\n|c", "gg", 1, "|a\nb\nc"],
		["j on the last line fails", "a\n|b", "j", 1, undefined],
	] as const)("%s", (_name, text, key, count, expected) => {
		expect(move(text, key, count)).toBe(expected);
	});

	it("dw on the last word of a line stops at the line end", () => {
		expect(move("foo |bar\nbaz", "w", 1, { operator: true })).toBe("foo bar|\nbaz");
		expect(move("|foo bar\nbaz qux", "w", 3, { operator: true })).toBe("foo bar\nbaz |qux");
	});

	it.each([
		["f finds the char", "|a,b,c", "f", ",", 1, "a|,b,c"],
		["2f finds the second char", "|a,b,c", "f", ",", 2, "a,b|,c"],
		["t stops before the char", "|a,b", "t", ",", 1, "|a,b"],
		["F searches back", "a,b,|c", "F", ",", 1, "a,b|,c"],
		["T stops after the char", "a,bc|d", "T", ",", 1, "a,|bcd"],
		["a missing char fails", "|abc", "f", "x", 1, undefined],
	] as const)("%s", (_name, text, kind, char, count, expected) => {
		const { lines, cursor } = at(text);
		const target = motion(lines, cursor, { key: kind, char }, { count, hasCount: false });
		expect(target && show(lines, target.pos)).toBe(expected);
	});

	it("; repeats a t search past the adjacent char", () => {
		const lastFind: Find = { kind: "t", char: "," };
		expect(move("a|b,c,d", ";", 1, { lastFind })).toBe("ab,|c,d");
		expect(move("ab,c|,d", ",", 1, { lastFind })).toBe("ab,|c,d");
	});
});

describe("clampNormal", () => {
	it("keeps the cursor on the last char and out of markers", () => {
		expect(clampNormal(["abc"], { line: 0, col: 3 })).toEqual({ line: 0, col: 2 });
		expect(clampNormal([""], { line: 0, col: 0 })).toEqual({ line: 0, col: 0 });
		expect(clampNormal(["x[paste #1 +12 lines]"], { line: 0, col: 5 })).toEqual({ line: 0, col: 1 });
	});
});
