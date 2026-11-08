import type { Pos } from "./motions.ts";

/** pi-tui `Editor` private members that vi needs. No public API sets the cursor, undoes, or resets undo coalescing. */
interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	lastAction: unknown;
	historyIndex: number;
	pastes: Map<number, string>;
	pasteCounter: number;
	setCursorCol(col: number): void;
	pushUndoSnapshot(): void;
	undo(): void;
}

export interface Snapshot {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	pastes: Map<number, string>;
	pasteCounter: number;
}

interface Edit {
	lines: string[];
	cursor: Pos;
}

/** Returns the missing or wrong members. Empty when the editor has the expected shape. */
export function shapeProblems(editor: object): string[] {
	const e = editor as Partial<Record<keyof EditorInternals, unknown>>;
	const state = e.state as Partial<EditorInternals["state"]> | undefined;
	const problems: string[] = [];
	if (typeof state !== "object" || state === null) problems.push("state");
	else {
		if (!Array.isArray(state.lines)) problems.push("state.lines");
		if (typeof state.cursorLine !== "number") problems.push("state.cursorLine");
		if (typeof state.cursorCol !== "number") problems.push("state.cursorCol");
	}
	if (!("lastAction" in editor)) problems.push("lastAction");
	if (typeof e.historyIndex !== "number") problems.push("historyIndex");
	if (!(e.pastes instanceof Map)) problems.push("pastes");
	if (typeof e.pasteCounter !== "number") problems.push("pasteCounter");
	for (const name of ["setCursorCol", "pushUndoSnapshot", "undo"] as const) {
		if (typeof e[name] !== "function") problems.push(name);
	}
	return problems;
}

/** The only code that writes pi-tui editor state. Pure modules compute the edit. */
export class Adapter {
	private readonly inner: EditorInternals;
	private readonly changed: (text: string) => void;

	private constructor(inner: EditorInternals, changed: (text: string) => void) {
		this.inner = inner;
		this.changed = changed;
	}

	static attach(editor: object, changed: (text: string) => void): Adapter | undefined {
		if (shapeProblems(editor).length > 0) return undefined;
		return new Adapter(editor as unknown as EditorInternals, changed);
	}

	/** The live lines. Callers must not change them. */
	lines(): readonly string[] {
		return this.inner.state.lines;
	}

	cursor(): Pos {
		return { line: this.inner.state.cursorLine, col: this.inner.state.cursorCol };
	}

	pastes(): ReadonlyMap<number, string> {
		return this.inner.pastes;
	}

	/** One undo unit. Typing after it starts a new unit. */
	apply(edit: Edit): void {
		const inner = this.inner;
		inner.pushUndoSnapshot();
		inner.historyIndex = -1;
		inner.state.lines = edit.lines;
		this.place(edit.cursor);
		this.resetCoalescing();
		this.changed(edit.lines.join("\n"));
	}

	setCursor(pos: Pos): void {
		this.place(pos);
	}

	resetCoalescing(): void {
		this.inner.lastAction = null;
	}

	/** Returns the state before the undo, or undefined when nothing was undone. */
	undo(): Snapshot | undefined {
		const before = this.snapshot();
		const lines = this.inner.state.lines;
		this.inner.undo();
		// pi-tui undo assigns the cloned snapshot lines, so a new array means a snapshot was popped.
		return this.inner.state.lines === lines ? undefined : before;
	}

	/** The inverse of pi-tui undo: push the current state, then restore the snapshot. */
	redo(snapshot: Snapshot): void {
		const inner = this.inner;
		inner.pushUndoSnapshot();
		inner.historyIndex = -1;
		Object.assign(inner.state, snapshot.state);
		inner.pastes = snapshot.pastes;
		inner.pasteCounter = snapshot.pasteCounter;
		this.place(this.cursor());
		this.resetCoalescing();
		this.changed(inner.state.lines.join("\n"));
	}

	private snapshot(): Snapshot {
		const { state, pastes, pasteCounter } = this.inner;
		return structuredClone({ state, pastes, pasteCounter });
	}

	private place(pos: Pos): void {
		this.inner.state.cursorLine = pos.line;
		this.inner.setCursorCol(pos.col);
	}
}
