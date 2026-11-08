import { ago, ownerRef, truncate } from "./digest.ts";
import type { WakePolicy } from "./identity.ts";
import type { PeerGone } from "./node.ts";
import type { Envelope, PendingQuestion } from "./protocol.ts";

export function peerGoneNotice(event: PeerGone): string {
	const who = `${event.record.name} (${ownerRef(event.record)})`;
	const what =
		event.reason === "left"
			? `${who} stopped its bus endpoint. Its process may still run.`
			: event.reason === "recycled"
				? `${who} vanished. Its pid was reused.`
				: `${who} exited.`;
	const owed = event.pending.map((entry) => `"${truncate(entry.subject || entry.body, 60)}"`);
	return owed.length ? `${what} It had ${owed.length} unanswered request(s): ${owed.join(", ")}.` : what;
}

export function lapseNotice(entry: PendingQuestion, now = Date.now()): string {
	const outstanding = entry.targets.filter((target) => !target.answered && !target.gone).map((target) => target.name);
	return `No reply yet from ${outstanding.join(", ")} after ${ago(entry.askedAt, now)} on "${truncate(entry.subject || entry.body, 60)}". Do not resend. Wait, or probe once.`;
}

export interface PeerGoneContext {
	selfOwner: string;
	selfInstanceId: string;
	/** `labels.parent` of this instance. */
	parent: string | undefined;
	policy: WakePolicy;
	unansweredInbound: Envelope[];
}

/** A peer exit wakes only when work is owed to or from that peer, or it is a child, and the wake policy allows it. */
export function peerGoneWakes(event: PeerGone, context: PeerGoneContext): boolean {
	const record = event.record;
	const owedFrom = event.pending.length > 0;
	const owedTo = context.unansweredInbound.some((envelope) =>
		envelope.from.owner ? envelope.from.owner === record.owner : envelope.from.instanceId === record.instanceId,
	);
	const parentLabel = record.labels["parent"];
	const child = parentLabel === context.selfOwner || parentLabel === context.selfInstanceId;
	if (!owedFrom && !owedTo && !child) return false;
	if (context.policy === "none") return false;
	if (context.policy === "parent") {
		return Boolean(context.parent) && (record.owner === context.parent || record.instanceId === context.parent);
	}
	return true;
}
