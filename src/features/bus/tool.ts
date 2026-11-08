import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ago, ownerRef, truncate } from "./digest.ts";
import type { WakePolicy } from "./identity.ts";
import type { BusNode, SendInit } from "./node.ts";
import type { Envelope, EnvelopeKind, PeerRecord, Priority, SendResult } from "./protocol.ts";
import { fullId, shortId } from "./protocol.ts";
import { formatLabels } from "./registry.ts";
import { describeSelector } from "./selectors.ts";
import type { BusStore } from "./store.ts";

export const BUS_TOOL_DESCRIPTION =
	"Message other running pi instances on this host. Addressing uses selectors such as owner:<hex>, all, role:reviewer, name:x, children, topic:t. Sending never blocks: replies arrive later on their own.";

const INBOX_BODY_CHARS = 140;

export const busToolSchema = Type.Object({
	action: StringEnum([
		"peers",
		"probe",
		"send",
		"reply",
		"inbox",
		"read",
		"pending",
		"subscribe",
		"unsubscribe",
		"whoami",
	] as const),
	target: Type.Optional(
		Type.String({
			description:
				'Selector for send and probe. Examples: "owner:1a2b3c4d5e6f" (one process, stable across reloads), "id:<hex>" (one endpoint), "name:reviewer-2", "role:reviewer", "parent:<name or hex>" (peers with that parent), "children", "self", "session:<6 hex tag>", "state:idle", "stale" (late heartbeat), "topic:build", "label:k=v", "cwd:/path", "all". Combine with | for union, + for intersection, ! to exclude. A cwd: or label: value keeps | and + unless a selector or ! follows, so cwd:/a|bob is one path.',
		}),
	),
	body: Type.Optional(Type.String({ description: "Message text for send and reply." })),
	subject: Type.Optional(Type.String({ description: "Short subject line." })),
	kind: Type.Optional(
		StringEnum(["note", "question", "answer", "task", "result", "correction", "status", "event"] as const),
	),
	wake: Type.Optional(
		StringEnum(["now", "never"] as const, {
			description:
				"now: It steers the peer at its next model boundary, or starts a run when the peer is idle. never: only stores the message.",
		}),
	),
	priority: Type.Optional(
		StringEnum(["normal", "important", "urgent"] as const, {
			description: "Only sets the level of the recipient's UI notice.",
		}),
	),
	threadId: Type.Optional(
		Type.String({
			description:
				"Thread to continue for send, or to show for read. For reply without messageId: answers the latest inbound message on the thread.",
		}),
	),
	corrId: Type.Optional(Type.String({ description: "Alias of messageId for reply." })),
	messageId: Type.Optional(
		Type.String({
			description: "Message id or unique prefix. For reply: the message to answer. For read: the message to show.",
		}),
	),
	data: Type.Optional(Type.Unknown({ description: "Structured payload delivered alongside the text." })),
	expectReply: Type.Optional(
		Type.Boolean({ description: "Track this as an open question and remind you if it lapses." }),
	),
	topic: Type.Optional(Type.String({ description: "Topic name for subscribe and unsubscribe." })),
	limit: Type.Optional(Type.Number({ description: "Maximum results.", minimum: 1, maximum: 50 })),
	unreadOnly: Type.Optional(Type.Boolean({ description: "Only unread messages for inbox (default true)." })),
});

type BusAction =
	| "peers"
	| "probe"
	| "send"
	| "reply"
	| "inbox"
	| "read"
	| "pending"
	| "subscribe"
	| "unsubscribe"
	| "whoami";

export interface BusToolInput {
	action: BusAction;
	target?: string | undefined;
	body?: string | undefined;
	subject?: string | undefined;
	kind?: Exclude<EnvelopeKind, "control"> | undefined;
	wake?: "now" | "never" | undefined;
	priority?: Priority | undefined;
	threadId?: string | undefined;
	corrId?: string | undefined;
	messageId?: string | undefined;
	data?: unknown;
	expectReply?: boolean | undefined;
	topic?: string | undefined;
	limit?: number | undefined;
	unreadOnly?: boolean | undefined;
}

/** What the actions need from the running feature. Commands and the tool share it. */
export interface ActionHost {
	/** Throws when the node is not started. */
	node(): BusNode;
	store(): BusStore;
	wakePolicy: WakePolicy;
	/** Marks messages read and drops them from the digest queue. */
	markRead(ids: Iterable<string>): void;
	/** Publishes status after a change. */
	changed(): void;
}

export interface ActionResult {
	text: string;
	details: Record<string, unknown>;
}

const REPLY_TARGET_ERROR =
	'reply derives the recipient from messageId. Use action="send" with target to address a peer.';

function describePeer(peer: PeerRecord): string {
	return [
		peer.name,
		ownerRef(peer),
		peer.stale ? "blocked" : peer.state,
		peer.labels["role"] ? `role=${peer.labels["role"]}` : undefined,
		peer.activity ? `doing="${truncate(peer.activity, 48)}"` : undefined,
		`up=${ago(peer.startedAt)}`,
		`cwd=${peer.cwd}`,
	]
		.filter(Boolean)
		.join(" ");
}

export function formatSendResult(headline: string, result: SendResult): string {
	const lines = [
		`${headline} on thread ${shortId(result.envelope.threadId)} (messageId ${shortId(result.envelope.id)}).`,
	];
	if (result.delivered.length > 0)
		lines.push(`delivered: ${result.delivered.map((peer) => `${peer.name} (${ownerRef(peer)})`).join(", ")}`);
	for (const note of result.acks.filter((ack) => ack.reason)) lines.push(`note from ${note.name}: ${note.reason}`);
	if (result.unknown.length > 0)
		lines.push(`unconfirmed: ${result.unknown.map((peer) => `${peer.name} (${peer.reason})`).join(", ")}`);
	if (result.failed.length > 0)
		lines.push(`failed: ${result.failed.map((peer) => `${peer.name} (${peer.reason})`).join(", ")}`);
	return lines.join("\n");
}

function settle(host: ActionHost, headline: string, result: SendResult): ActionResult {
	const text = formatSendResult(headline, result);
	// Only a handed-over message is stored: a stored reply marks its question answered.
	if (result.delivered.length + result.unknown.length === 0) throw new Error(text);
	host.store().addOutbound(result.envelope);
	host.changed();
	return {
		text,
		details: {
			envelope: host.store().find(result.envelope.id) ?? result.envelope,
			delivered: result.delivered.map((peer) => peer.name),
		},
	};
}

function whoamiAction(host: ActionHost): ActionResult {
	const node = host.node();
	const text = [
		`name: ${node.name}`,
		`owner: ${node.owner} (address as owner:${shortId(node.owner)}; stable across reloads)`,
		`id: ${node.instanceId} (this endpoint; changes on reload)`,
		`session tag: ${node.record.session || "none, this session is ephemeral"}`,
		`labels: ${formatLabels(node.labels) || "none"}`,
		`topics: ${node.topics.join(", ") || "none"}`,
		`cwd: ${node.ref.cwd}`,
		`socket: ${node.socketPath}`,
		`wake policy: ${host.wakePolicy}`,
		"Names are labels only. Address a specific instance by owner.",
	].join("\n");
	return { text, details: { name: node.name, instanceId: node.instanceId, owner: node.owner } };
}

export function peersAction(host: ActionHost): ActionResult {
	const node = host.node();
	const peers = node.peers(0).filter((peer) => peer.instanceId !== node.instanceId);
	const text = peers.length === 0 ? "No other pi instances are on the bus." : peers.map(describePeer).join("\n");
	return { text, details: { peers } };
}

export async function probeAction(host: ActionHost, target: string | undefined): Promise<ActionResult> {
	const selector = target || "all";
	const results = await host.node().probe(selector);
	const text =
		results.length === 0
			? `Nothing matches ${describeSelector(selector)}.`
			: results
					.map((entry) =>
						[
							`${entry.name} (id:${shortId(entry.instanceId)})`,
							entry.alive ? "alive" : "unreachable",
							entry.state ? `state=${entry.state}` : undefined,
							entry.activity ? `doing="${truncate(entry.activity, 60)}"` : undefined,
							entry.rttMs !== undefined ? `rtt=${entry.rttMs}ms` : undefined,
							entry.uptimeMs !== undefined ? `up=${ago(Date.now() - entry.uptimeMs)}` : undefined,
							entry.reason ? `note=${entry.reason}` : undefined,
						]
							.filter(Boolean)
							.join(" "),
					)
					.join("\n");
	return { text, details: { results } };
}

function initFrom(params: BusToolInput, defaultKind: SendInit["kind"]): SendInit {
	const kind = params.kind || defaultKind;
	return {
		body: params.body ?? "",
		kind,
		wake: params.wake || "now",
		priority: params.priority || "normal",
		subject: params.subject,
		data: params.data,
		replyExpected: params.expectReply === true || kind === "question",
	};
}

export async function sendAction(host: ActionHost, params: BusToolInput): Promise<ActionResult> {
	if (!params.target) throw new Error('pi_bus action="send" requires target.');
	if (!params.body) throw new Error('pi_bus action="send" requires body.');
	const result = await host.node().send(params.target, { ...initFrom(params, "note"), threadId: params.threadId });
	return settle(host, `Sent to ${describeSelector(params.target)}`, result);
}

function replyRecipient(envelope: Envelope): string {
	// TODO(okka): remove when no pi runs the standalone bus extension. Very old senders carry no owner.
	return envelope.from.owner ? `owner:${fullId(envelope.from.owner)}` : `id:${fullId(envelope.from.instanceId)}`;
}

export async function replyAction(host: ActionHost, params: BusToolInput): Promise<ActionResult> {
	if (params.target) throw new Error(REPLY_TARGET_ERROR);
	if (!params.body) throw new Error('pi_bus action="reply" requires body.');
	const node = host.node();
	const store = host.store();
	const id = params.messageId || params.corrId;
	let question: Envelope;
	if (id) {
		const found = store.lookup(id);
		if ("error" in found) throw new Error(found.error);
		question = found.envelope;
	} else if (params.threadId) {
		const latest = store.latestInbound(params.threadId);
		if ("error" in latest) throw new Error(latest.error);
		question = latest.envelope;
	} else {
		throw new Error('pi_bus action="reply" requires messageId: the id shown with the message to answer.');
	}
	if (store.isOutbound(question.id) || question.from.instanceId === node.instanceId) {
		throw new Error(`Message ${shortId(question.id)} was sent by this instance. ${REPLY_TARGET_ERROR}`);
	}
	const result = await node.send(replyRecipient(question), {
		...initFrom(params, "answer"),
		threadId: question.threadId,
		corrId: question.id,
	});
	return settle(host, `Replied to ${question.from.name} (${ownerRef(question.from)})`, result);
}

export function inboxAction(host: ActionHost, options: { limit?: number; unreadOnly?: boolean }): ActionResult {
	const store = host.store();
	const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));
	const unreadOnly = options.unreadOnly !== false;
	const shown = store.inbox.filter((envelope) => !unreadOnly || store.unread.has(envelope.id)).slice(-limit);
	if (shown.length === 0)
		return { text: unreadOnly ? "No unread bus messages." : "No bus messages.", details: { count: 0 } };
	const text = [...shown]
		.reverse()
		.map((envelope) => {
			const unread = store.unread.has(envelope.id) ? " unread" : "";
			return `messageId=${shortId(envelope.id)}${unread} · ${ago(envelope.createdAt)} ago · ${envelope.kind} from ${envelope.from.name} ${ownerRef(envelope.from)} · thread ${shortId(envelope.threadId)}: ${truncate(envelope.body, INBOX_BODY_CHARS)}`;
		})
		.join("\n");
	// A cut body is not read yet: the reader saw only its start.
	const whole = shown.filter((envelope) => envelope.body.replace(/\s+/g, " ").trim().length <= INBOX_BODY_CHARS);
	host.markRead(whole.map((envelope) => envelope.id));
	host.changed();
	return { text, details: { count: shown.length, markedRead: whole.length } };
}

function formatEnvelopes(envelopes: Envelope[]): string {
	if (envelopes.length === 0) return "Nothing found.";
	return envelopes
		.map((envelope) => {
			const head = [
				`messageId=${shortId(envelope.id)} threadId=${shortId(envelope.threadId)}${envelope.corrId ? ` corrId=${shortId(envelope.corrId)}` : ""}`,
				`from=${envelope.from.name} (${ownerRef(envelope.from)}) to=${envelope.to}`,
				`kind=${envelope.kind} wake=${envelope.wake}${envelope.replyExpected ? " replyExpected" : ""} at=${new Date(envelope.createdAt).toISOString()}`,
			].join("\n");
			const data = envelope.data === undefined ? "" : `\ndata: ${JSON.stringify(envelope.data, null, 2)}`;
			return `${head}\n${envelope.subject ? `subject: ${envelope.subject}\n` : ""}${envelope.body}${data}`;
		})
		.join("\n\n---\n\n");
}

function readAction(host: ActionHost, params: { messageId?: string; threadId?: string }): ActionResult {
	const store = host.store();
	let envelopes: Envelope[];
	if (params.messageId) {
		const found = store.lookup(params.messageId);
		if ("error" in found) throw new Error(found.error);
		envelopes = [found.envelope];
	} else if (params.threadId) {
		envelopes = store.thread(params.threadId);
	} else {
		throw new Error('pi_bus action="read" requires messageId or threadId.');
	}
	host.markRead(envelopes.map((envelope) => envelope.id));
	host.changed();
	return { text: formatEnvelopes(envelopes), details: { count: envelopes.length } };
}

export function pendingAction(host: ActionHost): ActionResult {
	const pending = host.node().pendingQuestions();
	if (pending.length === 0) return { text: "No open questions.", details: { pending } };
	const text = pending
		.map((entry) => {
			const outstanding = entry.targets
				.filter((target) => !target.answered && !target.gone)
				.map((target) => (target.owner ? `${target.name} (owner:${shortId(target.owner)})` : target.name));
			const answered = entry.targets.filter((target) => target.answered).map((target) => target.name);
			const gone = entry.targets.filter((target) => target.gone).map((target) => target.name);
			return [
				`messageId=${shortId(entry.envelopeId)} asked ${ago(entry.askedAt)} ago on thread ${shortId(entry.threadId)}`,
				`  text: ${truncate(entry.subject || entry.body, 120)}`,
				`  waiting on: ${outstanding.length ? outstanding.join(", ") : "nobody"}`,
				answered.length ? `  answered: ${answered.join(", ")}` : undefined,
				gone.length ? `  gone: ${gone.join(", ")}` : undefined,
			]
				.filter(Boolean)
				.join("\n");
		})
		.join("\n");
	return { text, details: { pending } };
}

function topicAction(host: ActionHost, action: "subscribe" | "unsubscribe", topic: string | undefined): ActionResult {
	if (!topic) throw new Error(`pi_bus action="${action}" requires topic.`);
	const node = host.node();
	if (action === "subscribe") node.subscribe(topic);
	else node.unsubscribe(topic);
	return { text: `Topics: ${node.topics.join(", ") || "none"}`, details: { topics: node.topics } };
}

export function statusText(host: ActionHost, node: BusNode | undefined): string {
	if (!node) return "bus: offline";
	const peers = node.peers().filter((peer) => peer.instanceId !== node.instanceId);
	const unread = host.store().unread.size;
	const pending = node.pendingQuestions().length;
	const parts = [`bus: ${peers.length} peer${peers.length === 1 ? "" : "s"}`];
	if (unread > 0) parts.push(`${unread} unread`);
	if (pending > 0) parts.push(`${pending} awaiting reply`);
	return parts.join(", ");
}

export function busStatusAction(host: ActionHost): ActionResult {
	const node = host.node();
	const text = [
		statusText(host, node),
		`me: ${node.name} (owner:${shortId(node.owner)}, id:${shortId(node.instanceId)})`,
		`labels: ${formatLabels(node.labels) || "none"}`,
		`socket: ${node.socketPath}`,
	].join("\n");
	return { text, details: {} };
}

export async function doctorAction(host: ActionHost): Promise<ActionResult> {
	const node = host.node();
	const peers = node.peers(0);
	const mine = peers.filter((peer) => peer.instanceId === node.instanceId).length;
	const counts = new Map<string, number>();
	for (const peer of peers) counts.set(peer.name, (counts.get(peer.name) ?? 0) + 1);
	const duplicates = [...counts].filter(([, count]) => count > 1).map(([name]) => name);
	const blocked = peers.filter((peer) => peer.stale);
	const probes = await node.probe("all");
	const text = [
		`identity: ${node.name} owner:${shortId(node.owner)} id:${shortId(node.instanceId)}`,
		`socket: ${node.socketPath}`,
		`own presence file visible: ${mine === 1 ? "yes" : `no (${mine} matches)`}`,
		`peers: ${peers.length} total, ${blocked.length} blocked`,
		`duplicate names: ${duplicates.join(", ") || "none"}`,
		`unreachable: ${
			probes
				.filter((entry) => !entry.alive)
				.map((entry) => entry.name)
				.join(", ") || "none"
		}`,
		`wake policy: ${host.wakePolicy}`,
	].join("\n");
	return { text, details: {} };
}

export async function runToolAction(host: ActionHost, params: BusToolInput): Promise<ActionResult> {
	switch (params.action) {
		case "whoami":
			return whoamiAction(host);
		case "peers":
			return peersAction(host);
		case "probe":
			return probeAction(host, params.target);
		case "send":
			return sendAction(host, params);
		case "reply":
			return replyAction(host, params);
		case "inbox":
			return inboxAction(host, {
				...(params.limit !== undefined ? { limit: params.limit } : {}),
				...(params.unreadOnly !== undefined ? { unreadOnly: params.unreadOnly } : {}),
			});
		case "read":
			return readAction(host, {
				...(params.messageId ? { messageId: params.messageId } : {}),
				...(params.threadId ? { threadId: params.threadId } : {}),
			});
		case "pending":
			return pendingAction(host);
		case "subscribe":
		case "unsubscribe":
			return topicAction(host, params.action, params.topic);
		default:
			throw new Error(`Unknown pi_bus action: ${String(params.action)}`);
	}
}
