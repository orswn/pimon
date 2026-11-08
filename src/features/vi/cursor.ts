import type { TUI } from "@earendil-works/pi-tui";

export const BAR = "\x1b[5 q";
export const BLOCK = "\x1b[1 q";
export const RESET = "\x1b[0 q";

type CursorTui = Pick<TUI, "terminal" | "getShowHardwareCursor" | "setShowHardwareCursor">;

export interface CursorShape {
	/** Shows the hardware cursor and remembers the earlier setting. */
	attach(tui: CursorTui): void;
	set(mode: "insert" | "normal"): void;
	/** Shows the hardware cursor again if something hid it while attached. */
	ensureShown(): void;
	/** Resets the shape and restores the hardware cursor setting. */
	restore(): void;
}

/** DECSCUSR shapes. Writes happen on mode change only, never from render. */
export function createCursorShape(enabled: boolean): CursorShape {
	let tui: CursorTui | undefined;
	let previous: boolean | undefined;
	return {
		attach(next) {
			if (!enabled) return;
			tui = next;
			previous ??= next.getShowHardwareCursor();
			next.setShowHardwareCursor(true);
		},
		set(mode) {
			tui?.terminal.write(mode === "insert" ? BAR : BLOCK);
		},
		ensureShown() {
			// pi applies its showHardwareCursor setting after /reload has built the new editor.
			if (tui && !tui.getShowHardwareCursor()) tui.setShowHardwareCursor(true);
		},
		restore() {
			if (!tui) return;
			tui.terminal.write(RESET);
			if (previous !== undefined) tui.setShowHardwareCursor(previous);
			tui = undefined;
			previous = undefined;
		},
	};
}
