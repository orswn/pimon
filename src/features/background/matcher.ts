// A regex never runs on the main thread: /(a+)+b/ against 28 "a" characters takes about 2 s,
// so a main-thread timer could only observe the stall after it happened. One worker per
// monitor, one line in flight, a bounded queue, and termination on deadline give a hard bound.
import * as fs from "node:fs";
import { Worker } from "node:worker_threads";
import { LIMITS, type MatchMode } from "./options.ts";

interface MatcherHooks {
	onMatch: (line: string) => void;
	/** Fatal for this matcher only. The caller mutes the monitor permanently. */
	onFailure: (reason: string) => void;
}

interface MatcherStats {
	dropped: number;
	inflight: number;
	queued: number;
}

export interface Matcher {
	readonly mode: MatchMode;
	push(line: string): void;
	stats(): MatcherStats;
	dispose(): void;
}

export function createMatcher(mode: MatchMode, source: string, ignoreCase: boolean, hooks: MatcherHooks): Matcher {
	if (mode === "any") return new AnyMatcher(hooks);
	return mode === "literal"
		? new LiteralMatcher(source, ignoreCase, hooks)
		: new RegexMatcher(source, ignoreCase, hooks);
}

class AnyMatcher implements Matcher {
	readonly mode: MatchMode = "any";
	private readonly hooks: MatcherHooks;
	private disposed = false;

	constructor(hooks: MatcherHooks) {
		this.hooks = hooks;
	}

	push(line: string): void {
		if (!this.disposed) this.hooks.onMatch(line);
	}

	stats(): MatcherStats {
		return { dropped: 0, inflight: 0, queued: 0 };
	}

	dispose(): void {
		this.disposed = true;
	}
}

class LiteralMatcher implements Matcher {
	readonly mode: MatchMode = "literal";
	private readonly needle: string;
	private readonly ignoreCase: boolean;
	private readonly hooks: MatcherHooks;
	private disposed = false;

	constructor(source: string, ignoreCase: boolean, hooks: MatcherHooks) {
		this.needle = ignoreCase ? source.toLowerCase() : source;
		this.ignoreCase = ignoreCase;
		this.hooks = hooks;
	}

	push(line: string): void {
		if (this.disposed) return;
		const haystack = this.ignoreCase ? line.toLowerCase() : line;
		if (haystack.includes(this.needle)) this.hooks.onMatch(line);
	}

	stats(): MatcherStats {
		return { dropped: 0, inflight: 0, queued: 0 };
	}

	dispose(): void {
		this.disposed = true;
	}
}

interface Pending {
	seq: number;
	line: string;
}

type WorkerReply =
	| { type: "ready" }
	| { type: "error"; message?: string }
	| { type: "done"; seq: number; matched: boolean };

class RegexMatcher implements Matcher {
	readonly mode: MatchMode = "regex";
	private readonly hooks: MatcherHooks;
	private worker: Worker | undefined;
	private ready = false;
	private dead = false;
	private queue: Pending[] = [];
	private inflight: Pending | undefined;
	private deadline: ReturnType<typeof setTimeout> | undefined;
	private startTimer: ReturnType<typeof setTimeout> | undefined;
	private seq = 0;
	private dropped = 0;

	constructor(source: string, ignoreCase: boolean, hooks: MatcherHooks) {
		this.hooks = hooks;
		const workerFile = new URL("./matcher-worker.mjs", import.meta.url);
		if (!fs.existsSync(workerFile)) {
			this.dead = true;
			// Fail closed: without isolation a regex must not run at all.
			queueMicrotask(() => hooks.onFailure(`regex isolation unavailable: ${workerFile.pathname} is missing`));
			return;
		}
		try {
			this.worker = new Worker(workerFile, {
				workerData: { source, flags: ignoreCase ? "i" : "" },
				resourceLimits: { maxOldGenerationSizeMb: 64 },
			});
		} catch (error) {
			this.dead = true;
			queueMicrotask(() => hooks.onFailure(`could not start regex worker: ${message(error)}`));
			return;
		}
		this.worker.unref();
		this.worker.on("message", (event: WorkerReply) => this.onMessage(event));
		this.worker.on("error", (error) => this.fail(`regex worker error: ${message(error)}`));
		this.worker.on("exit", (code) => {
			if (!this.dead) this.fail(`regex worker exited unexpectedly with code ${code}`);
		});
		this.startTimer = setTimeout(() => {
			if (!this.ready) this.fail(`regex worker did not start within ${LIMITS.workerStartMs}ms`);
		}, LIMITS.workerStartMs);
		this.startTimer.unref();
	}

	push(line: string): void {
		if (this.dead) return;
		if (this.queue.length >= LIMITS.matchQueueMax) {
			// Drop the oldest: a monitor is worth more when it tracks current output.
			this.queue.shift();
			this.dropped += 1;
		}
		this.queue.push({ seq: ++this.seq, line });
		this.pump();
	}

	stats(): MatcherStats {
		return { dropped: this.dropped, inflight: this.inflight ? 1 : 0, queued: this.queue.length };
	}

	dispose(): void {
		this.dead = true;
		this.clearTimers();
		const worker = this.worker;
		this.worker = undefined;
		if (worker) void worker.terminate();
	}

	private onMessage(event: WorkerReply): void {
		if (this.dead) return;
		if (event.type === "ready") {
			this.ready = true;
			if (this.startTimer) clearTimeout(this.startTimer);
			this.startTimer = undefined;
			this.pump();
			return;
		}
		if (event.type === "error") {
			this.fail(`invalid regex in worker: ${event.message ?? "unknown"}`);
			return;
		}
		if (!this.inflight || event.seq !== this.inflight.seq) return;
		const finished = this.inflight;
		this.inflight = undefined;
		if (this.deadline) clearTimeout(this.deadline);
		this.deadline = undefined;
		if (event.matched) this.hooks.onMatch(finished.line);
		this.pump();
	}

	private pump(): void {
		if (this.dead || !this.ready || this.inflight || !this.worker) return;
		const next = this.queue.shift();
		if (!next) return;
		this.inflight = next;
		this.deadline = setTimeout(() => {
			this.fail(`pattern exceeded ${LIMITS.matchDeadlineMs}ms on one line and was terminated`);
		}, LIMITS.matchDeadlineMs);
		this.deadline.unref();
		try {
			this.worker.postMessage({ type: "line", seq: next.seq, text: next.line });
		} catch (error) {
			this.fail(`could not hand a line to the regex worker: ${message(error)}`);
		}
	}

	private fail(reason: string): void {
		if (this.dead) return;
		this.dispose();
		this.queue = [];
		this.inflight = undefined;
		this.hooks.onFailure(reason);
	}

	private clearTimers(): void {
		if (this.deadline) clearTimeout(this.deadline);
		if (this.startTimer) clearTimeout(this.startTimer);
		this.deadline = undefined;
		this.startTimer = undefined;
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
