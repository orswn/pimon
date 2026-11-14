import type { Engine, OutboxItem } from "./engine.ts";
import { PushGuard } from "./push-guard.ts";

export const PUSH_TIMEOUT_MS = 10_000;
/** Delay before retry 1, 2, and 3. After the third retry fails, the row is dropped. */
export const PUSH_BACKOFF_MS = [1_000, 5_000, 30_000] as const;
const BATCH = 16;

export interface PushOptions {
	fetch?: typeof fetch;
	now?: () => number;
	timeoutMs?: number;
	log?: (line: string) => void;
	guard?: PushGuard;
}

export function pushHeaders(
	item: Pick<OutboxItem, "token" | "authScheme" | "authCredentials">,
): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/a2a+json" };
	if (item.authScheme && item.authCredentials) {
		headers["Authorization"] = `${item.authScheme} ${item.authCredentials}`;
	} else if (item.token) {
		headers["X-A2A-Notification-Token"] = item.token;
	}
	return headers;
}

/** Sends the push outbox. Rows survive a restart because they live in the database. */
export class PushSender {
	readonly #engine: Engine;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #timeoutMs: number;
	readonly #log: (line: string) => void;
	readonly #guard: PushGuard;
	readonly #inFlight = new Set<number>();
	#timer: NodeJS.Timeout | undefined;
	#timerAt = Number.POSITIVE_INFINITY;
	#off: (() => void) | undefined;
	#stopped = false;

	constructor(engine: Engine, options: PushOptions = {}) {
		this.#engine = engine;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? engine.now;
		this.#timeoutMs = options.timeoutMs ?? PUSH_TIMEOUT_MS;
		this.#log = options.log ?? (() => {});
		this.#guard = options.guard ?? new PushGuard();
	}

	start(): void {
		this.#off = this.#engine.onPush(() => this.#schedule(this.#now()));
		this.#schedule(this.#now());
	}

	stop(): void {
		this.#stopped = true;
		this.#off?.();
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#schedule(at: number): void {
		if (this.#stopped || at >= this.#timerAt) return;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timerAt = at;
		this.#timer = setTimeout(
			() => {
				this.#timer = undefined;
				this.#timerAt = Number.POSITIVE_INFINITY;
				this.run();
			},
			Math.max(0, at - this.#now()),
		);
		this.#timer.unref();
	}

	/** Starts every due delivery, then arms the timer for the next due row. */
	run(): void {
		if (this.#stopped) return;
		for (const item of this.#engine.duePushes(this.#now(), BATCH + this.#inFlight.size)) {
			if (this.#inFlight.has(item.id)) continue;
			this.#inFlight.add(item.id);
			this.deliver(item)
				.catch((error: unknown) => this.#log(`push ${item.id} failed: ${String(error)}`))
				.finally(() => {
					this.#inFlight.delete(item.id);
					this.#schedule(this.#now());
				});
		}
		const next = this.#engine.nextPushAt();
		if (next !== undefined && this.#inFlight.size === 0) this.#schedule(next);
	}

	/**
	 * One attempt. Returns true when the webhook answered 2xx.
	 * The address check runs before each attempt, so a DNS change after config time is caught.
	 * A redirect is not followed: it could lead to a host that the check did not see.
	 */
	async deliver(item: OutboxItem): Promise<boolean> {
		let ok = false;
		let reason = "";
		try {
			const refused = await this.#guard.checkSend(item.url);
			if (refused) {
				reason = refused;
			} else {
				// TODO(okka): the check and fetch resolve the host separately, so a fast DNS rebind can still reach a denied address. Pin the checked address with a node:http lookup hook.
				const response = await this.#fetch(item.url, {
					method: "POST",
					headers: pushHeaders(item),
					body: item.payload,
					redirect: "manual",
					signal: AbortSignal.timeout(this.#timeoutMs),
				});
				ok = response.status >= 200 && response.status < 300;
				reason = `HTTP ${response.status}`;
				await response.body?.cancel();
			}
		} catch (error) {
			reason = error instanceof Error ? error.message : String(error);
		}
		if (this.#stopped) return ok;
		if (ok) {
			this.#engine.pushDone(item.id);
			return true;
		}
		const attempts = item.attempts + 1;
		const delay = PUSH_BACKOFF_MS[attempts - 1];
		if (delay === undefined) {
			this.#log(`push to ${item.url} dropped after ${attempts} attempts: ${reason}`);
			this.#engine.pushDone(item.id);
		} else {
			this.#engine.pushRetry(item.id, attempts, this.#now() + delay);
		}
		return false;
	}
}
