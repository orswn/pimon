import type { Lifecycle } from "./lifecycle.ts";

/** Mutable state of one goal feature instance. The setup hooks, the `/goal` command, and the claim tool share it. */
export interface GoalSession {
	life: Lifecycle;
	sessionId: string | undefined;
	/** Cancels the adjudication of the current goal: check command and model call. */
	cancel: AbortController | undefined;
	/** A later command wins over an earlier one that is still awaiting. */
	operation: number;
	claimInFlight: boolean;
	/** Bumped on shutdown, so an adjudication that outlives its session writes nothing. */
	sessionEpoch: number;
}
