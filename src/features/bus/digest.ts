import type { Envelope, PendingQuestion } from "./protocol.ts";
import { shortId } from "./protocol.ts";
import type { QueuedDigest } from "./queue.ts";
import type { BusStore } from "./store.ts";

// Bound digests before injection. Compaction owns history reduction after delivery.
export const MAX_DIGEST_ITEMS = 8;
export const MAX_DIGEST_BYTES = 8_000;
export const MAX_DIGEST_BODY_BYTES = 4_000;
export const MAX_STATE_ITEMS = 10;
export const MAX_STATE_CHARS = 1_500;

export interface RenderedDigest {
	text: string;
	included: Envelope[];
	omitted: Envelope[];
}

export function truncate(value: string, max = 200): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function indent(value: string): string {
	return value
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

export function ago(timestamp: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${Math.round(seconds / 3600)}h`;
}

/** `owner:<12 hex>`, or `id:<12 hex>` for a sender without an owner. */
export function ownerRef(peer: { owner?: string | undefined; instanceId: string }): string {
	return peer.owner ? `owner:${shortId(peer.owner)}` : `id:${shortId(peer.instanceId)}`;
}

function threadTitle(store: BusStore, threadId: string, fallback: Envelope[]): string {
	const thread = store.thread(threadId);
	const source = thread.length > 0 ? thread : fallback;
	const first = source.find((envelope) => envelope.kind !== "event");
	if (!first) return "untitled thread";
	return truncate(first.subject || first.body, 70);
}

/** Renders under an item and a byte budget. Omitted envelopes stay unread and are counted. */
export function renderDigest(store: BusStore, queued: QueuedDigest): RenderedDigest {
	const lines: string[] = [];
	const included: Envelope[] = [];
	const omitted: Envelope[] = [];
	const groups = new Map<string, Envelope[]>();
	for (const envelope of queued.envelopes)
		groups.set(envelope.threadId, [...(groups.get(envelope.threadId) ?? []), envelope]);

	let bytes = 0;
	let full = false;
	for (const [threadId, envelopes] of groups) {
		const header = [`Thread: ${threadTitle(store, threadId, envelopes)}`, `threadId: ${shortId(threadId)}`];
		let headerWritten = false;
		for (const envelope of envelopes) {
			if (full || included.length >= MAX_DIGEST_ITEMS) {
				omitted.push(envelope);
				full = true;
				continue;
			}
			const block = renderItem(store, envelope);
			const cost = Buffer.byteLength([...(headerWritten ? [] : header), ...block].join("\n"), "utf8");
			if (bytes + cost > MAX_DIGEST_BYTES && included.length > 0) {
				omitted.push(envelope);
				full = true;
				continue;
			}
			if (!headerWritten) {
				lines.push(...header);
				headerWritten = true;
			}
			lines.push(...block);
			bytes += cost;
			included.push(envelope);
		}
		if (headerWritten) lines.push("");
	}

	if (omitted.length > 0) lines.push(`- ${omitted.length} more peer message(s) remain unread.`);
	for (const notice of queued.notices) lines.push(`- ${notice}`);
	return { text: lines.join("\n").trim(), included, omitted };
}

function renderItem(store: BusStore, envelope: Envelope): string[] {
	const answers = envelope.corrId ? store.byExactId(envelope.corrId) : undefined;
	const answering = answers ? ` answering your "${truncate(answers.subject || answers.body, 40)}"` : "";
	const cut = Buffer.byteLength(envelope.body, "utf8") > MAX_DIGEST_BODY_BYTES;
	const body = cut
		? `${envelope.body.slice(0, MAX_DIGEST_BODY_BYTES)}\n[truncated; read it with action="read"]`
		: envelope.body;
	return [
		`- ${envelope.kind} from ${envelope.from.name} ${ownerRef(envelope.from)} messageId=${shortId(envelope.id)}${answering}:`,
		envelope.subject ? indent(`subject: ${envelope.subject}`) : undefined,
		indent(body),
		envelope.data === undefined ? undefined : indent(`data: ${truncate(JSON.stringify(envelope.data), 400)}`),
	].filter((line): line is string => Boolean(line));
}

/** Open work that a compaction summary drops: unread count, pending questions, unanswered inbound questions. */
export function renderOpenState(
	unread: number,
	pending: PendingQuestion[],
	unanswered: Envelope[],
): string | undefined {
	if (unread === 0 && pending.length === 0 && unanswered.length === 0) return undefined;
	const items = [
		...pending.map((entry) => {
			const owners = entry.targets
				.filter((target) => !target.answered && !target.gone)
				.map((target) => (target.owner ? `owner:${shortId(target.owner)}` : target.name));
			return `- Pending question messageId=${shortId(entry.envelopeId)} to ${owners.join(", ") || entry.to}: ${truncate(entry.subject || entry.body, 60)}`;
		}),
		...unanswered.map(
			(envelope) =>
				`- Unanswered question messageId=${shortId(envelope.id)} from ${envelope.from.name} ${ownerRef(envelope.from)}: ${truncate(envelope.subject || envelope.body, 60)}`,
		),
	];
	const head = `Bus state kept across compaction. Unread messages: ${unread}.`;
	const lines = [head];
	let size = head.length;
	const reserve = 80;
	let shown = 0;
	for (const item of items) {
		if (shown >= MAX_STATE_ITEMS || size + 1 + item.length > MAX_STATE_CHARS - reserve) break;
		lines.push(item);
		size += 1 + item.length;
		shown++;
	}
	if (shown < items.length)
		lines.push(`- ${items.length - shown} more. Use pi_bus action="pending" or action="inbox".`);
	return lines.join("\n");
}
