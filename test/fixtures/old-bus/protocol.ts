/**
 * Wire protocol and shared types for pi-bus.
 *
 * No pi imports here: this file must run under plain `node` for the harness.
 */

export const BUS_PROTOCOL = 1;

export type PeerState = "starting" | "idle" | "busy" | "closing";

export type EnvelopeKind =
	| "note"
	| "question"
	| "answer"
	| "task"
	| "result"
	| "correction"
	| "status"
	| "event"
	| "control";

export type Priority = "normal" | "important" | "urgent";

// `next-turn` remains wire-compatible with older peers and normalizes to `now`.
export type Wake = "now" | "next-turn" | "never";

export function normalizeWake(wake?: Wake): Exclude<Wake, "next-turn"> {
	return wake === "never" ? "never" : "now";
}

export interface PeerRef {
	instanceId: string;
	/**
	 * Stable identity of the host process, unchanged across extension reloads and
	 * session replacement. `instanceId` identifies one endpoint incarnation and
	 * rotates; anything durable, such as a parent link, must use the owner.
	 */
	owner: string;
	name: string;
	pid: number;
	cwd: string;
	sock: string;
	labels: Record<string, string>;
}

export interface PeerRecord extends PeerRef {
	protocol: number;
	host: string;
	topics: string[];
	state: PeerState;
	activity?: string;
	startedAt: number;
	heartbeatAt: number;
	/** Process start time from the OS, used to detect pid recycling. */
	pidBirth?: string;
	sessionFile?: string;
	/** Stable short tag for the session, so a resumed session keeps its identity. */
	session?: string;
	model?: string;
	/** Reader-only: pid is alive but the heartbeat is late. Never persisted. */
	stale?: boolean;
}

export interface Envelope {
	v: number;
	id: string;
	threadId: string;
	corrId?: string;
	replyExpected?: boolean;
	from: PeerRef;
	to: string;
	kind: EnvelopeKind;
	priority: Priority;
	wake: Wake;
	subject?: string;
	body: string;
	data?: unknown;
	createdAt: number;
	expiresAt?: number;
}

export type WireRequest =
	| { v: number; type: "envelope"; envelope: Envelope }
	| { v: number; type: "ping"; from?: string };

export type WireResponse =
	| { type: "ack"; id: string; instanceId: string; name: string; accepted: boolean; reason?: string }
	| {
			type: "pong";
			instanceId: string;
			name: string;
			state: PeerState;
			activity?: string;
			pid: number;
			startedAt: number;
			labels: Record<string, string>;
	  }
	| { type: "error"; reason: string };

export interface DeliveryFailure {
	instanceId: string;
	name: string;
	reason: string;
}

export interface AckNote {
	instanceId: string;
	name: string;
	accepted: boolean;
	reason?: string;
}

export interface SendResult {
	envelope: Envelope;
	matched: PeerRecord[];
	/** Acked by the receiver. The message is in the receiver's hands. */
	delivered: PeerRecord[];
	/**
	 * Written to the socket but never acked, usually a wedged receiver. The
	 * receiver may still process it later, so this is not a delivery failure.
	 */
	unknown: DeliveryFailure[];
	/** Never handed over: no socket, refused, or explicitly rejected. */
	failed: DeliveryFailure[];
	acks: AckNote[];
}

export interface ProbeResult {
	name: string;
	instanceId: string;
	alive: boolean;
	state?: PeerState;
	activity?: string;
	labels?: Record<string, string>;
	rttMs?: number;
	uptimeMs?: number;
	reason?: string;
}

export interface PendingTarget {
	instanceId: string;
	name: string;
	answered: boolean;
	gone: boolean;
}

export interface PendingQuestion {
	envelopeId: string;
	threadId: string;
	to: string;
	/** Per target accounting: one answer must not clear the others. */
	targets: PendingTarget[];
	subject?: string;
	body: string;
	askedAt: number;
	dueAt: number;
	nudged: boolean;
}

export const HEARTBEAT_MS = 5_000;
/** Heartbeat age past which a live pid is reported as blocked. Never a reason to reap. */
export const PEER_STALE_MS = 30_000;
export const DIAL_TIMEOUT_MS = 3_000;
/** Absolute ceiling for one dial, independent of socket idle timeouts. */
export const DIAL_DEADLINE_MS = 5_000;
export const PEER_CACHE_MS = 750;
export const WATCH_MS = 2_000;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_LINE_BYTES = 1_000_000;
export const MAX_FANOUT = 32;
/** Default deadline before an unanswered question is nudged back to the asker. */
export const PENDING_NUDGE_MS = 10 * 60_000;

export function shortId(value: string): string {
	return value.replace(/-/g, "").toLowerCase().slice(0, 12);
}

/** Normalized hex form of an id, or undefined when it is not usable. */
export function idFragment(value: string): string | undefined {
	const hex = (value || "").replace(/-/g, "").toLowerCase();
	if (!/^[0-9a-f]+$/.test(hex)) return undefined;
	if (hex.length < 8) return undefined;
	// A uuid has 32 hex digits. Anything longer is a typo, not a longer id.
	if (hex.length > 32) return undefined;
	return hex;
}

/** Full canonical id form used for identity-pinned addressing. */
export function fullId(value: string): string {
	return value.replace(/-/g, "").toLowerCase();
}

/** True only for a canonical 32 hex digit id, with or without dashes. */
export function isCanonicalId(value: string): boolean {
	return /^[0-9a-f]{32}$/.test(fullId(value || ""));
}

export function nowMs(): number {
	return Date.now();
}

/**
 * Choose the corrId for a reply.
 *
 * An agent-supplied corrId is only trusted when it names a message on this thread.
 * Observed in the wild: a child answered with corrId set to the *asker's instance
 * id*, which matches no question, so an explicit-wins rule would have put a bogus
 * id on the wire and left the asker's question open. The thread's own outstanding
 * question is the better answer whenever the supplied id cannot be recognised.
 */
export function pickCorrId(
	thread: Array<{ id: string }>,
	supplied: string | undefined,
	question: { id: string } | undefined,
): { corrId: string | undefined; rejected: string | undefined } {
	const trimmed = typeof supplied === "string" ? supplied.trim() : "";
	if (!trimmed) return { corrId: question?.id, rejected: undefined };
	const known = thread.some((envelope) => envelope.id === trimmed || envelope.id.replace(/-/g, "").startsWith(trimmed.replace(/-/g, "")));
	if (known) return { corrId: trimmed, rejected: undefined };
	return { corrId: question?.id, rejected: trimmed };
}
