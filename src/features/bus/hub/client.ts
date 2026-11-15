import type {
	AgentInfo,
	BusMetadata,
	ChildBody,
	DeliveryState,
	Health,
	InboxItem,
	PendingResult,
	RegisterBody,
	RegisterResult,
	StateBody,
	TaskUpdateBody,
	ThreadResult,
	TopicsBody,
} from "@orswn/a2a-hub-protocol";
import { dashedPrefix } from "../protocol.ts";

/**
 * Same values as the a2a-hub protocol package. A test pins them to its JSON Schema file, because pi installs
 * pimon without dev dependencies.
 */
export const HUB_PROTOCOL = 3;
export const BUS_EXTENSION_URI = "https://github.com/orswn/a2a-hub/bus/v1";
export const AGENT_HEADER = "X-A2A-Agent";
/** The `harness` label that each registration of this client carries. */
export const HARNESS = "pi";

export const REQUEST_TIMEOUT_MS = 10_000;
/**
 * The hub holds a deliveryWait send for up to 2 s. The send also outlasts the 10 s connect timeout of fetch,
 * so a host that never answered the connect shows as not connected.
 */
export const SEND_TIMEOUT_MS = 15_000;

/** The reason of a send that timed out after the request went out. */
export const NO_ANSWER = "no answer from the hub";

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** The hub answered with an error status. */
export class HubHttpError extends Error {
	readonly status: number;
	readonly body: Record<string, unknown>;

	constructor(status: number, message: string, body: Record<string, unknown> = {}) {
		super(message);
		this.status = status;
		this.body = body;
	}
}

/** No answer from the hub: connection refused, DNS, TLS, or timeout. */
export class HubUnreachableError extends Error {
	readonly timedOut: boolean;

	constructor(message: string, timedOut = false) {
		super(message);
		this.timedOut = timedOut;
	}
}

export interface OutgoingMessage {
	messageId: string;
	contextId: string;
	taskId?: string | undefined;
	text: string;
	meta: BusMetadata;
}

export type SendOutcome =
	| {
			state: DeliveryState;
			contextId: string;
			taskId?: string | undefined;
			taskState?: string | undefined;
			/** Set when the client, not the hub, could not confirm the send. */
			reason?: string | undefined;
	  }
	| { state: "failed"; reason: string };

export interface UpdatedTask {
	id: string;
	contextId: string;
	status?: { message?: { messageId?: string } };
}

/** A registration as the bus builds it. The client adds the agent, the protocol, and the `harness` label. */
export type Registration = Omit<RegisterBody, "agent" | "protocol" | "labels"> & {
	labels?: Record<string, string> | undefined;
};

export interface HubClientOptions {
	url: string;
	token: string;
	/** This agent: the session id. */
	agent: string;
	fetch?: FetchFn;
	timeoutMs?: number;
	sendTimeoutMs?: number;
}

interface SdkTransport {
	sendMessage(
		params: unknown,
		options?: { signal?: AbortSignal; serviceParameters?: Record<string, string> },
	): Promise<unknown>;
}

interface Sdk {
	transport(url: string, fetchImpl: typeof fetch): Promise<SdkTransport>;
	request(json: Record<string, unknown>): unknown;
	toJson(result: unknown): Record<string, unknown>;
}

let sdkLoad: Promise<Sdk> | undefined;

/** The A2A SDK loads on the first send, so a session that never sends pays nothing at start. */
function loadSdk(): Promise<Sdk> {
	sdkLoad ??= (async () => {
		const [core, client] = await Promise.all([import("@a2a-js/sdk"), import("@a2a-js/sdk/client")]);
		return {
			async transport(url, fetchImpl) {
				// No card fetch: the hub's JSON-RPC endpoint is known, so one send is one request.
				const factory = new client.JsonRpcTransportFactory({ fetchImpl });
				return (await factory.create(url, {} as never)) as unknown as SdkTransport;
			},
			request(json) {
				return core.SendMessageRequest.fromJSON(json);
			},
			toJson(result) {
				if (result && typeof result === "object" && "messageId" in result) {
					return { message: core.Message.toJSON(result as never) as Record<string, unknown> };
				}
				return { task: core.Task.toJSON(result as never) as Record<string, unknown> };
			},
		};
	})();
	sdkLoad.catch(() => {
		sdkLoad = undefined;
	});
	return sdkLoad;
}

function enc(value: string): string {
	return encodeURIComponent(value);
}

export class HubClient {
	readonly url: string;
	readonly agent: string;
	private readonly token: string;
	private readonly fetchImpl: FetchFn;
	private readonly timeoutMs: number;
	private readonly sendTimeoutMs: number;

	constructor(options: HubClientOptions) {
		this.url = options.url.replace(/\/+$/, "");
		this.agent = options.agent;
		this.token = options.token;
		this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
		this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
		this.sendTimeoutMs = options.sendTimeoutMs ?? SEND_TIMEOUT_MS;
	}

	private headers(json: boolean): Record<string, string> {
		const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
		if (json) headers["Content-Type"] = "application/json";
		return headers;
	}

	async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const init: RequestInit = {
			method,
			headers: this.headers(body !== undefined),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		};
		if (body !== undefined) init.body = JSON.stringify(body);
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.url}${path}`, init);
		} catch (error) {
			throw unreachable(error, timeout);
		}
		let text: string;
		try {
			text = await response.text();
		} catch (error) {
			throw unreachable(error, timeout);
		}
		let parsed: Record<string, unknown> = {};
		if (text) {
			try {
				parsed = JSON.parse(text) as Record<string, unknown>;
			} catch {
				if (response.ok) throw new HubHttpError(response.status, `hub sent invalid JSON for ${method} ${path}`);
			}
		}
		if (!response.ok) {
			const message = typeof parsed["error"] === "string" ? parsed["error"] : response.statusText || "error";
			throw new HubHttpError(response.status, `${response.status} ${message}`, parsed);
		}
		return parsed as T;
	}

	private link(path: string): string {
		return `/link/${enc(this.agent)}${path}`;
	}

	health(): Promise<Health> {
		return this.call("GET", "/healthz");
	}

	register(registration: Registration): Promise<RegisterResult> {
		const body: RegisterBody = {
			...registration,
			labels: { ...registration.labels, harness: HARNESS },
			agent: this.agent,
			protocol: HUB_PROTOCOL,
		};
		return this.call("POST", "/link/register", body);
	}

	offline(): Promise<unknown> {
		return this.call("DELETE", this.link(""));
	}

	ack(upTo: number): Promise<unknown> {
		return this.call("POST", this.link("/ack"), { upTo });
	}

	state(body: StateBody): Promise<unknown> {
		return this.call("POST", this.link("/state"), body);
	}

	async status(text: string): Promise<string> {
		const result = await this.call<{ text: string }>("POST", this.link("/status"), { text });
		return result.text;
	}

	/** The hub answers with the task. Its status message is the stored update message. */
	taskUpdate(taskId: string, body: TaskUpdateBody): Promise<UpdatedTask> {
		return this.call("POST", this.link(`/tasks/${enc(taskId)}`), body);
	}

	async topics(body: TopicsBody): Promise<string[]> {
		return (await this.call<{ topics: string[] }>("POST", this.link("/topics"), body)).topics;
	}

	control(target: string): Promise<unknown> {
		return this.call("POST", this.link("/control"), { target, action: "close" });
	}

	async inbox(options: { unread: boolean; limit: number }): Promise<InboxItem[]> {
		const query = `?limit=${options.limit}${options.unread ? "&unread=1" : ""}`;
		return (await this.call<{ messages: InboxItem[] }>("GET", this.link(`/inbox${query}`))).messages;
	}

	async read(ids: string[]): Promise<number> {
		if (ids.length === 0) return 0;
		return (await this.call<{ read: number }>("POST", this.link("/read"), { ids })).read;
	}

	message(idOrPrefix: string): Promise<InboxItem> {
		return this.byPrefix((value) => this.call("GET", this.link(`/message/${enc(value)}`)), idOrPrefix);
	}

	thread(contextOrPrefix: string): Promise<ThreadResult> {
		return this.byPrefix((value) => this.call("GET", this.link(`/thread/${enc(value)}`)), contextOrPrefix);
	}

	/** Shown ids drop the uuid dashes. A foreign id that only looks like hex is tried as given too. */
	private async byPrefix<T>(get: (value: string) => Promise<T>, value: string): Promise<T> {
		const dashed = dashedPrefix(value);
		try {
			return await get(dashed);
		} catch (error) {
			if (dashed === value || !(error instanceof HubHttpError) || error.status !== 404) throw error;
			return get(value);
		}
	}

	pending(): Promise<PendingResult> {
		return this.call("GET", this.link("/pending"));
	}

	owed(): Promise<PendingResult> {
		return this.call("GET", this.link("/owed"));
	}

	addChild(body: ChildBody): Promise<RegisterResult> {
		return this.call("POST", this.link("/children"), body);
	}

	async agents(includeOffline = false): Promise<AgentInfo[]> {
		return (await this.call<{ agents: AgentInfo[] }>("GET", `/agents${includeOffline ? "?offline=1" : ""}`)).agents;
	}

	agentInfo(id: string): Promise<AgentInfo> {
		return this.call("GET", `/agents/${enc(id)}`);
	}

	/** Opens the link stream. The caller owns `signal`. A non-200 answer throws `HubHttpError`. */
	async openEvents(lastEventId: number | undefined, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
		const headers = this.headers(false);
		headers["Accept"] = "text/event-stream";
		if (lastEventId !== undefined) headers["Last-Event-ID"] = String(lastEventId);
		let response: Response;
		try {
			response = await this.fetchImpl(`${this.url}${this.link("/events")}`, { method: "GET", headers, signal });
		} catch (error) {
			throw unreachable(error, undefined);
		}
		if (response.status !== 200 || !response.body) {
			let body: Record<string, unknown> = {};
			try {
				body = (await response.json()) as Record<string, unknown>;
			} catch {
				// No JSON body.
			}
			const message = typeof body["error"] === "string" ? body["error"] : response.statusText;
			throw new HubHttpError(response.status, `${response.status} ${message}`, body);
		}
		return response.body;
	}

	/**
	 * One A2A SendMessage to `recipient`, with deliveryWait. A hub answer or a connection that never opened is
	 * `failed`. A timeout or a broken connection after the request went out is `unconfirmed`: the hub may have stored it.
	 */
	async sendMessage(recipient: string, message: OutgoingMessage): Promise<SendOutcome> {
		let sdk: Sdk;
		try {
			sdk = await loadSdk();
		} catch (error) {
			return { state: "failed", reason: `A2A client did not load: ${(error as Error).message}` };
		}
		let sent = false;
		let answered = false;
		let transportError: unknown;
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			headers.set("Authorization", `Bearer ${this.token}`);
			headers.set(AGENT_HEADER, this.agent);
			sent = true;
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			try {
				const response = await this.fetchImpl(url, { ...init, headers });
				answered = true;
				return response;
			} catch (error) {
				transportError = error;
				throw error;
			}
		}) as typeof fetch;
		const wire: Record<string, unknown> = {
			messageId: message.messageId,
			contextId: message.contextId,
			role: "ROLE_USER",
			parts: [{ text: message.text }],
			metadata: { [BUS_EXTENSION_URI]: { ...message.meta, deliveryWait: true } },
		};
		if (message.taskId) wire["taskId"] = message.taskId;
		const timeout = AbortSignal.timeout(this.sendTimeoutMs);
		try {
			const transport = await sdk.transport(`${this.url}/a2a/${enc(recipient)}`, fetchImpl);
			const result = await transport.sendMessage(
				sdk.request({ message: wire, configuration: { returnImmediately: true } }),
				{
					signal: timeout,
					serviceParameters: { "A2A-Version": "1.0", "A2A-Extensions": BUS_EXTENSION_URI },
				},
			);
			return outcomeOf(sdk.toJson(result), message.contextId);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			if (timeout.aborted && sent) {
				return { state: "unconfirmed", contextId: message.contextId, reason: NO_ANSWER };
			}
			if (answered || !sent) return { state: "failed", reason: sent ? text : `hub unreachable: ${text}` };
			const code = (transportError as { cause?: { code?: string } } | undefined)?.cause?.code;
			if (code && NOT_CONNECTED.has(code)) return { state: "failed", reason: `hub unreachable: ${code}` };
			return {
				state: "unconfirmed",
				contextId: message.contextId,
				reason: "the connection to the hub broke",
			};
		}
	}
}

/** Errors that mean the request never reached the hub. */
const NOT_CONNECTED: ReadonlySet<string> = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"UND_ERR_CONNECT_TIMEOUT",
	"ENETUNREACH",
	"EHOSTUNREACH",
]);

function outcomeOf(json: Record<string, unknown>, contextId: string): SendOutcome {
	const item = (json["task"] ?? json["message"]) as
		| { id?: string; contextId?: string; metadata?: Record<string, unknown>; status?: { state?: string } }
		| undefined;
	const stamp = item?.metadata?.[BUS_EXTENSION_URI] as { delivery?: DeliveryState } | undefined;
	const state: DeliveryState = stamp?.delivery ?? "unconfirmed";
	const outcome: SendOutcome = { state, contextId: item?.contextId || contextId };
	if (json["task"] && item?.id) {
		outcome.taskId = item.id;
		if (item.status?.state) outcome.taskState = item.status.state;
	}
	return outcome;
}

function unreachable(error: unknown, timeout: AbortSignal | undefined): Error {
	if (timeout?.aborted) return new HubUnreachableError("no answer from the hub", true);
	if ((error as Error)?.name === "AbortError") return error as Error;
	const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
	return new HubUnreachableError(cause?.code ?? cause?.message ?? (error as Error)?.message ?? String(error));
}
