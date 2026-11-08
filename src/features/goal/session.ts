import type { Authority } from "./authority.ts";
import type { Lifecycle } from "./lifecycle.ts";

/** Mutable state of one goal feature instance. The setup hooks, the `/goal` command, and the goal tools share it. */
export interface GoalSession {
	life: Lifecycle;
	sessionId: string | undefined;
	/** Cancels goal-owned work of the current goal, such as the check command. */
	cancel: AbortController | undefined;
	/** A later command wins over an earlier one that is still awaiting. */
	operation: number;
	claimInFlight: boolean;
	/** Bumped on shutdown, so a check that outlives its session writes nothing. */
	sessionEpoch: number;
	/** Human messages of the current run segment. In memory only: a reload is not a human message. */
	authority: Authority;
}
