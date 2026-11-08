import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	type EditorTheme,
	getKeybindings,
	matchesKey,
	parseKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Adapter, type Snapshot } from "./adapter.ts";
import type { CursorShape } from "./cursor.ts";
import { clampNormal, type Find, prevCell } from "./motions.ts";
import { execute, type Outcome } from "./operators.ts";
import { type Command, Parser } from "./parser.ts";
import { capturePastes, type ClipboardMirror, expandMarkers, type Register, resolvePastes } from "./register.ts";

export type Mode = "insert" | "normal";

export interface ViEditorOptions {
	/** Mirrors yanks to the system clipboard. Undefined means no mirror. */
	clipboard?: ClipboardMirror;
	cursor?: CursorShape;
	now?: () => number;
	label?: { insert: (text: string) => string; normal: (text: string) => string };
	/** Called once when vi key handling fails. */
	onError?: (message: string) => void;
}

/** pi runs its double-Escape action for 2 presses within 500 ms. Esc presses closer than this form one burst. */
const ESCAPE_REPEAT_MS = 500;
const TAIL = "───";

// oxlint-disable-next-line no-control-regex
const MODIFY_OTHER_KEYS = /^\x1b\[27;[12];(\d+)~$/;

/** A printable key as one char, or a named key. CSI-u and modifyOtherKeys `shift+g` become `G`. */
function normalizeKey(data: string): { char: string } | { key: string | undefined } {
	// oxlint-disable-next-line no-control-regex
	if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) return { char: data };
	const id = parseKey(data);
	const code = MODIFY_OTHER_KEYS.exec(data)?.[1];
	const printable = decodeKittyPrintable(data) ?? (code === undefined ? undefined : String.fromCodePoint(Number(code)));
	const shifted = id !== undefined && id.startsWith("shift+");
	if (printable !== undefined) return { char: shifted ? printable.toUpperCase() : printable };
	const single = id === undefined ? undefined : /^(?:shift\+)?(.)$/u.exec(id)?.[1];
	if (single !== undefined) return { char: shifted ? single.toUpperCase() : single };
	return { key: id };
}

/** Carries an error from the base editor or a pi handler past the vi error report. */
class ForwardedError extends Error {
	constructor(cause: unknown) {
		super("forwarded key failed", { cause });
	}
}

export class ViEditor extends CustomEditor {
	private modeValue: Mode = "insert";
	private readonly parser = new Parser();
	private readonly adapter: Adapter | undefined;
	private register: Register | undefined;
	private lastFind: Find | undefined;
	private want = 0;
	private lastEscape = Number.NEGATIVE_INFINITY;
	private guardedBurst = false;
	private forwardedInBurst = false;
	private redoStack: Snapshot[] = [];
	private redoAnchor: string | undefined;
	private reported = false;

	private readonly options: ViEditorOptions;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options: ViEditorOptions = {}) {
		// TODO(okka): try embedWorkingStatus once the web terminal is checked with it.
		super(tui, theme, keybindings);
		this.options = options;
		this.adapter = Adapter.attach(this, (text) => this.onChange?.(text));
		this.clearRedoOnSubmit();
		options.cursor?.set("insert");
	}

	override setText(text: string): void {
		this.clearRedo();
		super.setText(text);
	}

	get mode(): Mode {
		return this.modeValue;
	}

	override handleInput(data: string): void {
		if (!this.adapter) {
			super.handleInput(data);
			return;
		}
		try {
			this.dispatch(this.adapter, data);
		} catch (error) {
			if (error instanceof ForwardedError) throw error.cause;
			this.fail(error);
		}
		this.tui.requestRender();
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const raw = this.modeValue === "insert" ? " INSERT " : ` NORMAL ${this.parser.label()}`.trimEnd() + " ";
		const color = this.modeValue === "insert" ? this.options.label?.insert : this.options.label?.normal;
		const paint = (text: string) => (color ? color(text) : text);
		const labelWidth = visibleWidth(raw);
		const rest = width - labelWidth - TAIL.length;
		if (rest < 1) {
			const shown = truncateToWidth(raw, Math.max(0, width), "");
			return paint(shown) + this.borderColor("─".repeat(Math.max(0, width - visibleWidth(shown))));
		}
		return super.renderTopBorder(rest, hiddenLineCount) + paint(raw) + this.borderColor(TAIL);
	}

	private dispatch(adapter: Adapter, data: string): void {
		// Every paste path sends one complete bracketed paste. The base editor owns paste markers.
		if (data.includes("\x1b[200~") || data.includes("\x1b[201~")) {
			this.forward(data);
			if (this.modeValue === "normal") this.clamp(adapter);
			return;
		}
		if (this.modeValue === "insert") this.insertKey(adapter, data);
		else this.normalKey(adapter, data);
	}

	private insertKey(adapter: Adapter, data: string): void {
		if (matchesKey(data, "escape")) {
			this.startGuardedBurst();
			// Esc first closes the autocomplete list, then leaves insert mode.
			if (this.isShowingAutocomplete()) this.forward(data);
			this.setMode("normal");
			const { line, col } = adapter.cursor();
			adapter.resetCoalescing();
			adapter.setCursor(clampNormal(adapter.lines(), { line, col: prevCell(adapter.lines()[line] ?? "", col) }));
			this.want = adapter.cursor().col;
			return;
		}
		const cursor = adapter.cursor();
		const text = adapter.lines()[cursor.line] ?? "";
		if (matchesKey(data, "alt+o") || data === "\x1bo") return this.openLine(adapter, cursor.line + 1);
		if (matchesKey(data, "shift+alt+o") || data === "\x1bO") return this.openLine(adapter, cursor.line);
		const end = matchesKey(data, "shift+alt+a") || data === "\x1bA";
		if (end || matchesKey(data, "shift+alt+i") || data === "\x1bI") {
			adapter.resetCoalescing();
			adapter.setCursor({ ...cursor, col: end ? text.length : 0 });
			return;
		}
		this.forward(data);
	}

	private openLine(adapter: Adapter, line: number): void {
		const lines = adapter.lines();
		this.clearRedo();
		adapter.apply({ lines: [...lines.slice(0, line), "", ...lines.slice(line)], cursor: { line, col: 0 } });
	}

	private normalKey(adapter: Adapter, data: string): void {
		const key = normalizeKey(data);
		if ("char" in key) {
			const fed = this.parser.feed(key.char);
			if (fed.kind === "command") this.run(adapter, fed.command);
			return;
		}
		if (key.key === "escape") {
			if (this.parser.pending) {
				this.startGuardedBurst();
				return this.parser.reset();
			}
			const now = (this.options.now ?? Date.now)();
			if (now - this.lastEscape >= ESCAPE_REPEAT_MS) {
				this.guardedBurst = false;
				this.forwardedInBurst = false;
			}
			this.lastEscape = now;
			// Mashed Esc keys after leaving insert mode or a pending command reach pi once, so they do not
			// start pi's double-Escape action. A double Esc pressed in normal mode reaches pi.
			if (this.guardedBurst && this.forwardedInBurst) return;
			this.forwardedInBurst = true;
			this.forward(data);
			return;
		}
		if (key.key === "ctrl+r") return this.redoTimes(adapter, this.parser.takeCount());
		if (this.isUndoKey(data, key.key)) return this.undoTimes(adapter, this.parser.takeCount());
		this.parser.reset();
		this.forward(data);
		this.clamp(adapter);
	}

	private startGuardedBurst(): void {
		const now = (this.options.now ?? Date.now)();
		// An Esc that pi got earlier in the same burst still counts toward its double-Escape window.
		if (now - this.lastEscape >= ESCAPE_REPEAT_MS) this.forwardedInBurst = false;
		this.lastEscape = now;
		this.guardedBurst = true;
	}

	private isUndoKey(data: string, id: string | undefined): boolean {
		return matchesKey(data, "ctrl+_") || id === "ctrl+-" || getKeybindings().matches(data, "tui.editor.undo");
	}

	private forward(data: string): void {
		try {
			super.handleInput(data);
		} catch (error) {
			throw new ForwardedError(error);
		}
	}

	/** pi-tui submit clears the text and the undo stack without setText. */
	private clearRedoOnSubmit(): void {
		let submit: ((text: string) => void) | undefined;
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			enumerable: true,
			get: () => submit,
			set: (handler: ((text: string) => void) | undefined) => {
				submit =
					handler &&
					((text: string) => {
						this.clearRedo();
						handler(text);
					});
			},
		});
	}

	private run(adapter: Adapter, command: Command): void {
		if (command.type === "simple" && command.key === "u") return this.undoTimes(adapter, command.count);
		const outcome = execute(adapter.lines(), adapter.cursor(), command, {
			register: this.register && resolvePastes(this.register, adapter.pastes()),
			lastFind: this.lastFind,
			want: this.want,
		});
		if (outcome) this.applyOutcome(adapter, outcome);
	}

	private applyOutcome(adapter: Adapter, outcome: Outcome): void {
		if (outcome.lastFind) this.lastFind = outcome.lastFind;
		if (outcome.register) {
			this.register = capturePastes(outcome.register, adapter.pastes());
			if (outcome.yank) this.options.clipboard?.mirror(expandMarkers(outcome.register.text, adapter.pastes()));
		}
		if (outcome.lines) {
			this.clearRedo();
			adapter.apply({ lines: outcome.lines, cursor: outcome.cursor });
		} else {
			adapter.setCursor(outcome.cursor);
		}
		if (outcome.insert) this.setMode("insert");
		this.want = outcome.want ?? outcome.cursor.col;
	}

	private undoTimes(adapter: Adapter, count: number): void {
		for (let i = 0; i < count; i++) {
			const before = adapter.undo();
			if (!before) break;
			if (this.redoAnchor !== undefined && this.redoAnchor !== before.state.lines.join("\n")) this.redoStack = [];
			this.redoStack.push(before);
			this.redoAnchor = adapter.lines().join("\n");
		}
		this.clamp(adapter);
	}

	private redoTimes(adapter: Adapter, count: number): void {
		// Any edit since the last undo makes the redo states stale.
		if (this.redoAnchor !== adapter.lines().join("\n")) this.clearRedo();
		for (let i = 0; i < count; i++) {
			const snapshot = this.redoStack.pop();
			if (!snapshot) break;
			adapter.redo(snapshot);
			this.redoAnchor = adapter.lines().join("\n");
		}
		this.clamp(adapter);
	}

	private clearRedo(): void {
		this.redoStack = [];
		this.redoAnchor = undefined;
	}

	private clamp(adapter: Adapter): void {
		const cursor = adapter.cursor();
		const clamped = clampNormal(adapter.lines(), cursor);
		if (clamped.col !== cursor.col || clamped.line !== cursor.line) adapter.setCursor(clamped);
		this.want = clamped.col;
	}

	private setMode(mode: Mode): void {
		if (this.modeValue === mode) return;
		this.modeValue = mode;
		this.parser.reset();
		this.options.cursor?.set(mode);
	}

	private fail(error: unknown): void {
		this.parser.reset();
		if (this.reported) return;
		this.reported = true;
		this.options.onError?.(`vi: key handling failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
