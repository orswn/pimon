import { describe, expect, it } from "vite-plus/test";
import type { Pos } from "./motions.ts";
import { textObject } from "./text-objects.ts";

function at(text: string): { lines: string[]; cursor: Pos } {
	const lines = text.split("\n");
	const line = lines.findIndex((l) => l.includes("|"));
	const col = (lines[line] ?? "").indexOf("|");
	lines[line] = (lines[line] ?? "").replace("|", "");
	return { lines, cursor: { line, col } };
}

/** The selected text, with `/` between lines. Linewise ranges get a `L:` prefix. */
function select(text: string, kind: "i" | "a", key: string, count = 1): string | undefined {
	const { lines, cursor } = at(text);
	const range = textObject(lines, cursor, kind, key, count);
	if (!range) return undefined;
	if (range.linewise) return `L:${lines.slice(range.start.line, range.end.line + 1).join("/")}`;
	if (range.start.line === range.end.line) return (lines[range.start.line] ?? "").slice(range.start.col, range.end.col);
	return [
		(lines[range.start.line] ?? "").slice(range.start.col),
		...lines.slice(range.start.line + 1, range.end.line),
		(lines[range.end.line] ?? "").slice(0, range.end.col),
	].join("/");
}

describe("text objects", () => {
	it.each([
		["iw on a word", "foo b|ar.baz", "i", "w", 1, "bar"],
		["iW on a WORD", "foo b|ar.baz x", "i", "W", 1, "bar.baz"],
		["iw on spaces", "a  |  b", "i", "w", 1, "    "],
		["2iw takes the next run", "f|oo bar", "i", "w", 2, "foo "],
		["aw takes trailing space", "f|oo bar", "a", "w", 1, "foo "],
		["aw takes leading space at the line end", "foo b|ar", "a", "w", 1, " bar"],
		["aw on spaces takes the next word", "foo | bar", "a", "w", 1, "  bar"],
		["iw on a marker takes the whole marker", "a |[paste #1 +12 lines] b", "i", "w", 1, "[paste #1 +12 lines]"],
		['i" inside quotes', 'x "a |b" y', "i", '"', 1, "a b"],
		['a" with trailing space', 'x "a |b" y', "a", '"', 1, '"a b" '],
		['i" on the closing quote', 'x "ab|" y', "i", '"', 1, "ab"],
		['i" skips escaped quotes', 'x "a\\"|b" y', "i", '"', 1, 'a\\"b'],
		["i' with no pair", "it|s", "i", "'", 1, undefined],
		["i( inside parens", "f(a, |b)", "i", "(", 1, "a, b"],
		["ib is i(", "f(a|b)", "i", "b", 1, "ab"],
		["a[ with brackets", "x[a|b]y", "a", "[", 1, "[ab]"],
		["iB is i{", "{a|b}", "i", "B", 1, "ab"],
		["i( on the open paren", "f|(ab)", "i", "(", 1, "ab"],
		["i) on the close paren", "f(ab|)", "i", ")", 1, "ab"],
		["2i( takes the outer block", "((a|))", "i", "(", 2, "(a)"],
		["i( across lines", "f(a,\n  |b)", "i", "(", 1, "a,/  b"],
		["i{ on a block takes whole inner lines", "if {\n  |a\n  b\n}", "i", "{", 1, "L:  a/  b"],
		["i[ skips marker brackets", "[x [paste #1 +12 lines] |y]", "i", "[", 1, "x [paste #1 +12 lines] y"],
		["no enclosing block", "a|b", "i", "(", 1, undefined],
	] as const)("%s", (_name, text, kind, key, count, expected) => {
		expect(select(text, kind, key, count)).toBe(expected);
	});
});
