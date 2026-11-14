import { type TSchema, Type } from "typebox";
import { BUS_KINDS, LINK_TASK_STATES } from "./protocol.ts";

// Each `title` equals the export name. The schema generator turns a nested titled schema into a `$ref`.

export const BusKind = Type.Enum(BUS_KINDS, { title: "BusKind" });
export const Wake = Type.Enum(["now", "never"], { title: "Wake" });
export const Priority = Type.Enum(["normal", "important", "urgent"], { title: "Priority" });
export const DeliveryState = Type.Enum(["delivered", "queued", "unconfirmed"], { title: "DeliveryState" });
export const AgentKind = Type.Enum(["pi", "external", "builtin"], { title: "AgentKind" });
export const PrincipalKind = Type.Enum(["host", "peer"], { title: "PrincipalKind" });
export const AgentState = Type.Enum(["busy", "idle"], { title: "AgentState" });
export const LinkTaskState = Type.Enum(LINK_TASK_STATES, { title: "LinkTaskState" });
export const LinkPostState = Type.Enum(["working", "input-required", "completed", "failed", "rejected"], {
	title: "LinkPostState",
});

const Labels = Type.Record(Type.String(), Type.String());
const AgentRef = Type.Object({ agent: Type.String(), name: Type.String() });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const BusMetadata = Type.Object(
	{
		kind: Type.Optional(BusKind),
		wake: Type.Optional(Wake),
		subject: Type.Optional(Type.String()),
		priority: Type.Optional(Priority),
		expectReply: Type.Optional(Type.Boolean()),
		deliveryWait: Type.Optional(Type.Boolean()),
		replyTo: Type.Optional(Type.String()),
		data: Type.Optional(Type.Unknown()),
		delivery: Type.Optional(DeliveryState),
		statusText: Type.Optional(Type.Boolean()),
	},
	{
		title: "BusMetadata",
		description:
			"Shape of `Message.metadata[BUS_EXTENSION_URI]`. Every field is optional. The hub sets `delivery` on a send result and `statusText` on a status message.",
	},
);

export const Sender = Type.Object(
	{
		agent: Type.Optional(Type.String()),
		name: Type.String(),
		kind: Type.Union([AgentKind, PrincipalKind]),
	},
	{ title: "Sender" },
);

export const MessageEvent = Type.Object(
	{
		messageId: Type.String(),
		taskId: Type.Optional(Type.String()),
		contextId: Type.String(),
		from: Sender,
		kind: BusKind,
		wake: Wake,
		subject: Type.Optional(Type.String()),
		priority: Type.Optional(Priority),
		expectReply: Type.Optional(Type.Boolean()),
		replyTo: Type.Optional(Type.String()),
		text: Type.String(),
		data: Type.Optional(Type.Unknown()),
		taskState: Type.Optional(LinkTaskState),
	},
	{ title: "MessageEvent" },
);

export const CancelEvent = Type.Object({ taskId: Type.String() }, { title: "CancelEvent" });

export const UpdateEvent = Type.Object(
	{
		taskId: Type.String(),
		contextId: Type.String(),
		state: LinkTaskState,
		messageId: Type.Optional(
			Type.String({
				description: "Set when the update carried text. It is the id of the inbox row made for the sender.",
			}),
		),
		kind: Type.Optional(BusKind),
		text: Type.Optional(Type.String()),
		artifacts: Type.Optional(
			Type.Array(Type.Object({ name: Type.Optional(Type.String()), text: Type.Optional(Type.String()) })),
		),
		from: AgentRef,
	},
	{ title: "UpdateEvent" },
);

export const PresenceEvent = Type.Object(
	{
		agent: Type.String(),
		name: Type.String(),
		online: Type.Boolean(),
		relation: Type.Enum(["child", "parent", "peer"], {
			description: "`peer`: the agents share an open expect_reply row or a non-terminal task.",
		}),
	},
	{ title: "PresenceEvent" },
);

export const ControlEvent = Type.Object({ action: Type.Literal("close"), from: AgentRef }, { title: "ControlEvent" });

export const ReplacedEvent = Type.Object({}, { title: "ReplacedEvent" });

export const RegisterBody = Type.Object(
	{
		agent: Type.String(),
		name: Type.Optional(Type.String()),
		cwd: Type.Optional(Type.String()),
		role: Type.Optional(Type.String()),
		labels: Type.Optional(Labels),
		parent: Type.Optional(Type.String()),
		topics: Type.Optional(Type.Array(Type.String())),
		ephemeral: Type.Optional(Type.Boolean()),
		protocol: Type.Integer(),
	},
	{ title: "RegisterBody" },
);

export const RegisterResult = Type.Object(
	{ agent: Type.String(), name: Type.String(), host: Type.String() },
	{ title: "RegisterResult" },
);

export const AckBody = Type.Object({ upTo: Type.Integer({ minimum: 0 }) }, { title: "AckBody" });

export const StateBody = Type.Object(
	{ state: AgentState, activity: Type.Optional(Type.String()) },
	{ title: "StateBody" },
);

export const StatusBody = Type.Object({ text: Type.String() }, { title: "StatusBody" });

export const TaskUpdateBody = Type.Object(
	{
		state: LinkPostState,
		text: Type.Optional(Type.String()),
		artifact: Type.Optional(
			Type.Object({
				name: Type.Optional(Type.String()),
				text: Type.Optional(Type.String()),
				data: Type.Optional(Type.Unknown()),
			}),
		),
	},
	{ title: "TaskUpdateBody" },
);

export const TopicsBody = Type.Object(
	{ subscribe: Type.Optional(Type.Array(Type.String())), unsubscribe: Type.Optional(Type.Array(Type.String())) },
	{ title: "TopicsBody" },
);

export const ControlBody = Type.Object(
	{ target: Type.String(), action: Type.Literal("close") },
	{ title: "ControlBody" },
);

export const ReadBody = Type.Object({ ids: Type.Array(Type.String()) }, { title: "ReadBody" });

export const ChildBody = Type.Object(
	{
		id: Type.String(),
		name: Type.Optional(Type.String()),
		role: Type.Optional(Type.String()),
		labels: Type.Optional(Labels),
		cwd: Type.Optional(Type.String()),
	},
	{ title: "ChildBody" },
);

export const InboxItem = Type.Object(
	{
		messageId: Type.String(),
		taskId: Nullable(Type.String()),
		contextId: Type.String(),
		direction: Type.Enum(["in", "out"]),
		from: Sender,
		to: AgentRef,
		kind: BusKind,
		wake: Wake,
		subject: Nullable(Type.String()),
		priority: Nullable(Priority),
		expectReply: Type.Boolean(),
		replyTo: Nullable(Type.String()),
		data: Type.Optional(Type.Unknown()),
		taskState: Type.Optional(
			Type.With(LinkTaskState, {
				description: "The current state of the linked task. Absent when there is no task or it was removed.",
			}),
		),
		text: Type.String(),
		createdAt: Type.String(),
		read: Type.Boolean(),
	},
	{ title: "InboxItem" },
);

export const ThreadResult = Type.Object(
	{ contextId: Type.String(), messages: Type.Array(InboxItem) },
	{ title: "ThreadResult" },
);

export const PendingResult = Type.Object(
	{
		expectReply: Type.Array(
			Type.Object({
				messageId: Type.String(),
				contextId: Type.String(),
				taskId: Nullable(Type.String()),
				agent: Type.String(),
				name: Type.String(),
				createdAt: Type.String(),
			}),
		),
		tasks: Type.Array(
			Type.Object({
				taskId: Type.String(),
				contextId: Type.String(),
				agent: Nullable(Type.String()),
				name: Type.String(),
				state: LinkTaskState,
				createdAt: Type.String(),
			}),
		),
	},
	{
		title: "PendingResult",
		description: "`agent` and `name` name the other side: the recipient in `pending`, the sender in `owed`.",
	},
);

export const AgentInfo = Type.Object(
	{
		id: Type.String(),
		name: Type.String(),
		kind: AgentKind,
		host: Nullable(Type.String()),
		cwd: Nullable(Type.String()),
		role: Nullable(Type.String()),
		labels: Labels,
		parent: Nullable(Type.String()),
		topics: Type.Array(Type.String()),
		online: Type.Boolean(),
		state: AgentState,
		activity: Nullable(Type.String()),
		status: Type.Object({ text: Type.String(), at: Nullable(Type.String()) }),
		lastSeenAt: Nullable(Type.String()),
	},
	{ title: "AgentInfo" },
);

export const Health = Type.Object(
	{ ok: Type.Literal(true), version: Type.String(), agents: Type.Integer() },
	{ title: "Health" },
);

export const OkResult = Type.Object({ ok: Type.Literal(true) }, { title: "OkResult" });

export const AckResult = Type.Object(
	{ acked: Type.Integer({ description: "The number of events that this call acked." }) },
	{ title: "AckResult" },
);

export const StatusResult = Type.Object(
	{ text: Type.String({ description: "The stored text: one line, trimmed, cut to the status length limit." }) },
	{ title: "StatusResult" },
);

export const TopicsResult = Type.Object({ topics: Type.Array(Type.String()) }, { title: "TopicsResult" });

export const ReadResult = Type.Object(
	{ read: Type.Integer({ description: "The number of messages that this call marked read." }) },
	{ title: "ReadResult" },
);

export const InboxResult = Type.Object({ messages: Type.Array(InboxItem) }, { title: "InboxResult" });

export const AgentsResult = Type.Object({ agents: Type.Array(AgentInfo) }, { title: "AgentsResult" });

export const UpdatedTaskResult = Type.Object(
	{
		id: Type.String(),
		contextId: Type.String(),
		status: Type.Object(
			{
				state: Type.Enum([
					"TASK_STATE_SUBMITTED",
					"TASK_STATE_WORKING",
					"TASK_STATE_COMPLETED",
					"TASK_STATE_FAILED",
					"TASK_STATE_CANCELED",
					"TASK_STATE_INPUT_REQUIRED",
					"TASK_STATE_REJECTED",
					"TASK_STATE_AUTH_REQUIRED",
				]),
				timestamp: Type.String(),
			},
			{ additionalProperties: true },
		),
	},
	{
		title: "UpdatedTaskResult",
		description:
			"An A2A 1.0 Task in ProtoJSON. Only the fields that are always present are listed. The A2A spec owns the rest.",
		additionalProperties: true,
	},
);

export const ErrorBody = Type.Object({ error: Type.String() }, { title: "ErrorBody" });

export const UpgradeErrorBody = Type.Object(
	{ error: Type.String(), expected: Type.Integer({ description: "The protocol that the hub speaks." }) },
	{ title: "UpgradeErrorBody" },
);

export const MessageCandidatesErrorBody = Type.Object(
	{
		error: Type.String(),
		candidates: Type.Array(
			Type.Object({
				messageId: Type.String(),
				contextId: Type.String(),
				to: Type.String(),
				from: Type.String({ description: "The sender agent id, else the sender name." }),
				createdAt: Type.String(),
			}),
		),
	},
	{ title: "MessageCandidatesErrorBody" },
);

export const ThreadCandidatesErrorBody = Type.Object(
	{
		error: Type.String(),
		candidates: Type.Array(Type.Object({ contextId: Type.String(), messages: Type.Integer(), lastAt: Type.String() })),
	},
	{ title: "ThreadCandidatesErrorBody" },
);
