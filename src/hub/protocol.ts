import type { Static } from "typebox";
import type * as S from "./protocol.schema.ts";

export const HUB_PROTOCOL = 2;
export const BUS_EXTENSION_URI = "https://github.com/orswn/pimon/a2a/bus/v1";
export const AGENT_HEADER = "x-pimon-agent";

export const BUS_KINDS = ["note", "question", "answer", "task", "result", "correction", "status", "event"] as const;
export type BusKind = (typeof BUS_KINDS)[number];
export const TASK_KINDS: readonly BusKind[] = ["task", "question", "correction"];

export type Wake = Static<typeof S.Wake>;
export type Priority = Static<typeof S.Priority>;
export type DeliveryState = Static<typeof S.DeliveryState>;

/** Shape of `Message.metadata[BUS_EXTENSION_URI]`. Every field is optional. */
export type BusMetadata = Static<typeof S.BusMetadata>;

export type AgentKind = Static<typeof S.AgentKind>;
export type PrincipalKind = Static<typeof S.PrincipalKind>;
export type AgentState = Static<typeof S.AgentState>;

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
export type LinkPostState = Static<typeof S.LinkPostState>;

export type Sender = Static<typeof S.Sender>;
export type MessageEvent = Static<typeof S.MessageEvent>;
export type CancelEvent = Static<typeof S.CancelEvent>;
export type UpdateEvent = Static<typeof S.UpdateEvent>;
export type PresenceEvent = Static<typeof S.PresenceEvent>;
export type ControlEvent = Static<typeof S.ControlEvent>;

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

export type RegisterBody = Static<typeof S.RegisterBody>;
export type RegisterResult = Static<typeof S.RegisterResult>;
export type AckBody = Static<typeof S.AckBody>;
export type StateBody = Static<typeof S.StateBody>;
export type StatusBody = Static<typeof S.StatusBody>;
export type TaskUpdateBody = Static<typeof S.TaskUpdateBody>;
export type TopicsBody = Static<typeof S.TopicsBody>;
export type ControlBody = Static<typeof S.ControlBody>;
export type ReadBody = Static<typeof S.ReadBody>;
export type ChildBody = Static<typeof S.ChildBody>;
export type InboxItem = Static<typeof S.InboxItem>;
export type ThreadResult = Static<typeof S.ThreadResult>;
/** `agent` and `name` name the other side: the recipient in `pending`, the sender in `owed`. */
export type PendingResult = Static<typeof S.PendingResult>;
export type AgentInfo = Static<typeof S.AgentInfo>;
export type Health = Static<typeof S.Health>;

export type OkResult = Static<typeof S.OkResult>;
export type AckResult = Static<typeof S.AckResult>;
export type StatusResult = Static<typeof S.StatusResult>;
export type TopicsResult = Static<typeof S.TopicsResult>;
export type ReadResult = Static<typeof S.ReadResult>;
export type InboxResult = Static<typeof S.InboxResult>;
export type AgentsResult = Static<typeof S.AgentsResult>;
export type UpdatedTaskResult = Static<typeof S.UpdatedTaskResult>;
export type ErrorBody = Static<typeof S.ErrorBody>;
export type UpgradeErrorBody = Static<typeof S.UpgradeErrorBody>;
export type MessageCandidatesErrorBody = Static<typeof S.MessageCandidatesErrorBody>;
export type ThreadCandidatesErrorBody = Static<typeof S.ThreadCandidatesErrorBody>;

export const STATUS_TEXT_MAX = 160;
