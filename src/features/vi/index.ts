import { copyToClipboard, CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { defineFeature } from "../../core/feature.ts";
import { shapeProblems } from "./adapter.ts";
import { createCursorShape, type CursorShape } from "./cursor.ts";
import { ViEditor } from "./editor.ts";
import { type CopyFn, createClipboardMirror } from "./register.ts";

const configSchema = Type.Object(
	{
		clipboard: Type.Union([Type.Literal("yank"), Type.Literal("never")], { default: "yank" }),
		cursorShape: Type.Boolean({ default: true }),
	},
	{ additionalProperties: false },
);

export interface ViFeatureOptions {
	/** Writes the system clipboard. Tests inject a fake. */
	copy?: CopyFn;
	now?: () => number;
	/** Builds the editor that the shape check reads. Tests inject a wrong shape. */
	probe?: () => object;
}

function probeEditor(): object {
	const tui = { requestRender() {} } as unknown as TUI;
	const theme = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;
	return new CustomEditor(tui, theme, undefined as unknown as KeybindingsManager);
}

const reverse = (text: string) => `\x1b[7m${text}\x1b[27m`;

export function createViFeature(options: ViFeatureOptions = {}) {
	return defineFeature({
		id: "vi",
		description: "Modal vi editor for the prompt",
		defaultEnabled: true,
		configSchema,
		setup(ctx) {
			let cursor: CursorShape | undefined;
			let warned = false;

			ctx.onSessionStart((_event, ext) => {
				// RPC ignores custom editors, and print and JSON modes have no UI.
				if (ext.mode !== "tui") return;
				const problems = shapeProblems((options.probe ?? probeEditor)());
				if (problems.length > 0) {
					if (!warned) {
						warned = true;
						ctx.log.warn(`the vi editor is not installed: pi-tui Editor has no ${problems.join(", ")}`);
					}
					return;
				}
				const shape = createCursorShape(ctx.config.cursorShape);
				cursor = shape;
				const warn = (message: string) => ext.ui.notify(message, "warning");
				const clipboard =
					ctx.config.clipboard === "yank" ? createClipboardMirror(options.copy ?? copyToClipboard, warn) : undefined;
				const theme = ext.ui.theme;
				const label = {
					insert: (text: string) => theme.fg("borderMuted", reverse(text)),
					normal: (text: string) => theme.fg("borderAccent", reverse(text)),
				};
				ext.ui.setEditorComponent((tui, editorTheme, keybindings) => {
					shape.attach(tui);
					return new ViEditor(tui, editorTheme, keybindings, {
						clipboard,
						cursor: shape,
						label,
						...(options.now ? { now: options.now } : {}),
						// ctx.log.warn would show this again at the next session start.
						onError: warn,
					});
				});
			});

			ctx.onSessionShutdown(() => {
				cursor?.restore();
				cursor = undefined;
			});
		},
	});
}

export const vi = createViFeature();
