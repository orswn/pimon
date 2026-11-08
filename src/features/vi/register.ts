export interface Register {
	text: string;
	/** Linewise text ends with `\n`. */
	linewise: boolean;
	/** Content of each paste marker in `text` at register write. */
	pastes?: ReadonlyMap<number, string>;
}

const MARKER = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g;

export function capturePastes(register: Register, pastes: ReadonlyMap<number, string>): Register {
	if (!register.text.includes("[paste #")) return register;
	const held = new Map<number, string>();
	for (const match of register.text.matchAll(MARKER)) {
		const id = Number(match[1]);
		const content = pastes.get(id);
		if (content !== undefined) held.set(id, content);
	}
	return held.size === 0 ? register : { ...register, pastes: held };
}

/** pi-tui clears and renumbers pastes. A marker stays only when its id still holds the same content. */
export function resolvePastes(register: Register, pastes: ReadonlyMap<number, string>): Register {
	const held = register.pastes;
	if (!held) return register;
	const text = register.text.replace(MARKER, (marker, id: string) => {
		const content = held.get(Number(id));
		return content === undefined || pastes.get(Number(id)) === content ? marker : content;
	});
	return { text, linewise: register.linewise };
}

export type CopyFn = (text: string) => Promise<void>;

export interface ClipboardMirror {
	/** Copies in the background. Only the latest text waits while a copy runs. */
	mirror(text: string): void;
	/** Resolves when no copy runs. */
	idle(): Promise<void>;
}

export function expandMarkers(text: string, pastes: ReadonlyMap<number, string>): string {
	if (!text.includes("[paste #")) return text;
	let result = text;
	for (const [id, content] of pastes) {
		result = result.replace(new RegExp(`\\[paste #${id}( (\\+\\d+ lines|\\d+ chars))?\\]`, "g"), () => content);
	}
	return result;
}

/** Warns once on the first failure and keeps trying on later yanks. */
export function createClipboardMirror(copy: CopyFn, warn: (message: string) => void): ClipboardMirror {
	let pending: string | undefined;
	let running: Promise<void> | undefined;
	let warned = false;
	const pump = async () => {
		while (pending !== undefined) {
			const text = pending;
			pending = undefined;
			try {
				await copy(text);
			} catch (error) {
				if (!warned) {
					warned = true;
					warn(`vi: clipboard copy failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		running = undefined;
	};
	return {
		mirror(text) {
			pending = text;
			running ??= pump();
		},
		idle: () => running ?? Promise.resolve(),
	};
}
