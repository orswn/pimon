// Covers CSI, OSC, and the single-char escapes real build tools emit.
const ANSI_PATTERN =
	// oxlint-disable-next-line no-control-regex
	/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

// oxlint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

export function stripAnsi(input: string): string {
	return input.replace(ANSI_PATTERN, "");
}

export function sanitizeLine(input: string): string {
	return stripAnsi(input).replace(CONTROL_PATTERN, "");
}

export function clampText(input: string, maxChars: number): string {
	if (input.length <= maxChars) return input;
	const dropped = input.length - maxChars;
	return `${input.slice(0, maxChars)} …(+${dropped} chars)`;
}

/** Splits on LF, CRLF, and bare CR, and force-breaks a line longer than `maxLineChars`. */
export class LineSplitter {
	private buffer = "";
	private readonly maxLineChars: number;
	private readonly onLine: (line: string) => void;

	constructor(maxLineChars: number, onLine: (line: string) => void) {
		this.maxLineChars = maxLineChars;
		this.onLine = onLine;
	}

	push(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const index = this.buffer.search(/[\r\n]/);
			if (index === -1) break;
			this.take(this.buffer.slice(0, index));
			this.buffer = this.buffer.slice(index + 1);
		}
		while (this.buffer.length > this.maxLineChars) {
			this.take(this.buffer.slice(0, this.maxLineChars));
			this.buffer = this.buffer.slice(this.maxLineChars);
		}
	}

	end(): void {
		const rest = this.buffer;
		this.buffer = "";
		this.take(rest);
	}

	private take(raw: string): void {
		const line = sanitizeLine(raw);
		// CRLF yields an empty line per break, and blank lines are not worth a digest slot.
		if (line.length === 0) return;
		this.onLine(line);
	}
}
