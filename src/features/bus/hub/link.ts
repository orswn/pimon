import type { LinkEvent, LinkEventType, RegisterResult } from "@orswn/a2a-hub-protocol";
import { Backoff } from "./backoff.ts";
import { type HubClient, HubHttpError, type Registration } from "./client.ts";
import { SseParser } from "./sse.ts";

export type LinkState = "connecting" | "online" | "retrying" | "stopped";

export interface LinkStatus {
	state: LinkState;
	/** Why the link is not online. */
	reason?: string | undefined;
	/** HTTP status that stopped the link: 401, 403, 426. */
	fatal?: number | undefined;
	failures: number;
}

export type { Registration };

export interface HubLinkOptions {
	client: HubClient;
	registration(): Registration;
	/**
	 * Runs for each event in seq order. The link acks the event after it returns. `false` refuses the event:
	 * the link stops reading, keeps its seq before that event, and does not ack it.
	 */
	onEvent(event: LinkEvent): boolean | void;
	onStatus(status: LinkStatus): void;
	onLinked?(result: RegisterResult): void;
	/** The last seq the previous runtime held, sent as Last-Event-ID. */
	lastSeq?: number | undefined;
	backoff?: Backoff;
	/** Silence after which the stream counts as dead. The hub sends a heartbeat every 15 s. */
	idleMs?: number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	log?(message: string): void;
}

const FATAL = new Set([400, 401, 403, 426]);
const IDLE_MS = 45_000;
const EVENT_TYPES = new Set<LinkEventType>(["message", "cancel", "update", "presence", "control", "replaced"]);

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((done) => {
		if (signal.aborted) return done();
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			done();
		};
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", finish, { once: true });
	});
}

/** Register, open the event stream, ack, and reconnect on backoff. One retry chain per link. */
export class HubLink {
	private readonly options: HubLinkOptions;
	private readonly backoff: Backoff;
	private readonly controller = new AbortController();
	private seq: number | undefined;
	private running: Promise<void> | undefined;
	private acking: Promise<void> = Promise.resolve();
	private current: LinkStatus = { state: "connecting", failures: 0 };

	constructor(options: HubLinkOptions) {
		this.options = options;
		this.backoff = options.backoff ?? new Backoff();
		this.seq = options.lastSeq;
	}

	get status(): LinkStatus {
		return this.current;
	}

	get lastSeq(): number | undefined {
		return this.seq;
	}

	get stopped(): boolean {
		return this.controller.signal.aborted || this.current.state === "stopped";
	}

	start(): void {
		this.running ??= this.loop();
	}

	/** Closes the stream. The hub keeps the agent online for its grace period. */
	async stop(): Promise<void> {
		this.controller.abort();
		await this.running;
		await this.acking;
	}

	/** Sends the registration again, for a changed name. A failure waits for the next reconnect. */
	async reregister(): Promise<void> {
		if (this.current.state !== "online") return;
		try {
			this.options.onLinked?.(await this.options.client.register(this.options.registration()));
		} catch (error) {
			this.log(`register failed: ${(error as Error).message}`);
		}
	}

	private log(message: string): void {
		this.options.log?.(message);
	}

	private setStatus(status: LinkStatus): void {
		this.current = status;
		this.options.onStatus(status);
	}

	private async loop(): Promise<void> {
		const signal = this.controller.signal;
		const sleep = this.options.sleep ?? abortableSleep;
		while (!signal.aborted) {
			this.setStatus({ state: this.backoff.count > 0 ? "retrying" : "connecting", failures: this.backoff.count });
			let reason: string;
			try {
				const registered = await this.options.client.register(this.options.registration());
				const body = await this.options.client.openEvents(this.seq, signal);
				this.backoff.connected();
				this.setStatus({ state: "online", failures: 0 });
				this.options.onLinked?.(registered);
				reason = await this.consume(body, signal);
			} catch (error) {
				if (signal.aborted) break;
				if (error instanceof HubHttpError && FATAL.has(error.status)) {
					this.setStatus({
						state: "stopped",
						reason: error.message,
						fatal: error.status,
						failures: this.backoff.count,
					});
					return;
				}
				reason = (error as Error).message;
			}
			if (signal.aborted || this.current.state === "stopped") break;
			const delay = this.backoff.failed();
			this.log(`link down (${reason}), retry in ${delay} ms`);
			this.setStatus({ state: "retrying", reason, failures: this.backoff.count });
			await sleep(delay, signal);
		}
		if (this.current.state !== "stopped") this.setStatus({ state: "stopped", reason: "closed", failures: 0 });
	}

	/** Returns why the stream ended. */
	private async consume(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
		const reader = body.pipeThrough(new TextDecoderStream()).getReader();
		const parser = new SseParser();
		const onAbort = () => {
			reader.cancel().catch(() => {});
		};
		signal.addEventListener("abort", onAbort, { once: true });
		// A half-open connection sends nothing and never ends. Heartbeats keep a live stream above this bound.
		let idle = false;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		const arm = () => {
			clearTimeout(watchdog);
			watchdog = setTimeout(() => {
				idle = true;
				reader.cancel().catch(() => {});
			}, this.options.idleMs ?? IDLE_MS);
			watchdog.unref?.();
		};
		let first = true;
		try {
			arm();
			for (;;) {
				let chunk: Awaited<ReturnType<typeof reader.read>>;
				try {
					chunk = await reader.read();
				} catch (error) {
					return idle ? "stream idle" : `stream failed: ${(error as Error).message}`;
				}
				if (idle) return "stream idle";
				if (chunk.done) return "stream ended";
				arm();
				let newest: number | undefined;
				for (const frame of parser.feed(chunk.value)) {
					if (frame.event === "replaced") {
						this.setStatus({ state: "stopped", reason: "replaced", failures: 0 });
						this.options.onEvent({ seq: frame.id ?? 0, type: "replaced", payload: {} });
						return "replaced";
					}
					if (!EVENT_TYPES.has(frame.event as LinkEventType) || frame.id === undefined) continue;
					// The hub replays only events after Last-Event-ID. An older first id means its data was reset.
					// TODO(okka): a wiped hub data dir can ack events stored before the first live frame; needs a hub seq epoch at register.
					if (first && this.seq !== undefined && frame.id < this.seq) {
						this.log(`hub seq went back from ${this.seq} to ${frame.id}; starting again`);
						this.seq = undefined;
					}
					first = false;
					if (this.seq !== undefined && frame.id <= this.seq) continue;
					let payload: unknown;
					try {
						payload = JSON.parse(frame.data);
					} catch {
						this.log(`bad event data for seq ${frame.id}`);
						continue;
					}
					let taken: boolean | void = true;
					try {
						taken = this.options.onEvent({ seq: frame.id, type: frame.event, payload } as LinkEvent);
					} catch (error) {
						this.log(`event handler failed: ${(error as Error).message}`);
					}
					if (taken === false) {
						if (newest !== undefined) this.ackUpTo(newest);
						return "event refused";
					}
					this.seq = frame.id;
					newest = frame.id;
				}
				if (newest !== undefined) this.ackUpTo(newest);
			}
		} finally {
			clearTimeout(watchdog);
			signal.removeEventListener("abort", onAbort);
		}
	}

	private ackUpTo(seq: number): void {
		this.acking = this.acking.then(async () => {
			try {
				await this.options.client.ack(seq);
			} catch (error) {
				this.log(`ack ${seq} failed: ${(error as Error).message}`);
			}
		});
	}
}
