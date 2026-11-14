import type { IncomingMessage, ServerResponse } from "node:http";
import type { Engine } from "./engine.ts";
import type { LinkEvent } from "./protocol.ts";

export interface LinkOptions {
	presenceGraceMs: number;
	heartbeatMs: number;
}

interface Stream {
	res: ServerResponse;
	heartbeat: NodeJS.Timeout;
}

export function formatLinkEvent(event: LinkEvent): string {
	return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

/** Owns the open link SSE streams and the presence grace timers. */
export class LinkHub {
	readonly #engine: Engine;
	readonly #options: LinkOptions;
	readonly #streams = new Map<string, Stream>();
	readonly #grace = new Map<string, NodeJS.Timeout>();
	#off: (() => void) | undefined;

	constructor(engine: Engine, options: LinkOptions) {
		this.#engine = engine;
		this.#options = options;
	}

	/** Agents marked online by an earlier run get the grace period to reconnect, so a restart sends no presence churn. */
	start(onlineAgents: string[]): void {
		this.#off = this.#engine.onLink((agentId, event) => {
			const stream = this.#streams.get(agentId);
			if (stream && !stream.res.writableEnded) stream.res.write(formatLinkEvent(event));
		});
		for (const id of onlineAgents) this.#scheduleOffline(id);
	}

	/** `lastEventId` is the last seq the client holds. Ack stays the durable checkpoint. */
	open(agentId: string, req: IncomingMessage, res: ServerResponse, lastEventId?: number): void {
		this.#cancelOffline(agentId);
		const previous = this.#streams.get(agentId);
		if (previous) {
			this.#streams.delete(agentId);
			clearInterval(previous.heartbeat);
			if (!previous.res.writableEnded) previous.res.end("event: replaced\ndata: {}\n\n");
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.flushHeaders();
		const heartbeat = setInterval(() => {
			if (!res.writableEnded) res.write(": hb\n\n");
		}, this.#options.heartbeatMs);
		const stream: Stream = { res, heartbeat };
		this.#streams.set(agentId, stream);
		this.#engine.setOnline(agentId, true);
		for (const event of this.#engine.replay(agentId, lastEventId)) res.write(formatLinkEvent(event));
		const onClose = () => {
			clearInterval(heartbeat);
			if (this.#streams.get(agentId) !== stream) return;
			this.#streams.delete(agentId);
			this.#scheduleOffline(agentId);
		};
		req.on("close", onClose);
		res.on("close", onClose);
	}

	/** The process quit: offline at once. The mailbox stays. */
	offlineNow(agentId: string): void {
		this.#cancelOffline(agentId);
		const stream = this.#streams.get(agentId);
		if (stream) {
			this.#streams.delete(agentId);
			clearInterval(stream.heartbeat);
			if (!stream.res.writableEnded) stream.res.end();
		}
		this.#engine.setOnline(agentId, false);
	}

	#scheduleOffline(agentId: string): void {
		this.#cancelOffline(agentId);
		const timer = setTimeout(() => {
			this.#grace.delete(agentId);
			if (!this.#streams.has(agentId)) this.#engine.setOnline(agentId, false);
		}, this.#options.presenceGraceMs);
		this.#grace.set(agentId, timer);
	}

	#cancelOffline(agentId: string): void {
		const timer = this.#grace.get(agentId);
		if (timer) clearTimeout(timer);
		this.#grace.delete(agentId);
	}

	stop(): void {
		this.#off?.();
		for (const timer of this.#grace.values()) clearTimeout(timer);
		this.#grace.clear();
		for (const stream of this.#streams.values()) {
			clearInterval(stream.heartbeat);
			if (!stream.res.writableEnded) stream.res.end();
		}
		this.#streams.clear();
	}
}
