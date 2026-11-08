import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	colorToOklch,
	CURSOR_MARKER,
	decodeKittyPrintable,
	Key,
	matchesKey,
	mixColors,
	parseColor,
	renderFakeCursor,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const TIMEOUT_MS = 120_000;
const OVERLAY_WIDTH = 72;
const MAX_MASK = 32;
const MAX_REASON_LINES = 6;
const LABEL = "Reason  ";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Pasted text keeps tab and newline; typed control characters are dropped.
// oxlint-disable-next-line no-control-regex
const PASTE_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
// oxlint-disable-next-line no-control-regex
const TYPED_CONTROL = /[\x00-\x1f\x7f]/;

export interface AskRequest {
	reason: string;
}

export interface CloseSource {
	once(event: "close", listener: () => void): unknown;
	off(event: "close", listener: () => void): unknown;
}

export function promptOverlay(ui: ExtensionUIContext, req: AskRequest, conn: CloseSource): Promise<string | undefined> {
	return ui.custom<string | undefined>(
		(tui, theme, _kb, done) => {
			let value = "";
			let paste: string | undefined;
			let settled = false;
			const deadline = Date.now() + TIMEOUT_MS;

			const stop = () => {
				settled = true;
				clearTimeout(timer);
				clearInterval(tick);
				conn.off("close", onClose);
			};
			const finish = (secret?: string) => {
				if (settled) return;
				stop();
				done(secret);
			};
			const onClose = () => finish();
			const timer = setTimeout(() => finish(), TIMEOUT_MS);
			const tick = setInterval(() => tui.requestRender(), 1000);
			conn.once("close", onClose);

			const handleInput = (data: string): void => {
				if (paste === undefined && data.includes(PASTE_START)) {
					paste = "";
					data = data.replace(PASTE_START, "");
				}
				if (paste !== undefined) {
					paste += data;
					const end = paste.indexOf(PASTE_END);
					if (end === -1) return;
					value += paste.slice(0, end).replace(/\r\n?/g, "\n").replace(PASTE_CONTROL, "");
					const rest = paste.slice(end + PASTE_END.length);
					paste = undefined;
					tui.requestRender();
					if (rest) handleInput(rest);
					return;
				}
				if (matchesKey(data, Key.enter)) return finish(value || undefined);
				if (matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) return finish();
				if (matchesKey(data, Key.backspace)) value = Array.from(value).slice(0, -1).join("");
				else if (matchesKey(data, "ctrl+u")) value = "";
				else {
					const ch = decodeKittyPrintable(data) ?? data;
					if (!TYPED_CONTROL.test(ch)) value += ch;
				}
				tui.requestRender();
			};

			const reasonLines = (width: number) => {
				const lines = wrapTextWithAnsi(req.reason || "none given", width);
				if (lines.length <= MAX_REASON_LINES) return lines;
				const kept = lines.slice(0, MAX_REASON_LINES);
				kept[MAX_REASON_LINES - 1] = truncateToWidth(`${kept[MAX_REASON_LINES - 1]} …`, width, "…");
				return kept;
			};

			const component = {
				focused: false,
				handleInput,
				// Every row is padded to the full width: unpadded cells let the transcript show through.
				// Every segment carries the bg itself, because a nested style reset would drop an outer bg.
				render(width: number): string[] {
					const inner = Math.max(10, width - 4);
					const bg = theme.colors.warning;
					const ink = mixColors(bg, parseColor(colorToOklch(bg).l > 0.6 ? "#000000" : "#ffffff"), 0.9);
					const faint = mixColors(bg, ink, 0.65);
					const paint = (text: string, fg = ink, bold = false) => theme.style(text, { fg, bg, bold });

					const row = (...segments: [string, ReturnType<typeof parseColor>?, boolean?][]) => {
						let used = 0;
						let body = "";
						for (const [text, fg, bold] of segments) {
							const cut = truncateToWidth(text, Math.max(0, inner - used), "…");
							used += visibleWidth(cut);
							body += paint(cut, fg, bold);
						}
						return paint("│ ") + body + paint(" ".repeat(Math.max(0, inner - used))) + paint(" │");
					};

					const title = " pi-ask-secret ";
					const top =
						paint("╭─") + paint(title, ink, true) + paint(`${"─".repeat(Math.max(0, inner + 1 - title.length))}╮`);
					const bottom = paint(`╰${"─".repeat(inner + 2)}╯`);

					const lineCount = value ? value.split("\n").length : 0;
					const mask = "•".repeat(Math.min(Array.from(value).length, MAX_MASK));
					const cursor = (component.focused ? CURSOR_MARKER : "") + renderFakeCursor(" ");

					const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
					const keys = "Enter submit · Esc cancel · Ctrl+U clear";
					const timer = `${left}s`;
					const gap = " ".repeat(Math.max(1, inner - visibleWidth(keys) - visibleWidth(timer)));

					return [
						top,
						...reasonLines(inner - LABEL.length).map((line, i) =>
							row([i === 0 ? LABEL : " ".repeat(LABEL.length), faint], [line, ink, true]),
						),
						row(),
						row(["❯ ", ink, true], [mask, ink, true], [cursor], [lineCount > 1 ? `  ${lineCount} lines` : "", faint]),
						row(),
						row([keys, faint], [gap], [timer, left <= 15 ? ink : faint, left <= 15]),
						bottom,
					];
				},
				invalidate() {},
				// Pi disposes the overlay on shutdown without `done`; the socket teardown fails the caller.
				dispose: stop,
			};
			return component;
		},
		{ overlay: true, overlayOptions: { width: OVERLAY_WIDTH, margin: 1 } },
	);
}
