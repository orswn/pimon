import { describe, expectTypeOf, it } from "vite-plus/test";
import type * as P from "./protocol.ts";

type BusKind = "note" | "question" | "answer" | "task" | "result" | "correction" | "status" | "event";

type Wake = "now" | "never";
type Priority = "normal" | "important" | "urgent";
type DeliveryState = "delivered" | "queued" | "unconfirmed";
interface BusMetadata {
	kind?: BusKind;
	wake?: Wake;
	subject?: string;
	priority?: Priority;
	expectReply?: boolean;
	deliveryWait?: boolean;
	replyTo?: string;
	data?: unknown;
}

type AgentKind = "pi" | "external" | "builtin";
type PrincipalKind = "host" | "peer";
type AgentState = "busy" | "idle";

type LinkTaskState =
	| "submitted"
	| "working"
	| "input-required"
	| "completed"
	| "failed"
	| "canceled"
	| "rejected"
	| "auth-required";
type LinkPostState = "working" | "input-required" | "completed" | "failed" | "rejected";

interface Sender {
	agent?: string;
	name: string;
	kind: AgentKind | PrincipalKind;
}

interface MessageEvent {
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

interface CancelEvent {
	taskId: string;
}

interface UpdateEvent {
	taskId: string;
	contextId: string;
	state: LinkTaskState;
	messageId?: string;
	kind?: BusKind;
	text?: string;
	artifacts?: { name?: string; text?: string }[];
	from: { agent: string; name: string };
}

interface PresenceEvent {
	agent: string;
	name: string;
	online: boolean;
	relation: "child" | "parent" | "peer";
}

interface ControlEvent {
	action: "close";
	from: { agent: string; name: string };
}

interface RegisterBody {
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

interface RegisterResult {
	agent: string;
	name: string;
	host: string;
}

interface AckBody {
	upTo: number;
}

interface StateBody {
	state: AgentState;
	activity?: string;
}

interface StatusBody {
	text: string;
}

interface TaskUpdateBody {
	state: LinkPostState;
	text?: string;
	artifact?: { name?: string; text?: string; data?: unknown };
}

interface TopicsBody {
	subscribe?: string[];
	unsubscribe?: string[];
}

interface ControlBody {
	target: string;
	action: "close";
}

interface ReadBody {
	ids: string[];
}

interface ChildBody {
	id: string;
	name?: string;
	role?: string;
	labels?: Record<string, string>;
	cwd?: string;
}

interface InboxItem {
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
	taskState?: LinkTaskState;
	text: string;
	createdAt: string;
	read: boolean;
}

interface ThreadResult {
	contextId: string;
	messages: InboxItem[];
}
interface PendingResult {
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

interface AgentInfo {
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

interface Health {
	ok: true;
	version: string;
	agents: number;
}

describe("hub protocol types", () => {
	it("derive from the schemas without a change to the earlier interfaces", () => {
		expectTypeOf<P.BusKind>().toEqualTypeOf<BusKind>();
		expectTypeOf<P.Wake>().toEqualTypeOf<Wake>();
		expectTypeOf<P.Priority>().toEqualTypeOf<Priority>();
		expectTypeOf<P.DeliveryState>().toEqualTypeOf<DeliveryState>();
		expectTypeOf<Omit<P.BusMetadata, "delivery" | "statusText">>().toEqualTypeOf<BusMetadata>();
		expectTypeOf<P.AgentKind>().toEqualTypeOf<AgentKind>();
		expectTypeOf<P.PrincipalKind>().toEqualTypeOf<PrincipalKind>();
		expectTypeOf<P.AgentState>().toEqualTypeOf<AgentState>();
		expectTypeOf<P.LinkTaskState>().toEqualTypeOf<LinkTaskState>();
		expectTypeOf<P.LinkPostState>().toEqualTypeOf<LinkPostState>();
		expectTypeOf<P.Sender>().toEqualTypeOf<Sender>();
		expectTypeOf<P.MessageEvent>().toEqualTypeOf<MessageEvent>();
		expectTypeOf<P.CancelEvent>().toEqualTypeOf<CancelEvent>();
		expectTypeOf<P.UpdateEvent>().toEqualTypeOf<UpdateEvent>();
		expectTypeOf<P.PresenceEvent>().toEqualTypeOf<PresenceEvent>();
		expectTypeOf<P.ControlEvent>().toEqualTypeOf<ControlEvent>();
		expectTypeOf<P.RegisterBody>().toEqualTypeOf<RegisterBody>();
		expectTypeOf<P.RegisterResult>().toEqualTypeOf<RegisterResult>();
		expectTypeOf<P.AckBody>().toEqualTypeOf<AckBody>();
		expectTypeOf<P.StateBody>().toEqualTypeOf<StateBody>();
		expectTypeOf<P.StatusBody>().toEqualTypeOf<StatusBody>();
		expectTypeOf<P.TaskUpdateBody>().toEqualTypeOf<TaskUpdateBody>();
		expectTypeOf<P.TopicsBody>().toEqualTypeOf<TopicsBody>();
		expectTypeOf<P.ControlBody>().toEqualTypeOf<ControlBody>();
		expectTypeOf<P.ReadBody>().toEqualTypeOf<ReadBody>();
		expectTypeOf<P.ChildBody>().toEqualTypeOf<ChildBody>();
		expectTypeOf<P.InboxItem>().toEqualTypeOf<InboxItem>();
		expectTypeOf<P.ThreadResult>().toEqualTypeOf<ThreadResult>();
		expectTypeOf<P.PendingResult>().toEqualTypeOf<PendingResult>();
		expectTypeOf<P.AgentInfo>().toEqualTypeOf<AgentInfo>();
		expectTypeOf<P.Health>().toEqualTypeOf<Health>();
	});

	it("add the delivery stamp and the status text mark to the bus metadata", () => {
		expectTypeOf<P.BusMetadata["delivery"]>().toEqualTypeOf<DeliveryState | undefined>();
		expectTypeOf<P.BusMetadata["statusText"]>().toEqualTypeOf<boolean | undefined>();
	});
});
