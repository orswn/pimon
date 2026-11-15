import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { BusMetadata, InboxItem, PendingResult, TaskUpdateBody } from "@orswn/a2a-hub-protocol";
import { ago, truncate } from "./digest.ts";
import {
	HARNESS,
	HUB_PROTOCOL,
	HubHttpError,
	HubUnreachableError,
	type HubClient,
	type SendOutcome,
} from "./hub/client.ts";
import { formatLabels, type WakePolicy } from "./identity.ts";
import {
	type AgentInfo,
	type BusKind,
	MAX_FANOUT,
	type Priority,
	senderText,
	shortId,
	TERMINAL_TASK_STATES,
	type Wake,
	withoutAskedTasks,
} from "./protocol.ts";
import { describeSelector, isUnicastSelector, matchAgents, reachesOffline } from "./selectors.ts";

export const BUS_TOOL_DESCRIPTION =
	"Message other pi sessions through the bus hub. Addressing uses selectors such as id:<session id>, all, role:reviewer, name:x, children, topic:t. Sending never blocks: replies arrive later on their own.";

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
		"set_status",
	] as const),
	target: Type.Optional(
		Type.String({
			description:
				'Selector for send and probe. Examples: "id:<session id>" (one session, stable across reloads and restarts), "name:reviewer-2", "role:reviewer", "parent:<name or id>" (peers with that parent), "children", "self", "host:mars", "state:idle", "state:offline", "topic:build", "label:k=v", "cwd:/path", "all". Combine with | for union, + for intersection, ! to exclude. A cwd: or label: value keeps | and + unless a selector or ! follows, so cwd:/a|bob is one path.',
		}),
	),
	body: Type.Optional(Type.String({ description: "Message text for send and reply. Status text for set_status." })),
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
	| "whoami"
	| "set_status";

export interface BusToolInput {
	action: BusAction;
	target?: string | undefined;
	body?: string | undefined;
	subject?: string | undefined;
	kind?: BusKind | undefined;
	wake?: Wake | undefined;
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

export interface SelfInfo {
	id: string;
	name: string;
	role?: string | undefined;
	parent?: string | undefined;
	labels: Readonly<Record<string, string>>;
	topics: readonly string[];
	cwd: string;
	ephemeral: boolean;
}

/** What the actions need from the running feature. Commands and the tool share it. */
export interface ActionHost {
	wakePolicy: WakePolicy;
	/** The hub client. Throws the short error that says why the bus cannot work: no url, no token, or a fatal link. */
	hub(): HubClient;
	/** Throws before the first session start. */
	self(): SelfInfo;
	hubUrl(): string | undefined;
	/** One line on the link: online, retrying, stopped. */
	linkText(): string;
	/** Hub agents, cached for a short time. */
	agents(includeOffline: boolean): Promise<AgentInfo[]>;
	/** Marks inbox messages read and drops them from the digest queue. */
	markRead(ids: string[]): Promise<void>;
	setTopics(topics: string[]): void;
	/** Stores the one-line status text on the hub, or keeps it until the link is up. Empty text clears it. */
	setStatus(text: string): Promise<{ text: string; sent: boolean }>;
	/** Keeps the title of a sent message or task, so an answer can name it. Tracks a lapse deadline when `expectReply`. */
	sent(entry: { messageId: string; taskIds: string[]; title: string; expectReply: boolean; to: AgentInfo[] }): void;
	/** Publishes status after a change. */
	changed(): void;
	/** The UI status line. */
	statusLine(): string;
}

export interface ActionResult {
	text: string;
	details: Record<string, unknown>;
}

export type DeliveryLine = {
	name: string;
	id?: string | undefined;
	note?: string | undefined;
	taskId?: string | undefined;
} & (
	| { state: "delivered" | "queued" }
	| { state: "unconfirmed"; reason?: string | undefined }
	| { state: "failed"; reason: string }
);

export interface SendResult {
	messageId: string;
	threadId: string;
	lines: DeliveryLine[];
}

export interface SendInit {
	body: string;
	/** Defaults to a new id. */
	messageId?: string | undefined;
	kind?: BusKind | undefined;
	wake?: Wake | undefined;
	priority?: Priority | undefined;
	subject?: string | undefined;
	data?: unknown;
	expectReply?: boolean | undefined;
	threadId?: string | undefined;
	replyTo?: string | undefined;
	taskId?: string | undefined;
}

const REPLY_TARGET_ERROR =
	'reply derives the recipient from messageId. Use action="send" with target to address a peer.';

/** Turns a hub failure into one line for the model. */
export function hubErrorText(error: unknown, url: string | undefined): string {
	if (error instanceof HubUnreachableError)
		return `pi_bus: the hub at ${url ?? "?"} is unreachable (${error.message}). The link retries in the background.`;
	if (error instanceof HubHttpError) {
		if (error.status === 426) {
			const expected = error.body["expected"];
			const version = typeof expected === "number" ? String(expected) : "?";
			return `pi_bus: the hub speaks protocol ${version}, this pimon speaks ${HUB_PROTOCOL}. Update pimon or the hub.`;
		}
		return `pi_bus: the hub refused the request: ${error.message}`;
	}
	return error instanceof Error ? error.message : String(error);
}

async function hubCall<T>(host: ActionHost, run: (hub: HubClient) => Promise<T>): Promise<T> {
	const hub = host.hub();
	try {
		return await run(hub);
	} catch (error) {
		throw new Error(hubErrorText(error, host.hubUrl()), { cause: error });
	}
}

function statusOf(agent: AgentInfo): string | undefined {
	if (!agent.status.text) return undefined;
	const at = agent.status.at ? ` (${ago(Date.parse(agent.status.at))})` : "";
	return `status="${agent.status.text}"${at}`;
}

function describeAgent(agent: AgentInfo): string {
	const harness = agent.labels["harness"];
	return [
		agent.name,
		`id:${shortId(agent.id)}`,
		agent.kind === "session" ? undefined : `kind=${agent.kind}`,
		harness && harness !== HARNESS ? `harness=${harness}` : undefined,
		agent.online ? agent.state : "offline",
		agent.role ? `role=${agent.role}` : undefined,
		agent.host ? `host=${agent.host}` : undefined,
		agent.activity ? `doing="${truncate(agent.activity, 48)}"` : undefined,
		statusOf(agent),
		agent.cwd ? `cwd=${agent.cwd}` : undefined,
	]
		.filter(Boolean)
		.join(" ");
}

/** The hub stored the message and the peer did not ack it within the delivery wait. */
const UNCONFIRMED_TEXT = "stored; the peer did not confirm yet";

export function formatSendResult(headline: string, result: SendResult): string {
	const lines = [`${headline} on thread ${shortId(result.threadId)} (messageId ${shortId(result.messageId)}).`];
	const ref = (line: DeliveryLine) => (line.id ? `id:${shortId(line.id)}` : "principal");
	const group = (state: DeliveryLine["state"], render: (line: DeliveryLine) => string) => {
		const matching = result.lines.filter((line) => line.state === state);
		if (matching.length > 0) lines.push(`${state}: ${matching.map(render).join(", ")}`);
	};
	group("delivered", (line) => `${line.name} (${ref(line)}${line.note ? `, ${line.note}` : ""})`);
	group("queued", (line) => `${line.name} (${ref(line)}${line.note ? `, ${line.note}` : ""})`);
	group(
		"unconfirmed",
		(line) => `${line.name} (${line.state === "unconfirmed" && line.reason ? line.reason : UNCONFIRMED_TEXT})`,
	);
	group("failed", (line) => `${line.name} (${line.state === "failed" ? line.reason : ""})`);
	return lines.join("\n");
}

function handedOver(result: SendResult): boolean {
	return result.lines.some((line) => line.state !== "failed");
}

function lineFor(agent: AgentInfo, outcome: SendOutcome): DeliveryLine {
	if (outcome.state === "failed") return { name: agent.name, id: agent.id, state: "failed", reason: outcome.reason };
	if (outcome.state === "unconfirmed") {
		return { name: agent.name, id: agent.id, state: "unconfirmed", taskId: outcome.taskId, reason: outcome.reason };
	}
	return { name: agent.name, id: agent.id, state: outcome.state, taskId: outcome.taskId };
}

async function pool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await run(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

function isFullId(value: string): boolean {
	return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(value);
}

/** A dashed full id is the context id. Other values go through the hub, which also matches a hex id without dashes. */
async function contextIdFor(hub: HubClient, threadId: string | undefined): Promise<string> {
	if (!threadId) return randomUUID();
	if (isFullId(threadId) && threadId.includes("-")) return threadId;
	try {
		return (await hub.thread(threadId)).contextId;
	} catch (error) {
		if (error instanceof HubHttpError && error.status === 404 && isFullId(threadId)) return threadId;
		if (error instanceof HubHttpError && error.status === 404) throw new Error(`No thread ${threadId}.`);
		if (error instanceof HubHttpError && error.status === 409) throw new Error(`Thread id ${threadId} is ambiguous.`);
		throw error;
	}
}

export async function resolveTargets(host: ActionHost, selector: string): Promise<AgentInfo[]> {
	const self = host.self();
	const agents = await host.agents(reachesOffline(selector));
	return matchAgents(selector, agents, { selfId: self.id, selfName: self.name });
}

/** One message to every matching agent, `MAX_FANOUT` at a time. */
export async function sendToAgents(host: ActionHost, targets: AgentInfo[], init: SendInit): Promise<SendResult> {
	const hub = host.hub();
	const kind = init.kind ?? "note";
	const messageId = init.messageId ?? randomUUID();
	const threadId = await contextIdFor(hub, init.threadId);
	const expectReply = init.expectReply === true || kind === "question";
	const meta: BusMetadata = { kind, wake: init.wake ?? "now" };
	if (init.subject) meta.subject = init.subject;
	if (init.priority && init.priority !== "normal") meta.priority = init.priority;
	if (expectReply) meta.expectReply = true;
	if (init.replyTo) meta.replyTo = init.replyTo;
	if (init.data !== undefined) meta.data = init.data;
	const taskIds: string[] = [];
	const lines = await pool(targets, MAX_FANOUT, async (agent) => {
		const outcome = await hub.sendMessage(agent.id, {
			messageId,
			contextId: threadId,
			taskId: init.taskId,
			text: init.body,
			meta,
		});
		if (outcome.state !== "failed" && outcome.taskId) taskIds.push(outcome.taskId);
		return lineFor(agent, outcome);
	});
	const result = { messageId, threadId, lines };
	if (handedOver(result)) {
		host.sent({
			messageId,
			taskIds,
			title: truncate(init.subject || init.body, 60),
			expectReply,
			to: targets.filter((_agent, index) => lines[index]?.state !== "failed"),
		});
	}
	return result;
}

function settle(host: ActionHost, headline: string, result: SendResult): ActionResult {
	const text = formatSendResult(headline, result);
	if (!handedOver(result)) throw new Error(text);
	host.changed();
	return {
		text,
		details: {
			messageId: result.messageId,
			threadId: result.threadId,
			delivery: result.lines.map((line) => ({ name: line.name, id: line.id, state: line.state })),
		},
	};
}

function whoamiAction(host: ActionHost): ActionResult {
	const self = host.self();
	const url = host.hubUrl();
	const text = [
		`name: ${self.name}`,
		`id: ${self.id} (address as id:${shortId(self.id)}; stable across reloads and restarts)`,
		`session: ${self.ephemeral ? "ephemeral, no session file" : "saved"}`,
		self.role ? `role: ${self.role}` : undefined,
		self.parent ? `parent: id:${shortId(self.parent)}` : undefined,
		`labels: ${formatLabels(self.labels) || "none"}`,
		`topics: ${self.topics.join(", ") || "none"}`,
		`cwd: ${self.cwd}`,
		url ? `hub: ${url} (${host.linkText()})` : "hub: none. Set features.bus.hub.url in pimon.json to use the bus.",
		`wake policy: ${host.wakePolicy}`,
	]
		.filter(Boolean)
		.join("\n");
	return { text, details: { name: self.name, id: self.id } };
}

export async function peersAction(host: ActionHost): Promise<ActionResult> {
	const self = host.self();
	const agents = await hubCall(host, () => host.agents(false));
	const peers = agents.filter((agent) => agent.id !== self.id);
	const text = peers.length === 0 ? "No other sessions are on the bus." : peers.map(describeAgent).join("\n");
	return { text, details: { peers: peers.map((agent) => ({ id: agent.id, name: agent.name, kind: agent.kind })) } };
}

export async function probeAction(host: ActionHost, target: string | undefined): Promise<ActionResult> {
	const selector = target || "all";
	const matches = await hubCall(host, () => resolveTargets(host, selector));
	const text =
		matches.length === 0
			? `Nothing matches ${describeSelector(selector)}.`
			: matches
					.map((agent) =>
						[
							`${agent.name} (id:${shortId(agent.id)})`,
							agent.online ? "online" : "offline",
							agent.online ? `state=${agent.state}` : undefined,
							agent.activity ? `doing="${truncate(agent.activity, 60)}"` : undefined,
							agent.lastSeenAt ? `seen=${ago(Date.parse(agent.lastSeenAt))} ago` : undefined,
							statusOf(agent),
						]
							.filter(Boolean)
							.join(" "),
					)
					.join("\n");
	return {
		text,
		details: { results: matches.map((agent) => ({ id: agent.id, name: agent.name, online: agent.online })) },
	};
}

function initFrom(params: BusToolInput, defaultKind: BusKind): SendInit {
	return {
		body: params.body ?? "",
		kind: params.kind || defaultKind,
		wake: params.wake || "now",
		priority: params.priority,
		subject: params.subject,
		data: params.data,
		expectReply: params.expectReply,
	};
}

/** A `result` or `answer` to the sender of exactly one open task of this session settles that task. */
async function settlesOwedTask(hub: HubClient, targets: AgentInfo[], kind: BusKind): Promise<string | undefined> {
	if ((kind !== "result" && kind !== "answer") || targets.length !== 1) return undefined;
	const owed = await hub.owed();
	const tasks = owed.tasks.filter((task) => task.agent === targets[0]?.id);
	return tasks.length === 1 ? tasks[0]?.taskId : undefined;
}

/** A correction joins the newest open task this session sent to that recipient in that thread. */
async function correctionTask(hub: HubClient, target: AgentInfo, threadId: string): Promise<string | undefined> {
	const pending = await hub.pending();
	return pending.tasks.filter((task) => task.agent === target.id && task.contextId === threadId).at(-1)?.taskId;
}

export async function sendAction(host: ActionHost, params: BusToolInput): Promise<ActionResult> {
	if (!params.target) throw new Error('pi_bus action="send" requires target.');
	if (!params.body) throw new Error('pi_bus action="send" requires body.');
	const target = params.target;
	const init = initFrom(params, "note");
	return hubCall(host, async (hub) => {
		const targets = await resolveTargets(host, target);
		if (targets.length === 0) throw new Error(`No agent matches ${describeSelector(target)}. Nothing was sent.`);
		if (targets.length > 1 && isUnicastSelector(target)) {
			throw new Error(
				`${describeSelector(target)} matches ${targets.length} agents: ${targets.map((agent) => `${agent.name} (id:${shortId(agent.id)})`).join(", ")}. Use id:<session id>. Nothing was sent.`,
			);
		}
		const taskId = await settlesOwedTask(hub, targets, init.kind ?? "note");
		const only = targets[0];
		if (taskId && only) {
			const result = await updateTask(host, hub, taskId, only, init);
			return settle(host, `Sent to ${describeSelector(target)}`, result);
		}
		if (init.kind === "correction" && params.threadId && only && targets.length === 1) {
			const threadId = await contextIdFor(hub, params.threadId);
			const open = await correctionTask(hub, only, threadId);
			const result = await sendToAgents(host, targets, { ...init, threadId, taskId: open });
			return settle(host, `Sent to ${describeSelector(target)}`, result);
		}
		const result = await sendToAgents(host, targets, { ...init, threadId: params.threadId });
		return settle(host, `Sent to ${describeSelector(target)}`, result);
	});
}

/** Completes, interrupts, or reports on a task that this session got, through the link task route. */
async function updateTask(
	host: ActionHost,
	hub: HubClient,
	taskId: string,
	sender: { id?: string | undefined; name: string },
	init: SendInit,
): Promise<SendResult> {
	const kind = init.kind ?? "answer";
	const state: TaskUpdateBody["state"] =
		kind === "question" ? "input-required" : kind === "status" ? "working" : "completed";
	const body: TaskUpdateBody = { state, text: init.body };
	if (state === "completed") body.artifact = { name: "result", text: init.body };
	const updated = await hub.taskUpdate(taskId, body);
	host.changed();
	// The task route has no delivery wait. The hub stored the update; nothing confirms that the sender got it.
	return {
		messageId: updated.status?.message?.messageId ?? taskId,
		threadId: updated.contextId,
		lines: [
			{
				name: sender.name,
				id: sender.id,
				state: "queued",
				note: state === "completed" ? "task completed" : `task ${state}`,
			},
		],
	};
}

const REPLY_STATES: ReadonlySet<BusKind> = new Set(["result", "answer", "question", "status"]);

async function findQuestion(host: ActionHost, hub: HubClient, params: BusToolInput): Promise<InboxItem> {
	const id = params.messageId || params.corrId;
	if (id) {
		try {
			return await hub.message(id);
		} catch (error) {
			if (error instanceof HubHttpError && error.status === 404) throw new Error(`No message ${id}.`);
			if (error instanceof HubHttpError && error.status === 409) {
				throw new Error(`Message id ${id} is ambiguous. Use more characters.`);
			}
			throw error;
		}
	}
	if (params.threadId) {
		let thread: Awaited<ReturnType<HubClient["thread"]>>;
		try {
			thread = await hub.thread(params.threadId);
		} catch (error) {
			if (error instanceof HubHttpError && error.status === 404) throw new Error(`No thread ${params.threadId}.`);
			throw error;
		}
		const self = host.self();
		const latest = thread.messages.filter((item) => item.direction === "in" && item.from.agent !== self.id).at(-1);
		if (!latest) throw new Error(`Thread ${params.threadId} has no inbound message to answer.`);
		return latest;
	}
	throw new Error('pi_bus action="reply" requires messageId: the id shown with the message to answer.');
}

export async function replyAction(host: ActionHost, params: BusToolInput): Promise<ActionResult> {
	if (params.target) throw new Error(REPLY_TARGET_ERROR);
	if (!params.body) throw new Error('pi_bus action="reply" requires body.');
	const init = initFrom(params, "answer");
	return hubCall(host, async (hub) => {
		const self = host.self();
		const question = await findQuestion(host, hub, params);
		if (question.direction === "out" || question.from.agent === self.id) {
			throw new Error(`Message ${shortId(question.messageId)} was sent by this session. ${REPLY_TARGET_ERROR}`);
		}
		const sender = { id: question.from.agent, name: question.from.name };
		const headline = `Replied to ${senderText(sender)}`;
		const live = question.taskId && question.taskState && !TERMINAL_TASK_STATES.has(question.taskState);
		if (live && question.taskId) {
			const owed = await hub.owed();
			if (owed.tasks.some((task) => task.taskId === question.taskId) && REPLY_STATES.has(init.kind ?? "answer")) {
				try {
					return settle(host, headline, await updateTask(host, hub, question.taskId, sender, init));
				} catch (error) {
					if (!(error instanceof HubHttpError && error.status === 409)) throw error;
				}
			} else if (sender.id && (await hub.pending()).tasks.some((task) => task.taskId === question.taskId)) {
				// An answer to a task this session sent and that waits for input continues that task.
				const result = await sendToAgents(host, [agentStub(sender.id, sender.name)], {
					...init,
					threadId: question.contextId,
					taskId: question.taskId,
				});
				return settle(host, headline, result);
			}
		}
		if (!sender.id) {
			throw new Error(
				`Message ${shortId(question.messageId)} came from ${sender.name}, which is not a bus agent, and its task is closed. Reply is not possible.`,
			);
		}
		const result = await sendToAgents(host, [agentStub(sender.id, sender.name)], {
			...init,
			threadId: question.contextId,
			replyTo: question.messageId,
		});
		return settle(host, headline, result);
	});
}

function agentStub(id: string, name: string): AgentInfo {
	return {
		id,
		name,
		kind: "session",
		host: null,
		cwd: null,
		role: null,
		labels: {},
		parent: null,
		topics: [],
		online: true,
		state: "idle",
		activity: null,
		status: { text: "", at: null },
		lastSeenAt: null,
	};
}

function fromRef(item: InboxItem): string {
	return senderText({ id: item.from.agent, name: item.from.name });
}

export async function inboxAction(
	host: ActionHost,
	options: { limit?: number; unreadOnly?: boolean },
): Promise<ActionResult> {
	const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));
	const unreadOnly = options.unreadOnly !== false;
	const shown = await hubCall(host, (hub) => hub.inbox({ unread: unreadOnly, limit }));
	if (shown.length === 0)
		return { text: unreadOnly ? "No unread bus messages." : "No bus messages.", details: { count: 0 } };
	const text = shown
		.map((item) => {
			const unread = item.read ? "" : " unread";
			const task = item.taskState ? ` · task ${item.taskState}` : "";
			return `messageId=${shortId(item.messageId)}${unread} · ${ago(Date.parse(item.createdAt))} ago · ${item.kind} from ${fromRef(item)}${task} · thread ${shortId(item.contextId)}: ${truncate(item.text, INBOX_BODY_CHARS)}`;
		})
		.join("\n");
	// A cut body is not read yet: the reader saw only its start.
	const whole = shown.filter((item) => !item.read && item.text.replace(/\s+/g, " ").trim().length <= INBOX_BODY_CHARS);
	await host.markRead(whole.map((item) => item.messageId));
	host.changed();
	return { text, details: { count: shown.length, markedRead: whole.length } };
}

function formatItems(items: InboxItem[]): string {
	if (items.length === 0) return "Nothing found.";
	return items
		.map((item) => {
			const head = [
				`messageId=${shortId(item.messageId)} threadId=${shortId(item.contextId)}${item.replyTo ? ` replyTo=${shortId(item.replyTo)}` : ""}${item.taskId ? ` task=${shortId(item.taskId)}${item.taskState ? ` ${item.taskState}` : ""}` : ""}`,
				`from=${item.from.name} (${item.from.agent ? `id:${shortId(item.from.agent)}` : "principal"}) to=${item.to.name} (id:${shortId(item.to.agent)})`,
				`kind=${item.kind} wake=${item.wake}${item.expectReply ? " expectReply" : ""} at=${item.createdAt}`,
			].join("\n");
			const data = item.data === undefined ? "" : `\ndata: ${JSON.stringify(item.data, null, 2)}`;
			return `${head}\n${item.subject ? `subject: ${item.subject}\n` : ""}${item.text}${data}`;
		})
		.join("\n\n---\n\n");
}

async function readAction(host: ActionHost, params: { messageId?: string; threadId?: string }): Promise<ActionResult> {
	const { messageId, threadId } = params;
	if (!messageId && !threadId) throw new Error('pi_bus action="read" requires messageId or threadId.');
	const items = await hubCall(host, async (hub) => {
		try {
			if (messageId) return [await hub.message(messageId)];
			return (await hub.thread(threadId ?? "")).messages;
		} catch (error) {
			if (error instanceof HubHttpError && error.status === 404) return [];
			if (error instanceof HubHttpError && error.status === 409) {
				throw new Error(
					`${messageId ? "Message" : "Thread"} id ${messageId ?? threadId} is ambiguous. Use more characters.`,
				);
			}
			throw error;
		}
	});
	await host.markRead(items.filter((item) => item.direction === "in" && !item.read).map((item) => item.messageId));
	host.changed();
	return { text: formatItems(items), details: { count: items.length } };
}

export function formatPending(raw: PendingResult): string {
	const pending = withoutAskedTasks(raw);
	if (pending.expectReply.length === 0 && pending.tasks.length === 0) return "No open questions.";
	const lines: string[] = [];
	for (const entry of pending.expectReply) {
		lines.push(
			`messageId=${shortId(entry.messageId)} asked ${ago(Date.parse(entry.createdAt))} ago on thread ${shortId(entry.contextId)}`,
			`  waiting on: ${entry.name} (id:${shortId(entry.agent)})`,
		);
	}
	for (const task of pending.tasks) {
		lines.push(
			`task ${shortId(task.taskId)} ${task.state}, sent ${ago(Date.parse(task.createdAt))} ago on thread ${shortId(task.contextId)}`,
			`  waiting on: ${task.name}${task.agent ? ` (id:${shortId(task.agent)})` : ""}`,
		);
	}
	return lines.join("\n");
}

export async function pendingAction(host: ActionHost): Promise<ActionResult> {
	const pending = await hubCall(host, (hub) => hub.pending());
	return { text: formatPending(pending), details: { pending } };
}

async function topicAction(
	host: ActionHost,
	action: "subscribe" | "unsubscribe",
	topic: string | undefined,
): Promise<ActionResult> {
	if (!topic) throw new Error(`pi_bus action="${action}" requires topic.`);
	const topics = await hubCall(host, (hub) =>
		hub.topics(action === "subscribe" ? { subscribe: [topic] } : { unsubscribe: [topic] }),
	);
	host.setTopics(topics);
	return { text: `Topics: ${topics.join(", ") || "none"}`, details: { topics } };
}

export function busStatusAction(host: ActionHost): ActionResult {
	const self = host.self();
	const text = [
		host.statusLine(),
		`me: ${self.name} (id:${shortId(self.id)})`,
		`labels: ${formatLabels(self.labels) || "none"}`,
		`hub: ${host.hubUrl() ?? "none"} (${host.linkText()})`,
	].join("\n");
	return { text, details: {} };
}

export async function doctorAction(host: ActionHost, tokenCheck: () => string): Promise<ActionResult> {
	const self = host.self();
	const lines = [
		`identity: ${self.name} id:${shortId(self.id)}`,
		`hub: ${host.hubUrl() ?? "none"}`,
		`token: ${tokenCheck()}`,
		`link: ${host.linkText()}`,
	];
	try {
		const hub = host.hub();
		const health = await hub.health();
		lines.push(`health: ok, hub ${health.version}, ${health.agents} agent(s) online`);
		const agents = await hub.agents(false);
		lines.push(`registered: ${agents.some((agent) => agent.id === self.id) ? "yes" : "no"}`);
		const counts = new Map<string, number>();
		for (const agent of agents) counts.set(agent.name, (counts.get(agent.name) ?? 0) + 1);
		const duplicates = [...counts].filter(([, count]) => count > 1).map(([name]) => name);
		lines.push(`duplicate names: ${duplicates.join(", ") || "none"}`);
	} catch (error) {
		lines.push(`health: ${hubErrorText(error, host.hubUrl())}`);
	}
	lines.push(`wake policy: ${host.wakePolicy}`);
	return { text: lines.join("\n"), details: {} };
}

export async function setStatusAction(host: ActionHost, body: string | undefined): Promise<ActionResult> {
	try {
		const { text, sent } = await host.setStatus(body ?? "");
		const later = sent ? "" : "\nThe hub gets it when the link is back.";
		return { text: `${text ? `Status set: ${text}` : "Status cleared."}${later}`, details: { text, sent } };
	} catch (error) {
		throw new Error(hubErrorText(error, host.hubUrl()), { cause: error });
	}
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
		case "set_status":
			return setStatusAction(host, params.body);
		default:
			throw new Error(`Unknown pi_bus action: ${String(params.action)}`);
	}
}
