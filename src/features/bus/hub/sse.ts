export interface SseFrame {
	id?: number;
	event: string;
	data: string;
}

/** Splits a text/event-stream into frames. Comment lines (heartbeats) are skipped. */
export class SseParser {
	private buffer = "";

	feed(chunk: string): SseFrame[] {
		this.buffer += chunk.replace(/\r\n?/g, "\n");
		const frames: SseFrame[] = [];
		let end = this.buffer.indexOf("\n\n");
		while (end >= 0) {
			const frame = parseFrame(this.buffer.slice(0, end));
			if (frame) frames.push(frame);
			this.buffer = this.buffer.slice(end + 2);
			end = this.buffer.indexOf("\n\n");
		}
		return frames;
	}
}

function parseFrame(text: string): SseFrame | undefined {
	let id: number | undefined;
	let event = "message";
	const data: string[] = [];
	for (const line of text.split("\n")) {
		if (line === "" || line.startsWith(":")) continue;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
		if (field === "id" && /^\d+$/.test(value)) id = Number(value);
		else if (field === "event") event = value;
		else if (field === "data") data.push(value);
	}
	if (data.length === 0) return undefined;
	return id === undefined ? { event, data: data.join("\n") } : { id, event, data: data.join("\n") };
}
