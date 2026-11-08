// No pi imports: the node, registry, selectors, and protocol modules run under plain `node` in process tests.

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

// TODO(okka): remove when no pi runs the standalone bus extension. Old peers may still send `next-turn`.
export type Wake = "now" | "next-turn" | "never";

export function normalizeWake(wake?: Wake): Exclude<Wake, "next-turn"> {
	return wake === "never" ? "never" : "now";
}

export interface PeerRef {
	instanceId: string;
	/** Stable across reloads and session replacement. `instanceId` rotates per endpoint. */
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
	activity?: string | undefined;
	startedAt: number;
	heartbeatAt: number;
	/** Process start time from the OS, used to detect pid recycling. */
	pidBirth?: string | undefined;
	sessionFile?: string | undefined;
	session?: string | undefined;
	model?: string | undefined;
	/** Reader-only: the pid is alive but the heartbeat is late. Never written. */
	stale?: boolean;
}

export interface Envelope {
	v: number;
	id: string;
	threadId: string;
	corrId?: string | undefined;
	replyExpected?: boolean | undefined;
	from: PeerRef;
	to: string;
	kind: EnvelopeKind;
	priority: Priority;
	wake: Wake;
	subject?: string | undefined;
	body: string;
	data?: unknown;
	createdAt: number;
	expiresAt?: number | undefined;
}

export type WireRequest =
	| { v: number; type: "envelope"; envelope: Envelope }
	| { v: number; type: "ping"; from?: string };

export type WireResponse =
	| { type: "ack"; id: string; instanceId: string; name: string; accepted: boolean; reason?: string | undefined }
	| {
			type: "pong";
			instanceId: string;
			name: string;
			state: PeerState;
			activity?: string | undefined;
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
	reason?: string | undefined;
}

export interface SendResult {
	envelope: Envelope;
	matched: PeerRecord[];
	/** Acked by the receiver. */
	delivered: PeerRecord[];
	/** Written to the socket but never acked. The receiver may still process it. */
	unknown: DeliveryFailure[];
	/** Never handed over. */
	failed: DeliveryFailure[];
	acks: AckNote[];
}

export interface ProbeResult {
	name: string;
	instanceId: string;
	alive: boolean;
	state?: PeerState | undefined;
	activity?: string | undefined;
	labels?: Record<string, string> | undefined;
	rttMs?: number | undefined;
	uptimeMs?: number | undefined;
	reason?: string | undefined;
}

export interface PendingTarget {
	instanceId: string;
	owner?: string | undefined;
	name: string;
	answered: boolean;
	gone: boolean;
}

export interface PendingQuestion {
	envelopeId: string;
	threadId: string;
	to: string;
	/** Per target: one answer must not clear the others. */
	targets: PendingTarget[];
	subject?: string | undefined;
	body: string;
	askedAt: number;
	dueAt: number;
	nudged: boolean;
}

export const HEARTBEAT_MS = 5_000;
/** Heartbeat age past which a live pid is reported as blocked. Never a reason to reap. */
export const PEER_STALE_MS = 30_000;
export const DIAL_TIMEOUT_MS = 3_000;
export const DIAL_DEADLINE_MS = 5_000;
export const PEER_CACHE_MS = 750;
export const WATCH_MS = 2_000;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_LINE_BYTES = 1_000_000;
export const MAX_FANOUT = 32;
export const PENDING_NUDGE_MS = 10 * 60_000;

export function shortId(value: string): string {
	return value.replace(/-/g, "").toLowerCase().slice(0, 12);
}

/** Normalized hex form of an id fragment, or undefined when it is not usable. */
export function idFragment(value: string): string | undefined {
	const hex = (value || "").replace(/-/g, "").toLowerCase();
	if (!/^[0-9a-f]+$/.test(hex)) return undefined;
	if (hex.length < 8) return undefined;
	if (hex.length > 32) return undefined;
	return hex;
}

export function fullId(value: string): string {
	return value.replace(/-/g, "").toLowerCase();
}

export function isCanonicalId(value: string): boolean {
	return /^[0-9a-f]{32}$/.test(fullId(value || ""));
}

/** True when `value` is the id itself or a prefix of it, with or without dashes. */
export function idMatches(id: string, value: string): boolean {
	const want = fullId(value.trim());
	if (!want) return false;
	return fullId(id).startsWith(want);
}

/** Control tokens never go to disk or to the model. */
export function withoutToken(envelope: Envelope): Envelope {
	if (envelope.kind !== "control") return envelope;
	const data = envelope.data;
	if (!data || typeof data !== "object" || Array.isArray(data) || !("token" in data)) return envelope;
	const { token: _token, ...rest } = data as Record<string, unknown>;
	return { ...envelope, data: rest };
}
