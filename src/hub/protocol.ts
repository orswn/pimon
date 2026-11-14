export const HUB_PROTOCOL = 2;
export const BUS_EXTENSION_URI = "https://github.com/orswn/pimon/a2a/bus/v1";
export const AGENT_HEADER = "x-pimon-agent";

export const BUS_KINDS = ["note", "question", "answer", "task", "result", "correction", "status", "event"] as const;
export type BusKind = (typeof BUS_KINDS)[number];
export const TASK_KINDS: readonly BusKind[] = ["task", "question", "correction"];

export type Wake = "now" | "never";
export type Priority = "normal" | "important" | "urgent";
export type DeliveryState = "delivered" | "queued" | "unconfirmed";

/** Shape of `Message.metadata[BUS_EXTENSION_URI]`. Every field is optional. */
export interface BusMetadata {
	kind?: BusKind;
	wake?: Wake;
	subject?: string;
	priority?: Priority;
	expectReply?: boolean;
	deliveryWait?: boolean;
	replyTo?: string;
	data?: unknown;
}

export type AgentKind = "pi" | "external" | "builtin";
export type PrincipalKind = "host" | "peer";
export type AgentState = "busy" | "idle";

export const LINK_TASK_STATES = [
	"submitted",
	"working",
	"input-required",
	"completed",
	"failed",
	"canceled",
	"rejected",
	"auth-required",
] as const;
export type LinkTaskState = (typeof LINK_TASK_STATES)[number];
export type LinkPostState = "working" | "input-required" | "completed" | "failed" | "rejected";

export interface Sender {
	agent?: string;
	name: string;
	kind: AgentKind | PrincipalKind;
}

export interface MessageEvent {
	messageId: string;
	taskId?: string;
	contextId: string;
	from: Sender;
	kind: BusKind;
	wake: Wake;
	subject?: string;
	priority?: Priority;
	expectReply?: boolean;
	replyTo?: string;
	text: string;
	data?: unknown;
	taskState?: LinkTaskState;
}

export interface CancelEvent {
	taskId: string;
}

export interface UpdateEvent {
	taskId: string;
	contextId: string;
	state: LinkTaskState;
	/** Set when the update carried text. It is the id of the inbox row made for the sender. */
	messageId?: string;
	kind?: BusKind;
	text?: string;
	artifacts?: { name?: string; text?: string }[];
	from: { agent: string; name: string };
}

export interface PresenceEvent {
	agent: string;
	name: string;
	online: boolean;
	/** `peer`: the agents share an open expect_reply row or a non-terminal task. */
	relation: "child" | "parent" | "peer";
}

export interface ControlEvent {
	action: "close";
	from: { agent: string; name: string };
}

export type ReplacedEvent = Record<string, never>;

export interface LinkEventMap {
	message: MessageEvent;
	cancel: CancelEvent;
	update: UpdateEvent;
	presence: PresenceEvent;
	control: ControlEvent;
	replaced: ReplacedEvent;
}
export type LinkEventType = keyof LinkEventMap;

export interface LinkEvent<T extends LinkEventType = LinkEventType> {
	seq: number;
	type: T;
	payload: LinkEventMap[T];
}

export interface RegisterBody {
	agent: string;
	name?: string;
	cwd?: string;
	role?: string;
	labels?: Record<string, string>;
	parent?: string;
	topics?: string[];
	ephemeral?: boolean;
	protocol: number;
}

export interface RegisterResult {
	agent: string;
	name: string;
	host: string;
}

export interface AckBody {
	upTo: number;
}

export interface StateBody {
	state: AgentState;
	activity?: string;
}

export interface StatusBody {
	text: string;
}

export interface TaskUpdateBody {
	state: LinkPostState;
	text?: string;
	artifact?: { name?: string; text?: string; data?: unknown };
}

export interface TopicsBody {
	subscribe?: string[];
	unsubscribe?: string[];
}

export interface ControlBody {
	target: string;
	action: "close";
}

export interface ReadBody {
	ids: string[];
}

export interface ChildBody {
	id: string;
	name?: string;
	role?: string;
	labels?: Record<string, string>;
	cwd?: string;
}

export interface InboxItem {
	messageId: string;
	taskId: string | null;
	contextId: string;
	direction: "in" | "out";
	from: Sender;
	to: { agent: string; name: string };
	kind: BusKind;
	wake: Wake;
	subject: string | null;
	priority: Priority | null;
	expectReply: boolean;
	replyTo: string | null;
	data?: unknown;
	/** The current state of the linked task. Absent when there is no task or it was removed. */
	taskState?: LinkTaskState;
	text: string;
	createdAt: string;
	read: boolean;
}

export interface ThreadResult {
	contextId: string;
	messages: InboxItem[];
}

/** `agent` and `name` name the other side: the recipient in `pending`, the sender in `owed`. */
export interface PendingResult {
	expectReply: {
		messageId: string;
		contextId: string;
		taskId: string | null;
		agent: string;
		name: string;
		createdAt: string;
	}[];
	tasks: {
		taskId: string;
		contextId: string;
		agent: string | null;
		name: string;
		state: LinkTaskState;
		createdAt: string;
	}[];
}

export interface AgentInfo {
	id: string;
	name: string;
	kind: AgentKind;
	host: string | null;
	cwd: string | null;
	role: string | null;
	labels: Record<string, string>;
	parent: string | null;
	topics: string[];
	online: boolean;
	state: AgentState;
	activity: string | null;
	status: { text: string; at: string | null };
	lastSeenAt: string | null;
}

export interface Health {
	ok: true;
	version: string;
	agents: number;
}

export const STATUS_TEXT_MAX = 160;
