import type { FeatureId, WakeMessage } from "./feature.ts";

export interface WakeGateOptions {
	send(message: WakeMessage): void;
	isIdle(): boolean;
	warn(message: string): void;
	fallbackMs?: number;
}

export type WakeFilter = (message: WakeMessage) => WakeMessage;

export interface WakeGate {
	wake(feature: FeatureId, message: WakeMessage): void;
	addFilter(feature: FeatureId, filter: WakeFilter, logError: (message: string, cause: unknown) => void): void;
	hold(): void;
	release(): void;
	shutdown(reason: string): void;
}

export function createWakeGate(options: WakeGateOptions): WakeGate {
	let closed = false;
	let holding = false;
	let held: { feature: FeatureId; message: WakeMessage }[] = [];
	let fallback: ReturnType<typeof setInterval> | undefined;
	const filters: { feature: FeatureId; filter: WakeFilter; logError: (message: string, cause: unknown) => void }[] = [];
	const loggedFeatures = new Set<FeatureId>();

	// Filters run at send time, so a held wake sees the filters and their state at flush time.
	const send = (message: WakeMessage) => {
		let filtered = message;
		for (const { feature, filter, logError } of filters) {
			try {
				filtered = filter(filtered);
			} catch (cause) {
				if (loggedFeatures.has(feature)) continue;
				loggedFeatures.add(feature);
				logError("wake filter failed; the message was sent without it", cause);
			}
		}
		options.send(filtered);
	};

	const stopFallback = () => {
		if (fallback !== undefined) clearInterval(fallback);
		fallback = undefined;
	};

	// Flush synchronously: a timer or await here lets pi start an extra run after an in-run compaction.
	const release = () => {
		if (closed) return;
		holding = false;
		stopFallback();
		const queue = held;
		held = [];
		for (const item of queue) send(item.message);
	};

	const tick = () => {
		if (closed) {
			stopFallback();
			return;
		}
		let idle: boolean;
		try {
			idle = options.isIdle();
		} catch {
			// A stale context throws. Keep the held wakes so that shutdown logs them.
			stopFallback();
			return;
		}
		if (idle) release();
	};

	return {
		wake(feature, message) {
			if (closed) return;
			if (holding) held.push({ feature, message });
			else send(message);
		},
		addFilter(feature, filter, logError) {
			filters.push({ feature, filter, logError });
		},
		hold() {
			if (closed) return;
			holding = true;
			if (fallback !== undefined) return;
			// An aborted compaction and a cancelled, aborted, or failed tree navigation send no release event.
			fallback = setInterval(tick, options.fallbackMs ?? 2_000);
			fallback.unref();
		},
		release,
		shutdown(reason) {
			closed = true;
			holding = false;
			stopFallback();
			const counts = new Map<FeatureId, number>();
			for (const { feature } of held) counts.set(feature, (counts.get(feature) ?? 0) + 1);
			held = [];
			if (counts.size === 0) return;
			const list = [...counts].map(([feature, count]) => `${feature} ${count}`).join(", ");
			options.warn(`dropped held wakes at session_shutdown (${reason}): ${list}`);
		},
	};
}
