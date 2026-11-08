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

const EXPECTED_EXIT_MS = 10 * 60_000;

interface ExitMark {
	at: number;
	reasons: readonly PeerGone["reason"][] | undefined;
}

/** Owners whose next exit notice was asked for, so it must not start a run. */
export class ExpectedExits {
	private readonly marks = new Map<string, ExitMark>();

	/** No `reasons` matches any reason. Returns a cancel that drops only this mark. */
	expect(owner: string, reasons?: readonly PeerGone["reason"][], now = Date.now()): () => void {
		const mark: ExitMark = { at: now, reasons };
		this.marks.set(owner, mark);
		return () => {
			if (this.marks.get(owner) === mark) this.marks.delete(owner);
		};
	}

	/** Any exit uses up the mark. Only a marked reason inside the window matches. */
	take(owner: string, reason: PeerGone["reason"], now = Date.now()): boolean {
		const mark = this.marks.get(owner);
		this.marks.delete(owner);
		if (!mark || now - mark.at > EXPECTED_EXIT_MS) return false;
		return !mark.reasons || mark.reasons.includes(reason);
	}

	clear(owner: string): void {
		this.marks.delete(owner);
	}
}
