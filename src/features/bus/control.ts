export const RETRY_SHUTDOWN_MS = 8_000;
export const FORCE_EXIT_MS = 20_000;
export const FORCE_POLL_MS = 5_000;

export interface ForcedCloseDeps {
	/** The runtime that was asked to close is gone. Exiting would kill its successor. */
	retired(): boolean;
	shutdown(): void;
	/** Throws on a stale context. */
	isIdle(): boolean;
	exit(): Promise<void>;
}

/**
 * pi defers ctx.shutdown() until idle, and in some modes that moment never comes without input.
 * Ask again, then exit, but only while idle: a busy run must finish and other features must shut down.
 */
export function scheduleForcedClose(deps: ForcedCloseDeps): () => void {
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const later = (ms: number, action: () => void) => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			action();
		}, ms);
		timer.unref?.();
		timers.add(timer);
	};
	later(RETRY_SHUTDOWN_MS, () => {
		if (!deps.retired()) deps.shutdown();
	});
	const force = () => {
		if (deps.retired()) return;
		let idle: boolean;
		try {
			idle = deps.isIdle();
		} catch {
			return;
		}
		if (!idle) {
			later(FORCE_POLL_MS, force);
			return;
		}
		void deps.exit();
	};
	later(FORCE_EXIT_MS, force);
	return () => {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	};
}
