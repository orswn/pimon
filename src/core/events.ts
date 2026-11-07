/**
 * Typed events between pimon features. Each feature adds its events with declaration merging:
 *
 *   declare module "../../core/events.ts" {
 *     interface PimonEvents { "goal:state": GoalState }
 *   }
 */
export interface PimonEvents {
	"pimon:session-ready": { reason: string };
}

type Listener<T> = (payload: T) => void;

export interface PimonEventBus {
	on<K extends keyof PimonEvents>(event: K, listener: Listener<PimonEvents[K]>): () => void;
	emit<K extends keyof PimonEvents>(event: K, payload: PimonEvents[K]): void;
}

export function createEventBus(onListenerError: (event: string, error: unknown) => void): PimonEventBus {
	const listeners = new Map<keyof PimonEvents, Set<Listener<never>>>();
	return {
		on(event, listener) {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(listener as Listener<never>);
			return () => {
				set.delete(listener as Listener<never>);
			};
		},
		emit(event, payload) {
			const set = listeners.get(event);
			if (!set) return;
			// Snapshot: a listener added during emit must not run for this event.
			for (const listener of Array.from(set)) {
				try {
					(listener as Listener<typeof payload>)(payload);
				} catch (error) {
					onListenerError(event, error);
				}
			}
		},
	};
}
