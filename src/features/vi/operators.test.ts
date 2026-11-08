import { describe, expect, it } from "vite-plus/test";
import type { Find, Pos } from "./motions.ts";
import { execute, snap } from "./operators.ts";
import { Parser } from "./parser.ts";
import type { Register } from "./register.ts";

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

/** Runs normal-mode keys on pure state, like the editor but without pi-tui. */
function run(text: string, keys: string, start: { register?: Register } = {}) {
	let { lines, cursor } = at(text);
	let register = start.register;
	let lastFind: Find | undefined;
	let want = cursor.col;
	let insert = false;
	let yanked = false;
	const parser = new Parser();
	for (const key of keys) {
		const fed = parser.feed(key);
		if (fed.kind !== "command") continue;
		const outcome = execute(lines, cursor, fed.command, { register, lastFind, want });
		if (!outcome) continue;
		if (outcome.lines) lines = outcome.lines;
		cursor = outcome.cursor;
		if (outcome.register) register = outcome.register;
		if (outcome.lastFind) lastFind = outcome.lastFind;
		yanked ||= outcome.yank === true;
		insert ||= outcome.insert === true;
		want = outcome.want ?? cursor.col;
	}
	return { text: show(lines, cursor), register, insert, yanked };
}

describe("operators", () => {
	it.each([
		["dw deletes a word", "|foo bar", "dw", "|bar"],
		["dw on the last word keeps the line break", "foo |bar\nbaz", "dw", "foo| \nbaz"],
		["cw on the last word keeps the line break", "foo |bar\nbaz", "cw", "foo |\nbaz"],
		["cw acts like ce", "|foo bar", "cw", "| bar"],
		["cw on a one-char word changes that char", "|a bar", "cw", "| bar"],
		["d3w deletes 3 words", "|a b c d", "d3w", "|d"],
		["2d3w deletes 6 words", "|a b c d e f g", "2d3w", "|g"],
		["db deletes back", "foo ba|r", "db", "foo |r"],
		["de is inclusive", "|foo bar", "de", "| bar"],
		["d$ deletes to the line end", "a|bc\nd", "d$", "|a\nd"],
		["D deletes to the line end", "a|bc", "D", "|a"],
		["2D deletes into the next line", "a|bc\nde\nf", "2D", "|a\nf"],
		["C changes to the line end", "a|bc", "C", "a|"],
		["dd deletes the line", "a\n|b\nc", "dd", "a\n|c"],
		["dd on the only line leaves an empty line", "|abc", "dd", "|"],
		["3dd deletes 3 lines", "|a\nb\nc\nd", "3dd", "|d"],
		["2d3j deletes 7 lines", "|0\n1\n2\n3\n4\n5\n6\n7\n8\n9", "2d3j", "|7\n8\n9"],
		["dk deletes the line above too", "a\nb\n|c", "dk", "|a"],
		["dG deletes to the end", "a\n|b\nc", "dG", "|a"],
		["d_ deletes the line", "a\n|b", "d_", "|a"],
		["x deletes a char", "a|bc", "x", "a|c"],
		["x at the line end deletes the last char", "ab|c", "x", "a|b"],
		["5x stops at the line end", "a|bc", "5x", "|a"],
		["x on an empty line does nothing", "|\na", "x", "|\na"],
		["s changes a char", "a|bc", "s", "a|c"],
		["dfx deletes through the char", "|abxcd", "dfx", "|cd"],
		["dtx deletes up to the char", "|abxcd", "dtx", "|xcd"],
		["d; repeats the find", "|a,b,c", "f,d;", "a|c"],
		["diw deletes the word", "foo b|ar baz", "diw", "foo | baz"],
		["daw deletes the word and a space", "foo b|ar baz", "daw", "foo |baz"],
		["daw on the last word takes the space before", "foo b|ar", "daw", "fo|o"],
		["ciw on a space changes the space run", "foo|  bar", "ciw", "foo|bar"],
		["di( deletes inside parens", "f(a, |b)", "di(", "f(|)"],
		["da( deletes the parens", "f(a, |b) x", "da(", "f| x"],
		["2di( deletes the outer inside", "((a|))", "2di(", "(|)"],
		['di" deletes inside quotes', 'say "hi |there" now', 'di"', 'say "|" now'],
		['di" before the quotes uses the next pair', '|say "hi"', 'di"', 'say "|"'],
		['da" takes the trailing space', 'a "b|" c', 'da"', "a |c"],
		["di{ across lines keeps the bracket lines", "if {\n  a\n  |b\n}", "di{", "if {\n|}"],
		["di[ never cuts a paste marker", "[a [paste #1 +12 lines] |b]", "di[", "[|]"],
		["r replaces a char", "a|bc", "rx", "a|xc"],
		["3r replaces 3 chars", "|abcd", "3rx", "xx|xd"],
		["5r past the line end fails", "|abc", "5rx", "|abc"],
		["J joins with one space", "|a\n  b", "J", "a| b"],
		["3J joins 3 lines", "|a\nb\nc\nd", "3J", "a b| c\nd"],
		["o opens a line below", "|a\nb", "o", "a\n|\nb"],
		["O opens a line above", "a\n|b", "O", "a\n|\nb"],
		["A appends at the line end", "|ab", "A", "ab|"],
		["I inserts at the first non-blank", "  a|b", "I", "  |ab"],
		["a appends after the cursor", "|ab", "a", "a|b"],
		["2j keeps the column", "ab|c\nd\nefg", "2j", "abc\nd\nef|g"],
		["$ then j stays at the line end", "|ab\nabcd", "$j", "ab\nabc|d"],
		["unmapped keys do nothing", "|abc", "v./n", "|abc"],
	] as const)("%s", (_name, text, keys, expected) => {
		expect(run(text, keys).text).toBe(expected);
	});

	it("widens a range that cuts a paste marker", () => {
		const lines = ["a[paste #1 +12 lines]b"];
		const range = { start: { line: 0, col: 3 }, end: { line: 0, col: 5 }, linewise: false };
		expect(snap(lines, range)).toEqual({ start: { line: 0, col: 1 }, end: { line: 0, col: 21 }, linewise: false });
	});

	it("dw cuts no paste marker", () => {
		expect(run("|[paste #1 +12 lines] x", "dw").text).toBe("|x");
		expect(run("a |[paste #1 +12 lines]", "x").text).toBe("a| ");
	});
});

describe("registers", () => {
	it.each([
		["yw yanks a word", "|foo bar", "yw", { text: "foo ", linewise: false }],
		["3yw yanks 3 words", "|a b c d", "3yw", { text: "a b c ", linewise: false }],
		["yy yanks a linewise line", "|abc", "yy", { text: "abc\n", linewise: true }],
		["Y yanks a linewise line", "|abc", "Y", { text: "abc\n", linewise: true }],
		["yj yanks 2 lines", "|a\nb\nc", "yj", { text: "a\nb\n", linewise: true }],
		["dd writes a linewise register", "|one\ntwo", "dd", { text: "one\n", linewise: true }],
		["cc writes a linewise register", "|one\ntwo", "cc", { text: "one\n", linewise: true }],
		["S writes a linewise register", "|one\ntwo", "S", { text: "one\n", linewise: true }],
		["x writes a charwise register", "|one", "x", { text: "o", linewise: false }],
		["yw at the line end has no line break", "foo |bar\nbaz", "yw", { text: "bar", linewise: false }],
	] as const)("%s", (_name, text, keys, register) => {
		expect(run(text, keys).register).toEqual(register);
	});

	it("only y forms are yanks", () => {
		expect(run("|a b", "yw").yanked).toBe(true);
		expect(run("|a b", "dw").yanked).toBe(false);
		expect(run("|a b", "x").yanked).toBe(false);
	});

	it.each([
		["p puts a charwise text after the cursor", "|ab", "p", { text: "X", linewise: false }, "a|Xb"],
		["P puts a charwise text before the cursor", "a|b", "P", { text: "X", linewise: false }, "a|Xb"],
		["3p repeats the text", "|ab", "3p", { text: "X", linewise: false }, "aXX|Xb"],
		["p puts a linewise text below", "|a\nb", "p", { text: "  x\n", linewise: true }, "a\n  |x\nb"],
		["P puts a linewise text above", "a\n|b", "P", { text: "x\n", linewise: true }, "a\n|x\nb"],
		["p on an empty line puts at col 0", "|", "p", { text: "X", linewise: false }, "|X"],
	] as const)("%s", (_name, text, keys, register, expected) => {
		expect(run(text, keys, { register }).text).toBe(expected);
	});

	it("cc then p puts a line, not inline text", () => {
		const changed = run("|one\ntwo", "cc");
		expect(changed.text).toBe("|\ntwo");
		expect(run("|two", "p", { register: changed.register }).text).toBe("two\n|one");
	});
});

describe("changes on empty lines", () => {
	it.each([
		["S on an empty line keeps the line", "a\n|\nb", "S", "a\n|\nb"],
		["cc on an empty line keeps the line", "a\n|\nb", "cc", "a\n|\nb"],
		["2S changes 2 lines into one", "|a\nb\nc", "2S", "|\nc"],
	] as const)("%s", (_name, text, keys, expected) => {
		const result = run(text, keys);
		expect(result.text).toBe(expected);
		expect(result.insert).toBe(true);
	});
});
