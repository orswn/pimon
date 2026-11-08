import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	type EditorTheme,
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { shapeProblems } from "./adapter.ts";
import { BAR, BLOCK, createCursorShape, RESET } from "./cursor.ts";
import { ViEditor, type ViEditorOptions } from "./editor.ts";
import { createClipboardMirror } from "./register.ts";

const ESC = "\x1b";
const UNDO = "\x1f";
const REDO = "\x12";
const ENTER = "\r";
const NEWLINE = "\x1b[13;2u";
const LEFT = "\x1b[D";
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const BODY = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
const OTHER = Array.from({ length: 12 }, (_, i) => `other ${i}`).join("\n");

function fakeTui() {
	const writes: string[] = [];
	let hardware = false;
	const tui = {
		requestRender: () => {},
		terminal: { rows: 40, columns: 80, write: (data: string) => writes.push(data) },
		getShowHardwareCursor: () => hardware,
		setShowHardwareCursor: (value: boolean) => {
			hardware = value;
		},
	};
	return { tui: tui as unknown as TUI, writes, hardware: () => hardware };
}

function keybindings() {
	return new KeybindingsManager({
		...TUI_KEYBINDINGS,
		"app.interrupt": { defaultKeys: "escape", description: "Interrupt" },
		"app.exit": { defaultKeys: "ctrl+d", description: "Exit" },
		"app.clipboard.pasteImage": { defaultKeys: "ctrl+v", description: "Paste image" },
	} as never);
}

const id = (text: string) => text;
const theme = {
	borderColor: id,
	selectList: { selectedPrefix: id, selectedText: id, description: id, scrollInfo: id, noMatch: id },
} as unknown as EditorTheme;

function setup(options: ViEditorOptions = {}) {
	const fake = fakeTui();
	let clock = 1_000_000;
	const editor = new ViEditor(fake.tui, theme, keybindings() as never, { now: () => clock, ...options });
	const onEscape = vi.fn();
	const onSubmit = vi.fn();
	editor.onEscape = onEscape;
	editor.onSubmit = onSubmit;
	/** Each string is one key; plain text is split into one key per char. */
	const press = (...keys: string[]) => {
		for (const key of keys) {
			if (key.startsWith(ESC) || key.length === 1) editor.handleInput(key);
			else for (const char of key) editor.handleInput(char);
		}
	};
	const show = () => {
		const { line, col } = editor.getCursor();
		return editor
			.getLines()
			.map((text, i) => (i === line ? `${text.slice(0, col)}|${text.slice(col)}` : text))
			.join("\n");
	};
	const topBorder = (width: number, hidden = 0) =>
		(editor as unknown as { renderTopBorder(w: number, h: number): string }).renderTopBorder(width, hidden);
	return {
		editor,
		press,
		show,
		topBorder,
		onEscape,
		onSubmit,
		...fake,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("modes and label", () => {
	it("starts in insert mode and shows the mode at the right end of the top border", () => {
		const s = setup();
		expect(s.editor.mode).toBe("insert");
		expect(s.topBorder(30)).toBe(`${"─".repeat(19)} INSERT ───`);
		s.press("ab", ESC);
		expect(s.editor.mode).toBe("normal");
		expect(s.topBorder(30)).toBe(`${"─".repeat(19)} NORMAL ───`);
		s.press("3d");
		expect(s.topBorder(30)).toBe(`${"─".repeat(15)} NORMAL 3d_ ───`);
		s.press(ESC, "i");
		expect(s.editor.mode).toBe("insert");
	});

	it("keeps the scroll label whole next to the mode label", () => {
		const s = setup();
		const border = s.topBorder(40, 12);
		expect(border).toBe(`${"─".repeat(9)} ↑ 12 more ${"─".repeat(9)} INSERT ───`);
	});

	it("fills the whole width when the label does not fit", () => {
		const s = setup();
		expect(s.topBorder(10)).toBe(" INSERT ──");
		expect(visibleWidth(s.topBorder(5))).toBe(5);
	});

	it("bottom border stays bare dashes", () => {
		const s = setup();
		s.press("abc");
		expect(s.editor.render(20).at(-1)).toBe("─".repeat(20));
	});
});

describe("escape", () => {
	it("leaves insert mode without reaching pi and moves the cursor back one char", () => {
		const s = setup();
		s.press("abc", ESC);
		expect(s.onEscape).not.toHaveBeenCalled();
		expect(s.show()).toBe("ab|c");
		s.press("x");
		expect(s.show()).toBe("a|b");
	});

	it("moves the cursor back one char from the middle of a line", () => {
		const s = setup();
		s.press("abc", LEFT, ESC);
		expect(s.show()).toBe("a|bc");
	});

	it("forwards Esc first when the autocomplete list is open", () => {
		const s = setup();
		const forwarded = vi.spyOn(CustomEditor.prototype, "handleInput");
		vi.spyOn(s.editor, "isShowingAutocomplete").mockReturnValue(true);
		s.press(ESC);
		expect(forwarded).toHaveBeenCalledWith(ESC);
		expect(s.editor.mode).toBe("normal");
	});

	it("forwards a normal-mode Esc but swallows a second one within 500 ms", () => {
		const s = setup();
		s.press(ESC, ESC);
		expect(s.onEscape).toHaveBeenCalledTimes(1);
		s.advance(300);
		s.press(ESC);
		expect(s.onEscape).toHaveBeenCalledTimes(1);
		s.advance(250);
		s.press(ESC);
		expect(s.onEscape).toHaveBeenCalledTimes(2);
	});

	it("only clears a pending command", () => {
		const s = setup();
		s.press("ab", ESC, "d", ESC);
		expect(s.onEscape).not.toHaveBeenCalled();
		expect(s.topBorder(20)).toContain(" NORMAL ───");
		s.press("x");
		expect(s.show()).toBe("|a");
	});
});

describe("normal-mode cursor", () => {
	it("h stops at col 0 and l at the last char", () => {
		const s = setup();
		s.press("ab", NEWLINE, "cd", ESC, "0", "h");
		expect(s.show()).toBe("ab\n|cd");
		s.press("lll");
		expect(s.show()).toBe("ab\nc|d");
	});

	it("reads a CSI-u shifted letter as upper case and never types it", () => {
		const s = setup();
		s.press("gx", NEWLINE, "y", ESC, "gg");
		s.editor.handleInput("\x1b[103;2u");
		expect(s.show()).toBe("gx\n|y");
	});

	it.each([
		["CSI-u", "\x1b[103;2u", "\x1b[52:36;2u"],
		["modifyOtherKeys", "\x1b[27;2;71~", "\x1b[27;2;36~"],
		["modifyOtherKeys without shift", "\x1b[27;2;71~", "\x1b[27;1;36~"],
	])("reads %s printable keys as vi keys and never types them", (_name, bigG, dollar) => {
		const s = setup();
		s.press("ab", NEWLINE, "cd", ESC, "gg0");
		s.editor.handleInput(bigG);
		expect(s.show()).toBe("ab\n|cd");
		s.editor.handleInput(dollar);
		expect(s.show()).toBe("ab\nc|d");
		expect(s.editor.getText()).toBe("ab\ncd");
	});

	it("drops unmapped printable keys", () => {
		const s = setup();
		s.press("abc", ESC, "v./n:q");
		expect(s.editor.getText()).toBe("abc");
	});
});

describe("paste", () => {
	it("pastes in normal mode and stays in normal mode", () => {
		const s = setup();
		s.press("ab", ESC, "0", paste("hi"));
		expect(s.editor.getText()).toBe("hiab");
		expect(s.editor.mode).toBe("normal");
	});

	it("keeps a large paste marker whole under vi edits", () => {
		const s = setup();
		s.press("x ", paste(BODY), ESC);
		expect(s.editor.getText()).toBe("x [paste #1 +12 lines]");
		s.press("0dw");
		expect(s.editor.getText()).toBe("[paste #1 +12 lines]");
		expect(s.editor.getExpandedText()).toBe(BODY);
		s.press("dw");
		expect(s.editor.getText()).toBe("");
	});

	it("puts a yanked marker that still expands on submit", () => {
		const s = setup();
		s.press(paste(BODY), ESC, "yyp");
		expect(s.editor.getText()).toBe("[paste #1 +12 lines]\n[paste #1 +12 lines]");
		expect(s.editor.getExpandedText()).toBe(`${BODY}\n${BODY}`);
	});
});

describe("registers with paste markers", () => {
	it("puts the yanked paste content after submit cleared the pastes", () => {
		const s = setup();
		s.press(paste(BODY), ESC, "yy", ENTER);
		expect(s.onSubmit).toHaveBeenLastCalledWith(BODY);
		s.press("i", "x", ESC, "p", ENTER);
		expect(s.onSubmit).toHaveBeenLastCalledWith(`x\n${BODY}`);
	});

	it("puts the yanked paste content when a new paste reuses the marker id", () => {
		const s = setup();
		s.press(paste(BODY), ESC, "yy", ENTER);
		s.press("i", paste(OTHER), ESC, "p", ENTER);
		expect(s.onSubmit).toHaveBeenLastCalledWith(`${OTHER}\n${BODY}`);
	});

	it("puts the yanked paste content after backspace renumbered the markers", () => {
		const s = setup();
		s.press(paste(BODY), NEWLINE, paste(OTHER), ESC, "yy", "gg", "A", "\x7f", ESC);
		expect(s.editor.getText()).toBe("\n[paste #1 +12 lines]");
		s.press("p", ENTER);
		expect(s.onSubmit).toHaveBeenLastCalledWith(`${OTHER}\n${OTHER}`);
	});

	it("keeps the marker when the paste with that id is unchanged", () => {
		const s = setup();
		s.press(paste(BODY), ESC, "yyp");
		expect(s.editor.getText()).toBe("[paste #1 +12 lines]\n[paste #1 +12 lines]");
	});
});

describe("undo and redo", () => {
	it("makes each vi edit one undo unit and starts a new unit for later typing", () => {
		const s = setup();
		s.press("abc xy", ESC, "0dw", "i", "qr", ESC);
		expect(s.editor.getText()).toBe("qrxy");
		s.press("u");
		expect(s.editor.getText()).toBe("xy");
		s.press(UNDO);
		expect(s.editor.getText()).toBe("abc xy");
	});

	it("starts a new undo unit for typing after an insert-mode vi edit", () => {
		const s = setup();
		s.press("ab", "\x1bo", "cd", ESC, "u");
		expect(s.editor.getText()).toBe("ab\n");
		s.press("u");
		expect(s.editor.getText()).toBe("ab");
	});

	it("starts a new undo unit for each insert session", () => {
		const s = setup();
		s.press("abc", ESC, "A", "def", ESC, "u");
		expect(s.editor.getText()).toBe("abc");
	});

	it("redoes with ctrl+r and counts", () => {
		const s = setup();
		s.press("a b c", ESC, "0dwdw");
		expect(s.editor.getText()).toBe("c");
		s.press("2u");
		expect(s.editor.getText()).toBe("a b c");
		s.press(REDO);
		expect(s.editor.getText()).toBe("b c");
		s.press("2", REDO);
		expect(s.editor.getText()).toBe("c");
		s.press("u");
		expect(s.editor.getText()).toBe("b c");
	});

	it("drops redo states after submit", () => {
		const s = setup();
		s.press("abc", ESC, "u");
		expect(s.editor.getText()).toBe("");
		s.press("i", "hello", ENTER, ESC, REDO);
		expect(s.editor.getText()).toBe("");
	});

	it("drops redo states after setText", () => {
		const s = setup();
		s.press("abc", ESC, "u");
		s.editor.setText("");
		s.press(REDO);
		expect(s.editor.getText()).toBe("");
	});

	it("undoes with the configured tui.editor.undo key and can redo it", () => {
		const previous = getKeybindings();
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.undo": "alt+z" }));
		try {
			const s = setup();
			s.press("a b", ESC, "0dw", "\x1bz");
			expect(s.editor.getText()).toBe("a b");
			s.press(REDO);
			expect(s.editor.getText()).toBe("b");
		} finally {
			setKeybindings(previous);
		}
	});

	it("drops redo states after a new edit", () => {
		const s = setup();
		s.press("a b", ESC, "0dw", "u", "x", REDO);
		expect(s.editor.getText()).toBe(" b");
	});

	it("redo of an undone large paste submits the pasted content", () => {
		const s = setup();
		s.press("x", paste(BODY), ESC, "u");
		expect(s.editor.getText()).toBe("x");
		s.press(REDO);
		expect(s.editor.getText()).toBe("x[paste #1 +12 lines]");
		s.press(ENTER);
		expect(s.onSubmit).toHaveBeenCalledWith(`x${BODY}`);
	});
});

describe("registers and counts", () => {
	it("yy p puts a line below", () => {
		const s = setup();
		s.press("one", ESC, "yyp");
		expect(s.show()).toBe("one\n|one");
	});

	it("cc then p puts a line", () => {
		const s = setup();
		s.press("one", ESC, "cc", "two", ESC, "p");
		expect(s.show()).toBe("two\n|one");
	});

	it("2dd deletes 2 lines", () => {
		const s = setup();
		s.press("a", NEWLINE, "b", NEWLINE, "c", ESC, "gg2dd");
		expect(s.show()).toBe("|c");
	});
});

describe("insert alt keys", () => {
	it.each([
		["alt+I", "\x1bI"],
		["alt+A", "\x1bA"],
	])("%s starts a new undo unit", (_name, key) => {
		const s = setup();
		s.press("ab", key, "c", ESC, "u");
		expect(s.editor.getText()).toBe("ab");
	});

	it("open lines and move to the line ends without leaving insert mode", () => {
		const s = setup();
		s.press("ab", "\x1bo", "c", "\x1bO", "d");
		expect(s.editor.getText()).toBe("ab\nd\nc");
		s.press("\x1bI", "<", "\x1bA", ">");
		expect(s.editor.getText()).toBe("ab\n<d>\nc");
		expect(s.editor.mode).toBe("insert");
	});
});

describe("clipboard mirror", () => {
	it("mirrors yanks with markers expanded, and not deletes", async () => {
		const copies: string[] = [];
		const clipboard = createClipboardMirror(async (text) => {
			copies.push(text);
		}, vi.fn());
		const s = setup({ clipboard });
		s.press("foo bar", ESC, "0yw");
		await clipboard.idle();
		s.press("dw", "x");
		s.press("A", paste(BODY), ESC, "yy");
		await clipboard.idle();
		expect(copies).toEqual(["foo ", `ar${BODY}\n`]);
	});

	it("shows one warning when the copy fails", async () => {
		const warn = vi.fn();
		const clipboard = createClipboardMirror(async () => {
			throw new Error("no tool");
		}, warn);
		const s = setup({ clipboard });
		s.press("a", ESC, "yy");
		await clipboard.idle();
		s.press("yy");
		await clipboard.idle();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith("vi: clipboard copy failed: no tool");
	});
});

describe("cursor shape", () => {
	it("writes the shape on install and on mode change, and restores on shutdown", () => {
		const fake = fakeTui();
		const shape = createCursorShape(true);
		shape.attach(fake.tui);
		expect(fake.hardware()).toBe(true);
		const editor = new ViEditor(fake.tui, theme, keybindings() as never, { cursor: shape });
		editor.handleInput("a");
		editor.handleInput(ESC);
		editor.handleInput("x");
		editor.handleInput("i");
		expect(fake.writes).toEqual([BAR, BLOCK, BAR]);
		shape.restore();
		expect(fake.writes.at(-1)).toBe(RESET);
		expect(fake.hardware()).toBe(false);
	});

	it("writes nothing when off", () => {
		const fake = fakeTui();
		const shape = createCursorShape(false);
		shape.attach(fake.tui);
		const editor = new ViEditor(fake.tui, theme, keybindings() as never, { cursor: shape });
		editor.handleInput(ESC);
		shape.restore();
		expect(fake.writes).toEqual([]);
		expect(fake.hardware()).toBe(false);
	});
});

describe("adapter", () => {
	it("finds the pi-tui private members", () => {
		const fake = fakeTui();
		expect(shapeProblems(new CustomEditor(fake.tui, theme, keybindings() as never))).toEqual([]);
	});

	it("lists the missing members of a changed editor", () => {
		expect(shapeProblems({ state: { lines: [], cursorLine: 0 } })).toEqual([
			"state.cursorCol",
			"lastAction",
			"historyIndex",
			"pastes",
			"pasteCounter",
			"setCursorCol",
			"pushUndoSnapshot",
			"undo",
		]);
	});

	it("lets errors from pi handlers pass through and reports none as vi errors", () => {
		const onError = vi.fn();
		const s = setup({ onError });
		s.editor.onSubmit = () => {
			throw new Error("pi failed");
		};
		s.press("a");
		expect(() => s.press(ENTER)).toThrow("pi failed");
		s.press(ESC);
		s.editor.onEscape = () => {
			throw new Error("escape failed");
		};
		expect(() => s.press(ESC)).toThrow("escape failed");
		expect(onError).not.toHaveBeenCalled();
	});

	it("never throws from handleInput and reports one error", () => {
		const onError = vi.fn();
		const s = setup({ onError });
		s.press(ESC);
		vi.spyOn(Object.getPrototypeOf((s.editor as unknown as { parser: object }).parser), "feed").mockImplementation(
			() => {
				throw new Error("boom");
			},
		);
		expect(() => s.press("w", "w")).not.toThrow();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith("vi: key handling failed: boom");
	});
});
