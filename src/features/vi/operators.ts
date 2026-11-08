import {
	cellEnd,
	cells,
	charClass,
	clampNormal,
	type Find,
	firstNonBlank,
	markerRanges,
	motion,
	type Pos,
	prevCell,
} from "./motions.ts";
import type { Command, Operator, Target } from "./parser.ts";
import type { Register } from "./register.ts";
import { type Range, textObject } from "./text-objects.ts";

interface ExecInput {
	register: Register | undefined;
	lastFind: Find | undefined;
	/** Column that `j` and `k` aim for. */
	want: number;
}

export interface Outcome {
	/** Set only when the text changes. */
	lines?: string[];
	cursor: Pos;
	register?: Register;
	/** The register write comes from `y`. */
	yank?: boolean;
	insert?: boolean;
	lastFind?: Find;
	/** Column for later `j` and `k`. Undefined means the new cursor column. */
	want?: number;
}

/** Stops a large count from building a huge buffer. */
const PUT_LIMIT = 1_000_000;

export function execute(
	lines: readonly string[],
	cursor: Pos,
	command: Command,
	input: ExecInput,
): Outcome | undefined {
	const { count, hasCount } = command;
	switch (command.type) {
		case "move": {
			const key = command.motion.key;
			const target = motion(lines, cursor, command.motion, { count, hasCount, lastFind: input.lastFind });
			if (!target) return undefined;
			const vertical = key === "j" || key === "k";
			const pos = vertical ? { line: target.pos.line, col: input.want } : target.pos;
			return {
				cursor: clampNormal(lines, pos),
				lastFind: target.find,
				want: vertical ? input.want : key === "$" ? Number.MAX_SAFE_INTEGER : undefined,
			};
		}
		case "operator":
			return operate(lines, cursor, command.op, command.target, count, hasCount, input);
		case "replace":
			return replace(lines, cursor, command.char, count);
		case "simple":
			return simple(lines, cursor, command.key, count, hasCount, input);
	}
}

function simple(
	lines: readonly string[],
	cursor: Pos,
	key: Extract<Command, { type: "simple" }>["key"],
	count: number,
	hasCount: boolean,
	input: ExecInput,
): Outcome | undefined {
	const text = lines[cursor.line] ?? "";
	const at = (col: number): Outcome => ({ cursor: { line: cursor.line, col }, insert: true });
	switch (key) {
		case "x":
			return operate(lines, cursor, "d", { motion: { key: "l" } }, count, hasCount, input);
		case "s":
			if (text.length === 0) return at(0);
			return operate(lines, cursor, "c", { motion: { key: "l" } }, count, hasCount, input);
		case "S":
			return operate(lines, cursor, "c", { line: true }, count, hasCount, input);
		case "C":
			return operate(lines, cursor, "c", { motion: { key: "$" } }, count, hasCount, input);
		case "D":
			return operate(lines, cursor, "d", { motion: { key: "$" } }, count, hasCount, input);
		case "Y":
			return operate(lines, cursor, "y", { line: true }, count, hasCount, input);
		case "J":
			return join(lines, cursor, count);
		case "p":
		case "P":
			return input.register && put(lines, cursor, input.register, count, key === "P");
		case "i":
			return at(cursor.col);
		case "a":
			return at(text.length === 0 ? 0 : cellEnd(text, cursor.col));
		case "A":
			return at(text.length);
		case "I": {
			const index = text.search(/\S/);
			return at(index === -1 ? text.length : index);
		}
		case "o":
		case "O": {
			const line = key === "o" ? cursor.line + 1 : cursor.line;
			return { lines: [...lines.slice(0, line), "", ...lines.slice(line)], cursor: { line, col: 0 }, insert: true };
		}
		case "u":
			return undefined;
	}
}

function resolveRange(
	lines: readonly string[],
	cursor: Pos,
	op: Operator,
	target: Target,
	count: number,
	hasCount: boolean,
	lastFind: Find | undefined,
): { range: Range; find?: Find } | undefined {
	if ("line" in target) {
		const end = Math.min(lines.length - 1, cursor.line + count - 1);
		return { range: { start: { line: cursor.line, col: 0 }, end: { line: end, col: 0 }, linewise: true } };
	}
	if ("object" in target) {
		const range = textObject(lines, cursor, target.object, target.key, count);
		return range && { range: snap(lines, range) };
	}
	const changeWord = op === "c" && (target.motion.key === "w" || target.motion.key === "W");
	if (changeWord && charClass(cellText(lines, cursor), false) !== 0) {
		return { range: changeWordRange(lines, cursor, target.motion.key === "W", count) };
	}
	const found = motion(lines, cursor, target.motion, { count, hasCount, lastFind, operator: true });
	if (!found) return undefined;
	if (found.linewise) {
		const [a, b] = [cursor.line, found.pos.line].sort((x, y) => x - y) as [number, number];
		return { range: { start: { line: a, col: 0 }, end: { line: b, col: 0 }, linewise: true }, find: found.find };
	}
	const forward = found.pos.line > cursor.line || (found.pos.line === cursor.line && found.pos.col >= cursor.col);
	const start = forward ? cursor : found.pos;
	let end = forward ? found.pos : cursor;
	if (found.inclusive) end = { line: end.line, col: cellEnd(lines[end.line] ?? "", end.col) };
	return { range: snap(lines, { start, end, linewise: false }), find: found.find };
}

function cellText(lines: readonly string[], pos: Pos): string {
	const text = lines[pos.line] ?? "";
	return text.slice(pos.col, cellEnd(text, pos.col));
}

/** Vim `cw` on a word acts like `ce`, and a one-cell word changes only that cell. */
function changeWordRange(lines: readonly string[], cursor: Pos, big: boolean, count: number): Range {
	const text = lines[cursor.line] ?? "";
	const next = cellEnd(text, cursor.col);
	const wordEndsHere =
		next >= text.length ||
		charClass(text.slice(next, cellEnd(text, next)), big) !== charClass(cellText(lines, cursor), big);
	let end = cursor;
	const left = wordEndsHere ? count - 1 : count;
	if (left > 0) {
		end = motion(lines, cursor, { key: big ? "E" : "e" }, { count: left, hasCount: true })?.pos ?? cursor;
	}
	return { start: cursor, end: { line: end.line, col: cellEnd(lines[end.line] ?? "", end.col) }, linewise: false };
}

/** Widens a range that cuts a paste marker, so the marker stays whole. */
export function snap(lines: readonly string[], range: Range): Range {
	if (range.linewise) return range;
	const start = { ...range.start };
	const end = { ...range.end };
	for (const [from, to] of markerRanges(lines[start.line] ?? ""))
		if (start.col > from && start.col < to) start.col = from;
	for (const [from, to] of markerRanges(lines[end.line] ?? "")) if (end.col > from && end.col < to) end.col = to;
	return { start, end, linewise: false };
}

function extract(lines: readonly string[], start: Pos, end: Pos): string {
	if (start.line === end.line) return (lines[start.line] ?? "").slice(start.col, end.col);
	return [
		(lines[start.line] ?? "").slice(start.col),
		...lines.slice(start.line + 1, end.line),
		(lines[end.line] ?? "").slice(0, end.col),
	].join("\n");
}

function operate(
	lines: readonly string[],
	cursor: Pos,
	op: Operator,
	target: Target,
	count: number,
	hasCount: boolean,
	input: ExecInput,
): Outcome | undefined {
	const resolved = resolveRange(lines, cursor, op, target, count, hasCount, input.lastFind);
	if (!resolved) return undefined;
	const { range, find } = resolved;
	const { start, end } = range;
	if (range.linewise) {
		const register = { text: `${lines.slice(start.line, end.line + 1).join("\n")}\n`, linewise: true };
		const before = lines.slice(0, start.line);
		const after = lines.slice(end.line + 1);
		if (op === "y") {
			const line = Math.min(start.line, cursor.line);
			return { cursor: clampNormal(lines, { line, col: cursor.col }), register, yank: true, lastFind: find };
		}
		if (op === "c") {
			return { lines: [...before, "", ...after], cursor: { line: start.line, col: 0 }, register, insert: true };
		}
		const next = before.length + after.length === 0 ? [""] : [...before, ...after];
		const line = Math.min(start.line, next.length - 1);
		return { lines: next, cursor: { line, col: firstNonBlank(next[line] ?? "") }, register, lastFind: find };
	}
	const register = { text: extract(lines, start, end), linewise: false };
	if (op === "y") {
		if (register.text === "") return undefined;
		return { cursor: clampNormal(lines, start), register, yank: true, lastFind: find };
	}
	if (register.text === "") return op === "c" ? { cursor: start, insert: true, lastFind: find } : undefined;
	const joined = (lines[start.line] ?? "").slice(0, start.col) + (lines[end.line] ?? "").slice(end.col);
	const next = [...lines.slice(0, start.line), joined, ...lines.slice(end.line + 1)];
	if (op === "c") return { lines: next, cursor: start, register, insert: true, lastFind: find };
	return { lines: next, cursor: clampNormal(next, start), register, lastFind: find };
}

function replace(lines: readonly string[], cursor: Pos, char: string, count: number): Outcome | undefined {
	const text = lines[cursor.line] ?? "";
	const starts = cells(text);
	const index = starts.indexOf(cursor.col);
	if (index === -1 || index + count > starts.length - 1) return undefined;
	const end = starts[index + count] ?? text.length;
	const line = text.slice(0, cursor.col) + char.repeat(count) + text.slice(end);
	const next = [...lines];
	next[cursor.line] = line;
	return { lines: next, cursor: { line: cursor.line, col: cursor.col + char.length * (count - 1) } };
}

function join(lines: readonly string[], cursor: Pos, count: number): Outcome | undefined {
	const joins = Math.min(Math.max(1, count - 1), lines.length - 1 - cursor.line);
	if (joins <= 0) return undefined;
	let text = lines[cursor.line] ?? "";
	let col = 0;
	for (let i = 1; i <= joins; i++) {
		const right = (lines[cursor.line + i] ?? "").replace(/^\s+/, "");
		const space = right === "" || text === "" || /\s$/.test(text) || right.startsWith(")") ? "" : " ";
		col = space ? text.length : Math.max(0, text.length - 1);
		text += space + right;
	}
	const next = [...lines.slice(0, cursor.line), text, ...lines.slice(cursor.line + joins + 1)];
	return { lines: next, cursor: clampNormal(next, { line: cursor.line, col }) };
}

function put(lines: readonly string[], cursor: Pos, register: Register, count: number, before: boolean): Outcome {
	const times = Math.max(1, Math.min(count, Math.floor(PUT_LIMIT / Math.max(1, register.text.length))));
	if (register.linewise) {
		const body = register.text.endsWith("\n") ? register.text.slice(0, -1) : register.text;
		const added = Array.from({ length: times }, () => body.split("\n")).flat();
		const at = before ? cursor.line : cursor.line + 1;
		return {
			lines: [...lines.slice(0, at), ...added, ...lines.slice(at)],
			cursor: { line: at, col: firstNonBlank(added[0] ?? "") },
		};
	}
	const text = register.text.repeat(times);
	const line = lines[cursor.line] ?? "";
	const at = before || line.length === 0 ? cursor.col : cellEnd(line, cursor.col);
	const parts = (line.slice(0, at) + text + line.slice(at)).split("\n");
	const next = [...lines.slice(0, cursor.line), ...parts, ...lines.slice(cursor.line + 1)];
	if (parts.length > 1) return { lines: next, cursor: { line: cursor.line, col: at } };
	return { lines: next, cursor: { line: cursor.line, col: prevCell(parts[0] ?? "", at + text.length) } };
}
