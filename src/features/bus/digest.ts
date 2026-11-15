import type { PendingResult } from "@orswn/a2a-hub-protocol";
import { type BusMessage, senderText, shortId, withoutAskedTasks } from "./protocol.ts";

// Bound digests before injection. Compaction owns history reduction after delivery.
export const MAX_DIGEST_ITEMS = 8;
export const MAX_DIGEST_BYTES = 8_000;
const MAX_DIGEST_BODY_BYTES = 4_000;
export const MAX_STATE_ITEMS = 10;
export const MAX_STATE_CHARS = 1_500;

/** Messages and notices that wait for the debounced digest. */
export interface QueuedDigest {
	messages: BusMessage[];
	notices: string[];
}

interface RenderedDigest {
	text: string;
	included: BusMessage[];
	omitted: BusMessage[];
}

/** Titles of messages this session sent, by message id and task id, so an answer can name its question. */
export type SentTitles = ReadonlyMap<string, string>;

export function truncate(value: string, max = 200): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function indent(value: string): string {
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

function threadTitle(messages: BusMessage[], sent: SentTitles): string {
	const first = messages.find((message) => message.kind !== "event");
	if (!first) return "untitled thread";
	const asked = (first.replyTo && sent.get(first.replyTo)) || (first.taskId && sent.get(first.taskId));
	return truncate(first.subject || asked || first.body, 70);
}

/** Renders under an item and a byte budget. Omitted messages stay unread and are counted. */
export function renderDigest(queued: QueuedDigest, sent: SentTitles = new Map()): RenderedDigest {
	const lines: string[] = [];
	const included: BusMessage[] = [];
	const omitted: BusMessage[] = [];
	const groups = new Map<string, BusMessage[]>();
	for (const message of queued.messages)
		groups.set(message.threadId, [...(groups.get(message.threadId) ?? []), message]);

	let bytes = 0;
	let full = false;
	for (const [threadId, messages] of groups) {
		const title = threadTitle(messages, sent);
		const header = [`Thread: ${title}`, `threadId: ${shortId(threadId)}`];
		let headerWritten = false;
		for (const message of messages) {
			if (full || included.length >= MAX_DIGEST_ITEMS) {
				omitted.push(message);
				full = true;
				continue;
			}
			const block = renderItem(message, title, sent);
			const cost = Buffer.byteLength([...(headerWritten ? [] : header), ...block].join("\n"), "utf8");
			if (bytes + cost > MAX_DIGEST_BYTES && included.length > 0) {
				omitted.push(message);
				full = true;
				continue;
			}
			if (!headerWritten) {
				lines.push(...header);
				headerWritten = true;
			}
			lines.push(...block);
			bytes += cost;
			included.push(message);
		}
		if (headerWritten) lines.push("");
	}

	if (omitted.length > 0) lines.push(`- ${omitted.length} more peer message(s) remain unread.`);
	for (const notice of queued.notices) lines.push(`- ${notice}`);
	return { text: lines.join("\n").trim(), included, omitted };
}

function renderItem(message: BusMessage, title: string, sent: SentTitles): string[] {
	const question = message.replyTo ? sent.get(message.replyTo) : undefined;
	const answering = question ? ` answering your "${truncate(question, 40)}"` : "";
	const state = message.taskState && message.taskState !== "submitted" ? ` task ${message.taskState}` : "";
	const cut = Buffer.byteLength(message.body, "utf8") > MAX_DIGEST_BODY_BYTES;
	const body = cut
		? `${message.body.slice(0, MAX_DIGEST_BODY_BYTES)}\n[truncated; read it with action="read"]`
		: message.body;
	return [
		`- ${message.kind} from ${senderText(message.from)} messageId=${shortId(message.id)}${state}${answering}:`,
		message.subject && message.subject !== title ? indent(`subject: ${message.subject}`) : undefined,
		indent(body),
		message.data === undefined ? undefined : indent(`data: ${truncate(JSON.stringify(message.data), 400)}`),
	].filter((line): line is string => Boolean(line));
}

/** Open work that a compaction summary drops: unread count, what this session waits for, and what it owes. */
export function renderOpenState(unread: number, rawPending: PendingResult, rawOwed: PendingResult): string | undefined {
	const pending = withoutAskedTasks(rawPending);
	const owed = withoutAskedTasks(rawOwed);
	const items = [
		...pending.expectReply.map(
			(entry) => `- Pending question messageId=${shortId(entry.messageId)} to ${entry.name} id:${shortId(entry.agent)}`,
		),
		...pending.tasks.map(
			(task) =>
				`- Pending task ${shortId(task.taskId)} to ${task.name}${task.agent ? ` id:${shortId(task.agent)}` : ""}: ${task.state}`,
		),
		...owed.expectReply.map(
			(entry) =>
				`- Unanswered question messageId=${shortId(entry.messageId)} from ${entry.name} id:${shortId(entry.agent)}`,
		),
		...owed.tasks.map(
			(task) =>
				`- Open task ${shortId(task.taskId)} from ${task.name}${task.agent ? ` id:${shortId(task.agent)}` : ""}: ${task.state}`,
		),
	];
	if (unread === 0 && items.length === 0) return undefined;
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
