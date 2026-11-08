import { cells, charClass, type Pos } from "./motions.ts";

export interface Range {
	start: Pos;
	/** Exclusive for charwise ranges. The last line for linewise ranges. */
	end: Pos;
	linewise: boolean;
}

export const OBJECT_KEYS = new Set(["w", "W", '"', "'", "`", "(", ")", "b", "[", "]", "{", "}", "B"]);

const BRACKETS: Record<string, [string, string]> = {
	"(": ["(", ")"],
	")": ["(", ")"],
	b: ["(", ")"],
	"[": ["[", "]"],
	"]": ["[", "]"],
	"{": ["{", "}"],
	"}": ["{", "}"],
	B: ["{", "}"],
};

export function textObject(
	lines: readonly string[],
	cursor: Pos,
	kind: "i" | "a",
	key: string,
	count: number,
): Range | undefined {
	if (key === "w" || key === "W") return wordObject(lines[cursor.line] ?? "", cursor, kind, key === "W", count);
	if (key === '"' || key === "'" || key === "`") return quoteObject(lines[cursor.line] ?? "", cursor, kind, key);
	const pair = BRACKETS[key];
	return pair && bracketObject(lines, cursor, kind, pair[0], pair[1], Math.max(1, count));
}

interface Run {
	start: number;
	end: number;
	cls: number;
}

function runs(line: string, big: boolean): Run[] {
	const starts = cells(line);
	const result: Run[] = [];
	for (let i = 0; i < starts.length - 1; i++) {
		const start = starts[i] ?? 0;
		const end = starts[i + 1] ?? line.length;
		const cls = charClass(line.slice(start, end), big);
		const previous = result.at(-1);
		if (previous && previous.cls === cls) previous.end = end;
		else result.push({ start, end, cls });
	}
	return result;
}

function wordObject(line: string, cursor: Pos, kind: "i" | "a", big: boolean, count: number): Range | undefined {
	const all = runs(line, big);
	let index = all.findIndex((run) => cursor.col >= run.start && cursor.col < run.end);
	if (index === -1) return undefined;
	const first = all[index];
	if (!first) return undefined;
	let start = first.start;
	let end = first.end;
	if (kind === "i") {
		for (let i = 1; i < count && index + 1 < all.length; i++) end = (all[++index] as Run).end;
	} else if (first.cls === 0) {
		for (let i = 0; i < count && index + 1 < all.length; i++) {
			end = (all[++index] as Run).end;
			if (i + 1 < count && index + 1 < all.length) end = (all[++index] as Run).end;
		}
	} else {
		for (let i = 1; i < count && index + 2 < all.length; i++) {
			index += 2;
			end = (all[index] as Run).end;
		}
		const after = all[index + 1];
		const before = all[all.indexOf(first) - 1];
		if (after?.cls === 0) end = after.end;
		else if (before?.cls === 0) start = before.start;
	}
	return { start: { line: cursor.line, col: start }, end: { line: cursor.line, col: end }, linewise: false };
}

function isEscaped(line: string, index: number): boolean {
	let slashes = 0;
	for (let i = index - 1; i >= 0 && line[i] === "\\"; i--) slashes++;
	return slashes % 2 === 1;
}

function quoteObject(line: string, cursor: Pos, kind: "i" | "a", quote: string): Range | undefined {
	const quotes: number[] = [];
	for (let i = line.indexOf(quote); i !== -1; i = line.indexOf(quote, i + 1)) {
		if (!isEscaped(line, i)) quotes.push(i);
	}
	const on = quotes.indexOf(cursor.col);
	let open: number | undefined;
	let close: number | undefined;
	if (on !== -1) {
		[open, close] = on % 2 === 0 ? [quotes[on], quotes[on + 1]] : [quotes[on - 1], quotes[on]];
	} else {
		const before = quotes.filter((index) => index < cursor.col).length;
		[open, close] = before % 2 === 1 ? [quotes[before - 1], quotes[before]] : [quotes[before], quotes[before + 1]];
	}
	if (open === undefined || close === undefined) return undefined;
	let start = open + 1;
	let end = close;
	if (kind === "a") {
		start = open;
		end = close + 1;
		const trailing = /^\s+/.exec(line.slice(end))?.[0].length ?? 0;
		if (trailing > 0) end += trailing;
		else start -= /\s+$/.exec(line.slice(0, start))?.[0].length ?? 0;
	}
	return { start: { line: cursor.line, col: start }, end: { line: cursor.line, col: end }, linewise: false };
}

/** Bracket cells only. A paste marker is one cell, so its brackets never match. */
function bracketAt(lines: readonly string[], pos: Pos): string | undefined {
	const ch = lines[pos.line]?.[pos.col];
	if (ch === "[" && lines[pos.line]?.startsWith("[paste #", pos.col)) {
		const starts = cells(lines[pos.line] ?? "");
		const next = starts[starts.indexOf(pos.col) + 1];
		if (next !== undefined && next > pos.col + 1) return undefined;
	}
	return ch;
}

function* cellsBackward(lines: readonly string[], from: Pos): Generator<Pos> {
	for (let line = from.line; line >= 0; line--) {
		const starts = cells(lines[line] ?? "");
		for (let i = starts.length - 2; i >= 0; i--) {
			const col = starts[i] ?? 0;
			if (line === from.line && col >= from.col) continue;
			yield { line, col };
		}
	}
}

function* cellsForward(lines: readonly string[], from: Pos): Generator<Pos> {
	for (let line = from.line; line < lines.length; line++) {
		const starts = cells(lines[line] ?? "");
		for (let i = 0; i < starts.length - 1; i++) {
			const col = starts[i] ?? 0;
			if (line === from.line && col <= from.col) continue;
			yield { line, col };
		}
	}
}

function unmatched(cellsIn: Generator<Pos>, lines: readonly string[], want: string, other: string): Pos | undefined {
	let depth = 0;
	for (const pos of cellsIn) {
		const ch = bracketAt(lines, pos);
		if (ch === other) depth++;
		else if (ch === want) {
			if (depth === 0) return pos;
			depth--;
		}
	}
	return undefined;
}

function bracketObject(
	lines: readonly string[],
	cursor: Pos,
	kind: "i" | "a",
	open: string,
	close: string,
	count: number,
): Range | undefined {
	let start = bracketAt(lines, cursor) === open ? cursor : unmatched(cellsBackward(lines, cursor), lines, open, close);
	for (let i = 1; i < count && start; i++) start = unmatched(cellsBackward(lines, start), lines, open, close);
	if (!start) return undefined;
	const end = unmatched(cellsForward(lines, start), lines, close, open);
	if (!end) return undefined;
	if (kind === "a") return { start, end: { line: end.line, col: end.col + 1 }, linewise: false };
	let inner: Pos = { line: start.line, col: start.col + 1 };
	const openLine = lines[start.line] ?? "";
	if (inner.col >= openLine.length && end.line > start.line) {
		const closeIndented = /^\s*$/.test((lines[end.line] ?? "").slice(0, end.col));
		if (closeIndented) {
			if (end.line - start.line < 2) return { start: end, end, linewise: false };
			return { start: { line: start.line + 1, col: 0 }, end: { line: end.line - 1, col: 0 }, linewise: true };
		}
		inner = { line: start.line + 1, col: 0 };
	}
	return { start: inner, end, linewise: false };
}
