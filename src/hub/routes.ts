import type { LinkEventType } from "./protocol.ts";
import type * as S from "./protocol.schema.ts";

export type SchemaName = keyof typeof S;
export type RoutePrincipal = "none" | "host" | "host+own";
export type HttpMethod = "GET" | "POST" | "DELETE";
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 426;

/** A query parameter or header: a JSON Schema of its value after parsing. */
export type ParameterSpec = Readonly<Record<string, unknown>>;

export interface RouteSpec {
	readonly principal: RoutePrincipal;
	readonly request?: SchemaName;
	readonly query?: Readonly<Record<string, ParameterSpec>>;
	readonly headers?: Readonly<Record<string, ParameterSpec>>;
	/** `stream`: a `text/event-stream` of the events in `HUB_EVENTS`. */
	readonly response: SchemaName | "stream";
	readonly errors: Readonly<Partial<Record<ErrorStatus, SchemaName>>>;
}

const HOST_ERRORS = { 401: "ErrorBody", 403: "ErrorBody" } as const;
const BODY_ERRORS = { 400: "ErrorBody", ...HOST_ERRORS, 413: "ErrorBody" } as const;
const EVENT_ID = { type: "integer", minimum: 0 } as const;

/** Keys are `METHOD /path`. A `:name` segment is a percent-encoded path parameter. */
export const HUB_ROUTES = {
	"GET /healthz": { principal: "none", response: "Health", errors: {} },
	"GET /agents": {
		principal: "host",
		query: {
			offline: {
				const: "1",
				description: "Also list agents that are offline with no offline time, or that went offline in the last 7 days.",
			},
		},
		response: "AgentsResult",
		errors: HOST_ERRORS,
	},
	"GET /agents/:id": {
		principal: "host",
		response: "AgentInfo",
		errors: { ...HOST_ERRORS, 404: "ErrorBody" },
	},
	"POST /link/register": {
		principal: "host",
		request: "RegisterBody",
		response: "RegisterResult",
		errors: { ...BODY_ERRORS, 426: "UpgradeErrorBody" },
	},
	"GET /link/:agent/events": {
		principal: "host+own",
		query: { lastEventId: EVENT_ID },
		headers: { "Last-Event-ID": { ...EVENT_ID, description: "Wins over the query parameter." } },
		response: "stream",
		errors: HOST_ERRORS,
	},
	"DELETE /link/:agent": { principal: "host+own", response: "OkResult", errors: HOST_ERRORS },
	"POST /link/:agent/ack": { principal: "host+own", request: "AckBody", response: "AckResult", errors: BODY_ERRORS },
	"POST /link/:agent/state": { principal: "host+own", request: "StateBody", response: "OkResult", errors: BODY_ERRORS },
	"POST /link/:agent/status": {
		principal: "host+own",
		request: "StatusBody",
		response: "StatusResult",
		errors: BODY_ERRORS,
	},
	"POST /link/:agent/tasks/:taskId": {
		principal: "host+own",
		request: "TaskUpdateBody",
		response: "UpdatedTaskResult",
		errors: { ...BODY_ERRORS, 404: "ErrorBody", 409: "ErrorBody" },
	},
	"POST /link/:agent/topics": {
		principal: "host+own",
		request: "TopicsBody",
		response: "TopicsResult",
		errors: BODY_ERRORS,
	},
	"POST /link/:agent/control": {
		principal: "host+own",
		request: "ControlBody",
		response: "OkResult",
		errors: { ...BODY_ERRORS, 404: "ErrorBody", 409: "ErrorBody" },
	},
	"GET /link/:agent/inbox": {
		principal: "host+own",
		query: {
			unread: { const: "1", description: "Only unread messages." },
			limit: {
				type: "integer",
				minimum: 1,
				maximum: 200,
				default: 20,
				description: "Clamped to 1..200. A missing, zero, or non-number value gives 20.",
			},
		},
		response: "InboxResult",
		errors: HOST_ERRORS,
	},
	"POST /link/:agent/read": { principal: "host+own", request: "ReadBody", response: "ReadResult", errors: BODY_ERRORS },
	"GET /link/:agent/message/:idOrPrefix": {
		principal: "host+own",
		response: "InboxItem",
		errors: { ...HOST_ERRORS, 404: "ErrorBody", 409: "MessageCandidatesErrorBody" },
	},
	"GET /link/:agent/pending": { principal: "host+own", response: "PendingResult", errors: HOST_ERRORS },
	"GET /link/:agent/owed": { principal: "host+own", response: "PendingResult", errors: HOST_ERRORS },
	"GET /link/:agent/thread/:contextOrPrefix": {
		principal: "host+own",
		response: "ThreadResult",
		errors: { ...HOST_ERRORS, 404: "ErrorBody", 409: "ThreadCandidatesErrorBody" },
	},
	"POST /link/:agent/children": {
		principal: "host+own",
		request: "ChildBody",
		response: "RegisterResult",
		errors: { ...BODY_ERRORS, 409: "ErrorBody" },
	},
} as const satisfies Record<`${HttpMethod} /${string}`, RouteSpec>;

export type RouteKey = keyof typeof HUB_ROUTES;

export interface EventSpec {
	readonly payload: SchemaName;
	/** A stored event has a `seq` in its `id:` line, is replayed until acked, and is acked by `seq`. */
	readonly stored: boolean;
}

export const HUB_EVENTS = {
	message: { payload: "MessageEvent", stored: true },
	cancel: { payload: "CancelEvent", stored: true },
	update: { payload: "UpdateEvent", stored: true },
	presence: { payload: "PresenceEvent", stored: true },
	control: { payload: "ControlEvent", stored: true },
	replaced: { payload: "ReplacedEvent", stored: false },
} as const satisfies Record<LinkEventType, EventSpec>;

const MATCHERS = (Object.keys(HUB_ROUTES) as RouteKey[]).map((key) => {
	const [method, path = ""] = key.split(" ");
	return { key, method, segments: path.split("/").filter(Boolean) };
});

/** `segments` are the decoded path segments. */
export function matchRoute(method: string, segments: readonly string[]): RouteKey | undefined {
	for (const route of MATCHERS) {
		if (route.method !== method || route.segments.length !== segments.length) continue;
		if (route.segments.every((part, index) => part.startsWith(":") || part === segments[index])) return route.key;
	}
	return undefined;
}
