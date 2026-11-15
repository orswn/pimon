// No pi imports: these helpers run under plain `node` in process tests.
import type { BusKind, LinkTaskState, PendingResult, Priority, Wake } from "@orswn/a2a-hub-protocol";

export type { AgentInfo, BusKind, Priority, Wake } from "@orswn/a2a-hub-protocol";

/** One bus message as the digest, inbox, and read views show it. */
export interface BusMessage {
	id: string;
	threadId: string;
	taskId?: string | undefined;
	/** `id` is absent for a sender that is a hub principal, not an agent. */
	from: { id?: string | undefined; name: string };
	to?: { id: string; name: string } | undefined;
	direction: "in" | "out";
	kind: BusKind;
	wake: Wake;
	priority?: Priority | undefined;
	subject?: string | undefined;
	body: string;
	data?: unknown;
	expectReply?: boolean | undefined;
	replyTo?: string | undefined;
	taskState?: LinkTaskState | undefined;
	createdAt: number;
}

export const AGENTS_CACHE_MS = 750;
/** Concurrent sends of one fan-out. Not a cap on recipients. */
export const MAX_FANOUT = 32;
export const PENDING_NUDGE_MS = 10 * 60_000;

export const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(["completed", "failed", "canceled", "rejected"]);

const UUID_LIKE = /^[0-9a-f]{8}(-?[0-9a-f]{4}){3}-?[0-9a-f]{12}$/i;

/** 12 hex of a uuid. Other ids, such as an external agent id or a foreign message id, stay whole. */
export function shortId(value: string): string {
	return UUID_LIKE.test(value) ? value.replace(/-/g, "").toLowerCase().slice(0, 12) : value;
}

/** The hub matches a prefix against the stored id, which has the uuid dashes. */
export function dashedPrefix(value: string): string {
	if (!/^[0-9a-f]{1,32}$/i.test(value)) return value;
	const hex = value.toLowerCase();
	return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)]
		.filter(Boolean)
		.join("-");
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

/** A question opens a task too. Its expectReply entry stands for both, so views and counts show it once. */
export function withoutAskedTasks(result: PendingResult): PendingResult {
	const asked = new Set(result.expectReply.map((entry) => entry.taskId).filter((id) => id !== null));
	return { expectReply: result.expectReply, tasks: result.tasks.filter((task) => !asked.has(task.taskId)) };
}

/** `<name> id:<12 hex>`, or only the name for a hub principal without an agent id. */
export function senderText(agent: { id?: string | undefined; name: string }): string {
	return agent.id ? `${agent.name} id:${shortId(agent.id)}` : agent.name;
}
