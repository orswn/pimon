import type { Envelope } from "./protocol.ts";

/** Messages and notices that wait for the debounced digest. */
export interface QueuedDigest {
	envelopes: Envelope[];
	notices: string[];
}
