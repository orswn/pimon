export interface Pos {
	line: number;
	col: number;
}

export type FindKind = "f" | "F" | "t" | "T";

export interface Find {
	kind: FindKind;
	char: string;
}

export type MotionKey =
	| "h"
	| "j"
	| "k"
	| "l"
	| "0"
	| "^"
	| "_"
	| "$"
	| "w"
	| "b"
	| "e"
	| "W"
	| "B"
	| "E"
	| "gg"
	| "G"
	| ";"
	| ",";

export interface Motion {
	key: MotionKey | FindKind;
	/** Target char of `f F t T`. */
	char?: string;
}

interface MotionTarget {
	pos: Pos;
	linewise?: boolean;
	/** The range includes the cell at `pos`. */
	inclusive?: boolean;
	/** Set by `; ,` and `f F t T`. */
	find?: Find;
}

interface MotionInput {
	count: number;
	/** A count was typed. `G` and `gg` need it. */
	hasCount: boolean;
	lastFind?: Find;
	/** `w W` under an operator stop at the line end of the last word. */
	operator?: boolean;
}

const MARKER = /\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]/g;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Cell start offsets of a line plus its length. A cell is a grapheme or a whole paste marker. */
export function cells(line: string): number[] {
	const starts: number[] = [];
	// oxlint-disable-next-line no-control-regex
	if (/^[\x00-\x7f]*$/.test(line)) {
		for (let i = 0; i < line.length; i++) starts.push(i);
	} else {
		for (const segment of segmenter.segment(line)) starts.push(segment.index);
	}
	starts.push(line.length);
	if (!line.includes("[paste #")) return starts;
	const markers = markerRanges(line);
	return starts.filter((start) => !markers.some(([from, to]) => start > from && start < to));
}

export function markerRanges(line: string): [number, number][] {
	return [...line.matchAll(MARKER)].map((match) => [match.index, match.index + match[0].length]);
}

/** Index of the cell that holds `col`. Returns the cell count for `col >= length`. */
function cellIndex(starts: readonly number[], col: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if ((starts[mid] ?? 0) <= col) low = mid;
		else high = mid - 1;
	}
	return low;
}

function cellStart(line: string, col: number): number {
	const starts = cells(line);
	return starts[cellIndex(starts, Math.min(col, line.length))] ?? 0;
}

export function cellEnd(line: string, col: number): number {
	if (col >= line.length) return line.length;
	const starts = cells(line);
	return starts[cellIndex(starts, col) + 1] ?? line.length;
}

export function prevCell(line: string, col: number): number {
	if (col <= 0) return 0;
	const starts = cells(line);
	const index = cellIndex(starts, Math.min(col, line.length));
	const start = starts[index] ?? 0;
	return start < col ? start : (starts[index - 1] ?? 0);
}

function lastCell(line: string): number {
	return line.length === 0 ? 0 : prevCell(line, line.length);
}

/** Normal mode never rests past the last cell or inside a marker. */
export function clampNormal(lines: readonly string[], pos: Pos): Pos {
	const line = Math.max(0, Math.min(pos.line, lines.length - 1));
	const text = lines[line] ?? "";
	return { line, col: Math.min(cellStart(text, Math.max(0, pos.col)), lastCell(text)) };
}

export function firstNonBlank(line: string): number {
	const index = line.search(/\S/);
	return index === -1 ? lastCell(line) : index;
}

/** 0 blank, 1 keyword, 2 punctuation, 3 paste marker. */
export function charClass(text: string, big: boolean): number {
	if (text.length === 0 || /^\s/u.test(text)) return 0;
	if (big) return 1;
	if (text.startsWith("[paste #") && text.length > 9) return 3;
	return /^[\p{L}\p{N}_]/u.test(text) ? 1 : 2;
}

class LineCells {
	private readonly cache = new Map<number, number[]>();
	readonly lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.lines = lines;
	}

	starts(line: number): number[] {
		let found = this.cache.get(line);
		if (!found) {
			found = cells(this.lines[line] ?? "");
			this.cache.set(line, found);
		}
		return found;
	}

	/** Class of the cell at `col`. Line end is blank. */
	cls(line: number, col: number, big: boolean): number {
		const text = this.lines[line] ?? "";
		if (col >= text.length) return 0;
		const starts = this.starts(line);
		const index = cellIndex(starts, col);
		return charClass(text.slice(starts[index], starts[index + 1]), big);
	}

	next(line: number, col: number): number {
		const starts = this.starts(line);
		return starts[cellIndex(starts, col) + 1] ?? (this.lines[line] ?? "").length;
	}

	prev(line: number, col: number): number {
		const starts = this.starts(line);
		const index = cellIndex(starts, col);
		const start = starts[index] ?? 0;
		return start < col ? start : (starts[index - 1] ?? 0);
	}

	length(line: number): number {
		return (this.lines[line] ?? "").length;
	}
}

function wordForward(view: LineCells, from: Pos, big: boolean): Pos {
	let { line, col } = from;
	const last = view.lines.length - 1;
	const start = view.cls(line, col, big);
	if (start !== 0) {
		while (col < view.length(line) && view.cls(line, col, big) === start) col = view.next(line, col);
	}
	for (;;) {
		if (col >= view.length(line)) {
			if (line >= last) return { line, col: view.length(line) };
			line++;
			col = 0;
			if (view.length(line) === 0) return { line, col };
			continue;
		}
		if (view.cls(line, col, big) !== 0) return { line, col };
		col = view.next(line, col);
	}
}

function wordBackward(view: LineCells, from: Pos, big: boolean): Pos {
	let { line, col } = from;
	const back = (): boolean => {
		if (col > 0) {
			col = view.prev(line, col);
			return true;
		}
		if (line === 0) return false;
		line--;
		col = view.length(line);
		if (col === 0) return false;
		col = view.prev(line, col);
		return true;
	};
	if (!back()) return { line, col };
	while (view.cls(line, col, big) === 0) {
		if (view.length(line) === 0) return { line, col: 0 };
		if (!back()) return { line, col };
		if (view.length(line) === 0) return { line, col: 0 };
	}
	const cls = view.cls(line, col, big);
	while (col > 0) {
		const before = view.prev(line, col);
		if (view.cls(line, before, big) !== cls) break;
		col = before;
	}
	return { line, col };
}

function wordEnd(view: LineCells, from: Pos, big: boolean): Pos {
	let { line, col } = from;
	const last = view.lines.length - 1;
	const forward = (): boolean => {
		const next = view.next(line, col);
		if (next < view.length(line)) {
			col = next;
			return true;
		}
		if (line >= last) return false;
		line++;
		col = 0;
		return true;
	};
	if (!forward()) return from;
	while (view.cls(line, col, big) === 0) {
		if (!forward()) return from;
	}
	const cls = view.cls(line, col, big);
	for (;;) {
		const next = view.next(line, col);
		if (next >= view.length(line) || view.cls(line, next, big) !== cls) return { line, col };
		col = next;
	}
}

function findInLine(line: string, col: number, find: Find, count: number, repeat: boolean): number | undefined {
	const starts = cells(line);
	const index = cellIndex(starts, col);
	const forward = find.kind === "f" || find.kind === "t";
	const till = find.kind === "t" || find.kind === "T";
	const step = forward ? 1 : -1;
	// A repeated `t` right before its char would not move, so it starts one cell further.
	let at = index + step * (repeat && till ? 2 : 1);
	let found: number | undefined;
	for (let left = count; at >= 0 && at < starts.length - 1; at += step) {
		if (line.slice(starts[at], starts[at + 1]) !== find.char) continue;
		if (--left === 0) {
			found = at;
			break;
		}
	}
	if (found === undefined) return undefined;
	return starts[till ? found - step : found];
}

const REVERSE: Record<FindKind, FindKind> = { f: "F", F: "f", t: "T", T: "t" };

export function motion(lines: readonly string[], cursor: Pos, m: Motion, input: MotionInput): MotionTarget | undefined {
	const count = Math.max(1, input.count);
	const text = lines[cursor.line] ?? "";
	const last = lines.length - 1;
	switch (m.key) {
		case "h": {
			if (cursor.col === 0) return undefined;
			let col = cursor.col;
			for (let i = 0; i < count && col > 0; i++) col = prevCell(text, col);
			return { pos: { line: cursor.line, col } };
		}
		case "l": {
			const starts = cells(text);
			const index = Math.min(cellIndex(starts, cursor.col) + count, starts.length - 1);
			const col = starts[index] ?? text.length;
			return col === cursor.col ? undefined : { pos: { line: cursor.line, col } };
		}
		case "j":
		case "k": {
			const line = Math.max(0, Math.min(last, cursor.line + (m.key === "j" ? count : -count)));
			return line === cursor.line ? undefined : { pos: { line, col: cursor.col }, linewise: true };
		}
		case "0":
			return { pos: { line: cursor.line, col: 0 } };
		case "^":
			return { pos: { line: cursor.line, col: firstNonBlank(text) } };
		case "_": {
			const line = Math.min(last, cursor.line + count - 1);
			return { pos: { line, col: firstNonBlank(lines[line] ?? "") }, linewise: true };
		}
		case "$": {
			const line = Math.min(last, cursor.line + count - 1);
			return { pos: { line, col: lastCell(lines[line] ?? "") }, inclusive: true };
		}
		case "gg":
		case "G": {
			const fallback = m.key === "G" ? last : 0;
			const line = input.hasCount ? Math.max(0, Math.min(last, count - 1)) : fallback;
			return { pos: { line, col: firstNonBlank(lines[line] ?? "") }, linewise: true };
		}
		case "w":
		case "W":
			return wordMotion(lines, cursor, m.key === "W", count, input.operator === true);
		case "b":
		case "B": {
			const view = new LineCells(lines);
			let pos = cursor;
			for (let i = 0; i < count; i++) pos = wordBackward(view, pos, m.key === "B");
			return pos.line === cursor.line && pos.col === cursor.col ? undefined : { pos };
		}
		case "e":
		case "E": {
			const view = new LineCells(lines);
			let pos = cursor;
			for (let i = 0; i < count; i++) pos = wordEnd(view, pos, m.key === "E");
			return pos.line === cursor.line && pos.col === cursor.col ? undefined : { pos, inclusive: true };
		}
		case ";":
		case ",": {
			if (!input.lastFind) return undefined;
			const find = m.key === ";" ? input.lastFind : { ...input.lastFind, kind: REVERSE[input.lastFind.kind] };
			const target = findTarget(text, cursor, find, count, true);
			return target && { ...target, find: input.lastFind };
		}
		default: {
			if (m.char === undefined) return undefined;
			const find = { kind: m.key, char: m.char };
			const target = findTarget(text, cursor, find, count, false);
			return target && { ...target, find };
		}
	}
}

function findTarget(text: string, cursor: Pos, find: Find, count: number, repeat: boolean): MotionTarget | undefined {
	const col = findInLine(text, cursor.col, find, count, repeat);
	if (col === undefined) return undefined;
	return { pos: { line: cursor.line, col }, inclusive: find.kind === "f" || find.kind === "t" };
}

function wordMotion(
	lines: readonly string[],
	cursor: Pos,
	big: boolean,
	count: number,
	operator: boolean,
): MotionTarget | undefined {
	const view = new LineCells(lines);
	let previous = cursor;
	let pos = cursor;
	for (let i = 0; i < count; i++) {
		previous = pos;
		pos = wordForward(view, pos, big);
	}
	// Vim rule: under an operator, a last word at the end of a line ends the range at that line end.
	if (operator && pos.line > previous.line) pos = { line: previous.line, col: view.length(previous.line) };
	return pos.line === cursor.line && pos.col === cursor.col ? undefined : { pos };
}
