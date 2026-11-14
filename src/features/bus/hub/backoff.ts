export const BACKOFF_FIRST_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** A link that stayed up this long starts the next failure chain at the first delay again. */
export const BACKOFF_RESET_MS = 60_000;
const JITTER = 0.2;

/** 1 s, then doubled per failure, capped at 30 s, with ±20 % jitter. `failures` starts at 1. */
export function backoffDelay(failures: number, random: () => number = Math.random): number {
	const base = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1));
	return Math.round(base * (1 - JITTER + 2 * JITTER * random()));
}

export class Backoff {
	private failures = 0;
	private connectedAt: number | undefined;
	private readonly random: () => number;
	private readonly now: () => number;

	constructor(options: { random?: () => number; now?: () => number } = {}) {
		this.random = options.random ?? Math.random;
		this.now = options.now ?? Date.now;
	}

	connected(): void {
		this.connectedAt = this.now();
	}

	/** The delay before the next attempt. */
	failed(): number {
		if (this.connectedAt !== undefined && this.now() - this.connectedAt >= BACKOFF_RESET_MS) this.failures = 0;
		this.connectedAt = undefined;
		this.failures++;
		return backoffDelay(this.failures, this.random);
	}

	get count(): number {
		return this.failures;
	}
}
