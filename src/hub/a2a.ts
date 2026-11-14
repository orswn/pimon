import { createHash } from "node:crypto";
import {
	AgentCard,
	type CancelTaskRequest,
	type DeleteTaskPushNotificationConfigRequest,
	type GetExtendedAgentCardRequest,
	type GetTaskPushNotificationConfigRequest,
	type GetTaskRequest,
	type ListTaskPushNotificationConfigsRequest,
	type ListTaskPushNotificationConfigsResponse,
	type ListTasksRequest,
	type ListTasksResponse,
	Message,
	type SendMessageRequest,
	StreamResponse,
	Task,
	TaskPushNotificationConfig,
	TaskState,
	taskStateToJSON,
} from "@a2a-js/sdk";
import {
	A2AError,
	RequestMalformedError,
	TaskNotCancelableError,
	TaskNotFoundError,
	UnsupportedOperationError,
} from "@a2a-js/sdk/errors";
import type { A2ARequestHandler, ServerCallContext } from "@a2a-js/sdk/server";
import {
	type AgentRow,
	applyHistoryLength,
	type Caller,
	type Engine,
	HubError,
	INTERRUPTED_STATES,
	isTerminal,
	type SendResult,
	type TaskEvent,
	type WireMessage,
	type WireState,
	type WireStreamResponse,
	type WireTask,
} from "./engine.ts";
import { BUS_EXTENSION_URI, type DeliveryState } from "./protocol.ts";
import type { BuiltinAgent } from "./test-agents.ts";

export const BLOCKING_HOLD_MS = 60 * 60 * 1000;
/** Open blocking requests and streams per principal. */
export const HOLD_LIMIT = 64;
export const DELIVERY_WAIT_MS = 2000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export interface CardInput {
	agent: AgentRow;
	baseUrl: string;
	version: string;
	builtin?: BuiltinAgent | undefined;
}

/** The card in A2A 1.0 JSON form. Static content only: no cwd, labels, or status. */
export function buildCard({ agent, baseUrl, version, builtin }: CardInput): Record<string, unknown> {
	const description = builtin?.description ?? `pi session on ${agent.host ?? "unknown host"}`;
	const card: Record<string, unknown> = {
		name: agent.name,
		description,
		supportedInterfaces: [{ url: `${baseUrl}/a2a/${agent.id}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
		version,
		capabilities: {
			streaming: true,
			pushNotifications: true,
			extendedAgentCard: false,
			extensions: [{ uri: BUS_EXTENSION_URI, required: false }],
		},
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain"],
		skills: builtin
			? [{ id: builtin.id, name: builtin.name, description, tags: ["test"] }]
			: [{ id: "pi-session", name: "pi session", description, tags: ["coding"] }],
	};
	if (!builtin) {
		card["securitySchemes"] = { bearer: { httpAuthSecurityScheme: { scheme: "bearer" } } };
		card["securityRequirements"] = [{ schemes: { bearer: { list: [] } } }];
	}
	return card;
}

export function cardEtag(json: string): string {
	return `"${createHash("sha256").update(json).digest("hex").slice(0, 32)}"`;
}

export function toA2AError(error: unknown): unknown {
	if (!(error instanceof HubError)) return error;
	switch (error.reason) {
		case "task-not-found":
			return new TaskNotFoundError(error.message);
		case "task-terminal":
			return new UnsupportedOperationError(error.message);
		case "not-cancelable":
			return new TaskNotCancelableError(error.message);
		case "invalid":
			return new RequestMalformedError(error.message);
		default:
			return new A2AError(error.message);
	}
}

function guard<T>(fn: () => T): T {
	try {
		return fn();
	} catch (error) {
		throw toA2AError(error);
	}
}

function requireId(id: string | undefined, field = "id"): string {
	if (!id || id.trim() === "") throw new RequestMalformedError(`${field} is required`);
	return id;
}

/** A blocking request and a stream both end at a terminal or interrupted state. */
function endsWait(state: WireState): boolean {
	return isTerminal(state) || INTERRUPTED_STATES.has(state);
}

function checkHistoryLength(value: number | undefined): void {
	if (value !== undefined && value < 0) throw new RequestMalformedError("historyLength must not be negative");
}

export class HoldLimiter {
	readonly #limit: number;
	readonly #open = new Map<string, number>();

	constructor(limit = HOLD_LIMIT) {
		this.#limit = limit;
	}

	count(principal: string): number {
		return this.#open.get(principal) ?? 0;
	}

	/** Throws above the limit. The returned function frees the hold once. */
	acquire(principal: string): () => void {
		const open = this.count(principal);
		if (open >= this.#limit) {
			throw new A2AError(`too many open streams and blocking requests for ${principal}: the limit is ${this.#limit}`);
		}
		this.#open.set(principal, open + 1);
		let freed = false;
		return () => {
			if (freed) return;
			freed = true;
			const left = this.count(principal) - 1;
			if (left > 0) this.#open.set(principal, left);
			else this.#open.delete(principal);
		};
	}
}

class EventQueue {
	readonly #items: TaskEvent[] = [];
	#wake: (() => void) | undefined;
	#closed = false;
	readonly #off: () => void;
	readonly #signal: AbortSignal | undefined;
	readonly #onAbort = () => this.close();

	constructor(engine: Engine, taskId: string, signal: AbortSignal | undefined) {
		this.#off = engine.onTask(taskId, (event) => {
			this.#items.push(event);
			this.#wake?.();
		});
		this.#signal = signal;
		if (signal?.aborted) this.close();
		else signal?.addEventListener("abort", this.#onAbort, { once: true });
	}

	async next(): Promise<TaskEvent | undefined> {
		while (this.#items.length === 0 && !this.#closed) {
			await new Promise<void>((resolve) => {
				this.#wake = resolve;
			});
			this.#wake = undefined;
		}
		return this.#items.shift();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#off();
		this.#signal?.removeEventListener("abort", this.#onAbort);
		this.#wake?.();
	}
}

export interface HandlerInput {
	engine: Engine;
	agent: AgentRow;
	caller: Caller;
	card: Record<string, unknown>;
	builtin?: BuiltinAgent | undefined;
	/** Aborts when the client connection closes. */
	signal?: AbortSignal;
	holds?: HoldLimiter;
	log?: (line: string) => void;
}

export class HubRequestHandler implements A2ARequestHandler {
	readonly #engine: Engine;
	readonly #agent: AgentRow;
	readonly #caller: Caller;
	readonly #card: Record<string, unknown>;
	readonly #builtin: BuiltinAgent | undefined;
	readonly #signal: AbortSignal | undefined;
	readonly #holds: HoldLimiter;
	readonly #log: (line: string) => void;

	constructor(input: HandlerInput) {
		this.#engine = input.engine;
		this.#agent = input.agent;
		this.#caller = input.caller;
		this.#card = input.card;
		this.#builtin = input.builtin;
		this.#signal = input.signal;
		this.#holds = input.holds ?? new HoldLimiter();
		this.#log = input.log ?? (() => {});
	}

	/** An error that is not an A2A or hub error may hold internal text: log it, send a generic one. */
	#publicError(error: unknown): unknown {
		if (error instanceof A2AError) return error;
		if (error instanceof HubError) return toA2AError(error);
		this.#log(`a2a request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		return new A2AError("internal error");
	}

	async #guarded<T>(fn: () => Promise<T>): Promise<T> {
		try {
			return await fn();
		} catch (error) {
			throw this.#publicError(error);
		}
	}

	async *#guardedStream(stream: AsyncGenerator<StreamResponse>): AsyncGenerator<StreamResponse> {
		try {
			yield* stream;
		} catch (error) {
			throw this.#publicError(error);
		}
	}

	#hold(): () => void {
		return this.#holds.acquire(this.#caller.principal.name);
	}

	async getAgentCard(): Promise<AgentCard> {
		return this.#guarded(async () => AgentCard.fromJSON(this.#card));
	}

	async getAuthenticatedExtendedAgentCard(_params: GetExtendedAgentCardRequest): Promise<AgentCard> {
		throw new UnsupportedOperationError("Agent does not support an extended agent card.");
	}

	#activate(context: ServerCallContext): void {
		if (context.requestedExtensions?.includes(BUS_EXTENSION_URI)) context.addActivatedExtension(BUS_EXTENSION_URI);
	}

	#send(params: SendMessageRequest): { result: SendResult } | { direct: WireMessage } {
		const incoming = params.message;
		if (!incoming?.messageId) throw new RequestMalformedError("message.messageId is required.");
		const wire = Message.toJSON(incoming) as WireMessage;
		if (this.#builtin?.reply && !wire.taskId) {
			const direct = this.#builtin.reply(wire, wire.contextId || this.#engine.newId());
			if (direct) return { direct };
		}
		const push = params.configuration?.taskPushNotificationConfig;
		const input: Parameters<Engine["send"]>[0] = { agentId: this.#agent.id, caller: this.#caller, message: wire };
		if (push) {
			const json = TaskPushNotificationConfig.toJSON(push) as {
				id?: string;
				url: string;
				token?: string;
				authentication?: { scheme: string; credentials?: string };
			};
			input.pushConfig = { url: json.url };
			if (json.id) input.pushConfig.id = json.id;
			if (json.token) input.pushConfig.token = json.token;
			if (json.authentication) input.pushConfig.authentication = json.authentication;
		}
		return { result: guard(() => this.#engine.send(input)) };
	}

	#startBuiltin(result: SendResult, message: WireMessage): void {
		if (this.#builtin && result.task) this.#builtin.start(this.#engine, result.task.id, message);
	}

	async #delivery(result: SendResult, requested: boolean): Promise<DeliveryState | undefined> {
		if (!requested) return undefined;
		if (this.#agent.kind !== "pi") return "delivered";
		const agent = this.#engine.agent(this.#agent.id);
		if (!agent || agent.online !== 1 || result.eventSeq === undefined) return "queued";
		const acked = await this.#engine.waitForAck(agent.id, result.eventSeq, DELIVERY_WAIT_MS, this.#signal);
		return acked ? "delivered" : "unconfirmed";
	}

	#readTask(id: string, historyLength: number | undefined): WireTask {
		return guard(() => this.#engine.getTask(this.#agent.id, this.#caller, id, historyLength));
	}

	async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
		return this.#guarded(async () => {
			this.#activate(context);
			const historyLength = params.configuration?.historyLength;
			checkHistoryLength(historyLength);
			const blocking = params.configuration?.returnImmediately !== true;
			const release = blocking ? this.#hold() : () => {};
			try {
				const sent = this.#send(params);
				if ("direct" in sent) return Message.fromJSON(sent.direct);
				const { result } = sent;
				const message = Message.toJSON(params.message as Message) as WireMessage;
				const requestMeta = params.metadata?.[BUS_EXTENSION_URI] as { deliveryWait?: unknown } | undefined;
				const deliveryWait = result.meta.deliveryWait === true || requestMeta?.deliveryWait === true;
				const deliveryPromise = this.#delivery(result, deliveryWait);
				const taskId = result.task?.id;
				const waitPromise =
					taskId && blocking
						? this.#engine.waitForTask(taskId, endsWait, BLOCKING_HOLD_MS, this.#signal)
						: Promise.resolve();
				this.#startBuiltin(result, message);
				const [delivery] = await Promise.all([deliveryPromise, waitPromise]);
				const stamp = delivery ? { [BUS_EXTENSION_URI]: { delivery } } : undefined;
				if (!taskId) {
					const reply = result.message as WireMessage;
					return Message.fromJSON(stamp ? { ...reply, metadata: { ...reply.metadata, ...stamp } } : reply);
				}
				const task = this.#readTask(taskId, historyLength);
				return Task.fromJSON(stamp ? { ...task, metadata: { ...task.metadata, ...stamp } } : task);
			} finally {
				release();
			}
		});
	}

	sendMessageStream(params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
		return this.#guardedStream(this.#sendStream(params, context));
	}

	async *#sendStream(params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
		this.#activate(context);
		checkHistoryLength(params.configuration?.historyLength);
		const release = this.#hold();
		try {
			const sent = this.#send(params);
			if ("direct" in sent) {
				yield StreamResponse.fromJSON({ message: sent.direct });
				return;
			}
			const { result } = sent;
			if (!result.task) {
				yield StreamResponse.fromJSON({ message: result.message });
				return;
			}
			const queue = new EventQueue(this.#engine, result.task.id, this.#signal);
			try {
				this.#startBuiltin(result, Message.toJSON(params.message as Message) as WireMessage);
				yield StreamResponse.fromJSON({ task: applyHistoryLength(result.task, params.configuration?.historyLength) });
				if (endsWait(result.task.status.state)) return;
				yield* this.#drain(queue);
			} finally {
				queue.close();
			}
		} finally {
			release();
		}
	}

	async *#drain(queue: EventQueue): AsyncGenerator<StreamResponse> {
		for (;;) {
			const event = await queue.next();
			if (!event) return;
			yield StreamResponse.fromJSON(event.response satisfies WireStreamResponse);
			if ("statusUpdate" in event.response && endsWait(event.state)) return;
		}
	}

	async getTask(params: GetTaskRequest): Promise<Task> {
		return this.#guarded(async () => {
			checkHistoryLength(params.historyLength);
			return Task.fromJSON(this.#readTask(requireId(params.id), params.historyLength));
		});
	}

	async listTasks(params: ListTasksRequest): Promise<ListTasksResponse> {
		return this.#guarded(async () => this.#listTasks(params));
	}

	#listTasks(params: ListTasksRequest): ListTasksResponse {
		checkHistoryLength(params.historyLength);
		const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
		if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
			throw new RequestMalformedError(`pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
		}
		const status = params.status;
		if (status !== undefined && (status === TaskState.UNRECOGNIZED || TaskState[status] === undefined)) {
			throw new RequestMalformedError(`Invalid status filter: ${String(status)}`);
		}
		if (params.statusTimestampAfter && Number.isNaN(Date.parse(params.statusTimestampAfter))) {
			throw new RequestMalformedError("statusTimestampAfter must be a valid ISO 8601 timestamp");
		}
		const input: Parameters<Engine["listTasks"]>[2] = {
			pageSize,
			includeArtifacts: params.includeArtifacts === true,
		};
		if (params.contextId) input.contextId = params.contextId;
		if (status !== undefined && status !== TaskState.TASK_STATE_UNSPECIFIED) {
			input.state = taskStateToJSON(status) as WireState;
		}
		if (params.statusTimestampAfter) input.statusTimestampAfter = params.statusTimestampAfter;
		if (params.pageToken) input.pageToken = params.pageToken;
		if (params.historyLength !== undefined) input.historyLength = params.historyLength;
		const result = guard(() => this.#engine.listTasks(this.#agent.id, this.#caller, input));
		return { ...result, tasks: result.tasks.map((task) => Task.fromJSON(task)) };
	}

	async cancelTask(params: CancelTaskRequest): Promise<Task> {
		return this.#guarded(async () => {
			const id = requireId(params.id);
			return Task.fromJSON(guard(() => this.#engine.cancel(this.#agent.id, this.#caller, id)));
		});
	}

	async createTaskPushNotificationConfig(params: TaskPushNotificationConfig): Promise<TaskPushNotificationConfig> {
		return this.#guarded(async () => this.#createPushConfig(params));
	}

	#createPushConfig(params: TaskPushNotificationConfig): TaskPushNotificationConfig {
		const json = TaskPushNotificationConfig.toJSON(params) as {
			id?: string;
			taskId?: string;
			url?: string;
			token?: string;
			authentication?: { scheme: string; credentials?: string };
		};
		const taskId = requireId(json.taskId, "taskId");
		if (!json.url) throw new RequestMalformedError("url is required");
		const config: Parameters<Engine["createPushConfig"]>[2] = { taskId, url: json.url };
		if (json.id) config.id = json.id;
		if (json.token) config.token = json.token;
		if (json.authentication) config.authentication = json.authentication;
		const saved = guard(() => this.#engine.createPushConfig(this.#agent.id, this.#caller, config));
		return TaskPushNotificationConfig.fromJSON(saved);
	}

	async getTaskPushNotificationConfig(
		params: GetTaskPushNotificationConfigRequest,
	): Promise<TaskPushNotificationConfig> {
		return this.#guarded(async () => {
			const taskId = requireId(params.taskId, "taskId");
			const config = guard(() => this.#engine.getPushConfig(this.#agent.id, this.#caller, taskId, params.id));
			return TaskPushNotificationConfig.fromJSON(config);
		});
	}

	async listTaskPushNotificationConfigs(
		params: ListTaskPushNotificationConfigsRequest,
	): Promise<ListTaskPushNotificationConfigsResponse> {
		return this.#guarded(async () => {
			const taskId = requireId(params.taskId, "taskId");
			const configs = guard(() => this.#engine.listPushConfigs(this.#agent.id, this.#caller, taskId));
			return { configs: configs.map((config) => TaskPushNotificationConfig.fromJSON(config)), nextPageToken: "" };
		});
	}

	async deleteTaskPushNotificationConfig(params: DeleteTaskPushNotificationConfigRequest): Promise<void> {
		return this.#guarded(async () => {
			const taskId = requireId(params.taskId, "taskId");
			guard(() => this.#engine.deletePushConfig(this.#agent.id, this.#caller, taskId, params.id));
		});
	}

	resubscribe(params: { id: string }): AsyncGenerator<StreamResponse> {
		return this.#guardedStream(this.#resubscribe(params));
	}

	async *#resubscribe(params: { id: string }): AsyncGenerator<StreamResponse> {
		const id = requireId(params.id);
		const release = this.#hold();
		const queue = new EventQueue(this.#engine, id, this.#signal);
		try {
			const task = this.#readTask(id, undefined);
			if (isTerminal(task.status.state)) {
				throw new UnsupportedOperationError(`Task ${id} is in a terminal state and cannot be subscribed to.`);
			}
			yield StreamResponse.fromJSON({ task });
			yield* this.#drain(queue);
		} finally {
			queue.close();
			release();
		}
	}
}
