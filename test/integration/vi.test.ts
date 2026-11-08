import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { BAR, BLOCK, RESET } from "../../src/features/vi/cursor.ts";
import { ViEditor } from "../../src/features/vi/editor.ts";
import { createViFeature, type ViFeatureOptions } from "../../src/features/vi/index.ts";
import { Parser } from "../../src/features/vi/parser.ts";
import { createHarness, type Harness } from "../support/harness.ts";

type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;

let harness: Harness | undefined;

afterEach(() => {
	vi.restoreAllMocks();
	harness?.dispose();
	harness = undefined;
});

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
const id = (text: string) => text;
const editorTheme = {
	borderColor: id,
	selectList: { selectedPrefix: id, selectedText: id, description: id, scrollInfo: id, noMatch: id },
} as unknown as EditorTheme;

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
	} as unknown as TUI;
	return { tui, writes, hardware: () => hardware };
}

interface StartOptions extends ViFeatureOptions {
	mode?: "tui" | "rpc" | "print" | "json";
	config?: Record<string, unknown>;
	hasUI?: boolean;
}

async function start(options: StartOptions = {}) {
	const factories: (EditorFactory | undefined)[] = [];
	const copies: string[] = [];
	const h = await createHarness({
		features: [createViFeature({ copy: async (text) => void copies.push(text), ...options })],
		mode: options.mode ?? "tui",
		setupAgentDir: (dir) => {
			if (options.config) writeFileSync(join(dir, "pimon.json"), JSON.stringify({ features: { vi: options.config } }));
		},
		...(options.hasUI === false
			? {}
			: { ui: { theme, setEditorComponent: (factory: EditorFactory | undefined) => void factories.push(factory) } }),
	});
	harness = h;
	const build = () => {
		const factory = factories.at(-1);
		if (!factory) throw new Error("no editor factory");
		const fake = fakeTui();
		const kb = new KeybindingsManager({
			...TUI_KEYBINDINGS,
			"app.interrupt": { defaultKeys: "escape", description: "Interrupt" },
		} as never);
		const editor = factory(fake.tui, editorTheme, kb as never);
		return { editor, ...fake };
	};
	return { h, factories, copies, build };
}

describe("vi install", () => {
	it("installs the vi editor in TUI mode", async () => {
		const s = await start();
		expect(s.factories).toHaveLength(1);
		expect(s.build().editor).toBeInstanceOf(ViEditor);
		expect(s.h.runtime.diagnostics()).toEqual([]);
	});

	it.each(["rpc", "print", "json"] as const)("installs nothing in %s mode", async (mode) => {
		const s = await start({ mode });
		expect(s.factories).toHaveLength(0);
	});

	it("installs nothing without a UI", async () => {
		const s = await start({ mode: "print", hasUI: false });
		expect(s.factories).toHaveLength(0);
	});

	it("installs nothing and warns once when the pi-tui editor shape changed", async () => {
		const s = await start({ probe: () => ({}) });
		await s.h.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		expect(s.factories).toHaveLength(0);
		const warnings = s.h.runtime.diagnostics().filter((entry) => entry.feature === "vi");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toContain("the vi editor is not installed: pi-tui Editor has no state");
		expect(s.h.uiNotices.filter((notice) => notice.includes("vi editor is not installed"))).toHaveLength(1);
	});
});

describe("vi cursor shape", () => {
	it("writes the shape on install and restores the cursor at shutdown", async () => {
		const s = await start();
		const built = s.build();
		expect(built.hardware()).toBe(true);
		built.editor.handleInput("\x1b");
		await s.h.shutdown();
		expect(built.writes).toEqual([BAR, BLOCK, RESET]);
		expect(built.hardware()).toBe(false);
	});

	it("shows the hardware cursor again when pi hides it after a reload", async () => {
		const s = await start();
		const built = s.build();
		// pi applies its showHardwareCursor setting after the new extensions have built the editor.
		built.tui.setShowHardwareCursor(false);
		built.editor.render(80);
		expect(built.hardware()).toBe(true);
		built.editor.handleInput("\x1b");
		built.editor.render(80);
		expect(built.writes).toEqual([BAR, BLOCK]);
		expect(built.hardware()).toBe(true);
	});

	it("leaves the cursor alone when cursorShape is off", async () => {
		const s = await start({ config: { cursorShape: false } });
		const built = s.build();
		built.editor.render(80);
		built.editor.handleInput("\x1b");
		await s.h.shutdown();
		expect(built.writes).toEqual([]);
		expect(built.hardware()).toBe(false);
	});
});

describe("vi key errors", () => {
	it("shows one notice now and no second notice at the next session start", async () => {
		const s = await start();
		const { editor } = s.build();
		vi.spyOn(Parser.prototype, "feed").mockImplementation(() => {
			throw new Error("boom");
		});
		for (const key of ["\x1b", "w", "w"]) editor.handleInput(key);
		await s.h.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		const notices = s.h.uiNotices.filter((notice) => notice.includes("boom"));
		expect(notices).toEqual(["vi: key handling failed: boom"]);
	});
});

describe("vi options", () => {
	it("mirrors yanks by default", async () => {
		const s = await start();
		const { editor } = s.build();
		for (const key of ["a", "b", "\x1b", "y", "y"]) editor.handleInput(key);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(s.copies).toEqual(["ab\n"]);
	});

	it("never mirrors with clipboard never", async () => {
		const s = await start({ config: { clipboard: "never" } });
		const { editor } = s.build();
		for (const key of ["a", "b", "\x1b", "y", "y", "p"]) editor.handleInput(key);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(s.copies).toEqual([]);
		expect(editor.getText()).toBe("ab\nab");
	});

	it("rejects an unknown clipboard value", async () => {
		const s = await start({ config: { clipboard: "all" } });
		expect(s.h.runtime.status()).toContainEqual(expect.objectContaining({ id: "vi", state: "invalid" }));
		expect(s.factories).toHaveLength(0);
	});

	it("is on by default with yank mirroring and cursor shapes", async () => {
		const s = await start();
		expect(s.h.runtime.status()).toEqual([
			{ id: "vi", state: "enabled", config: { clipboard: "yank", cursorShape: true } },
		]);
	});
});
