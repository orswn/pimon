import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

/**
 * An A2A server with the Hermes 0.23.1 quirks that the hub gateway must handle:
 * a 0.3 card without cache headers, a new task for every message, SSE frames in a JSON-RPC envelope,
 * `: keepalive` and `: done` comments, the `[INPUT_REQUIRED]` marker, a turn cap per context,
 * a failed task when the stream client goes away, and an in-memory task store.
 */

export const FAKE_HERMES_TOKEN = "fake-hermes-hub-token";

const STATE = {
	submitted: "TASK_STATE_SUBMITTED",
	working: "TASK_STATE_WORKING",
	inputRequired: "TASK_STATE_INPUT_REQUIRED",
	completed: "TASK_STATE_COMPLETED",
	failed: "TASK_STATE_FAILED",
	canceled: "TASK_STATE_CANCELED",
	rejected: "TASK_STATE_REJECTED",
} as const;
const TERMINAL = new Set<string>([STATE.completed, STATE.failed, STATE.canceled, STATE.rejected]);
const INPUT_REQUIRED_MARKER = "[INPUT_REQUIRED]";

export interface FakeTask {
	id: string;
	contextId: string;
	peer: string;
	text: string;
	state: string;
	reply: string;
	seq: number;
	finish?: (state: string, reply: string) => void;
}

export interface FakeRequest {
	method: string;
	params: Record<string, unknown>;
	headers: IncomingHttpHeaders;
	status: number;
	at: number;
}

/**
 * How the next SendStreamingMessage misbehaves. `no-task`: the socket closes before the headers.
 * `before-task`: the task exists, the socket closes before the first event. `after-task`: it closes after
 * the task and WORKING events. `silent`: the task exists, the stream stays open without events.
 */
export type DropMode = "no-task" | "before-task" | "after-task" | "silent";

/** `undefined` holds the task until `finish` is called. */
export type Responder = (text: string, task: FakeTask) => string | undefined;

export interface FakeHermesOptions {
	/** Token name to token. The name is the peer identity. */
	tokens?: Record<string, string>;
	/** Default: every token name. */
	trusted?: string[];
	maxTurns?: number;
	keepaliveMs?: number;
	skills?: { id: string; name: string; description: string; tags: string[] }[];
}

export class FakeHermes {
	url = "";
	readonly requests: FakeRequest[] = [];
	readonly tasks = new Map<string, FakeTask>();
	cardHits = 0;
	cardBroken = false;
	maxTurns: number;
	rateLimit: { limit: number; windowMs: number } | undefined;
	nextDrop: DropMode | undefined;
	/** The next SendStreamingMessage answers HTTP 200 with this JSON-RPC error, like Hermes for a bad A2A-Version. */
	nextError: { code: number; message: string } | undefined;
	/** The task survives a client disconnect and still takes its reply. */
	keepOnDisconnect = false;
	respond: Responder = (text) => `answer: ${text.split("\n").at(-1) ?? ""}`;
	readonly #tokens: Record<string, string>;
	readonly #trusted: Set<string>;
	readonly #keepaliveMs: number;
	readonly #skills: FakeHermesOptions["skills"];
	readonly #turns = new Map<string, number>();
	readonly #hits = new Map<string, number[]>();
	readonly #streams = new Set<Socket>();
	readonly #server = createServer((req, res) => {
		this.#handle(req, res).catch((error: unknown) => {
			if (!res.headersSent) res.writeHead(500).end(String(error));
		});
	});
	#seq = 0;

	constructor(options: FakeHermesOptions = {}) {
		this.#tokens = options.tokens ?? { "pimon-hub": FAKE_HERMES_TOKEN };
		this.#trusted = new Set(options.trusted ?? Object.keys(this.#tokens));
		this.maxTurns = options.maxTurns ?? 20;
		this.#keepaliveMs = options.keepaliveMs ?? 50;
		this.#skills = options.skills;
	}

	async start(): Promise<this> {
		await new Promise<void>((done) => this.#server.listen(0, "127.0.0.1", done));
		this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/`;
		return this;
	}

	async close(): Promise<void> {
		for (const socket of this.#streams) socket.destroy();
		this.#server.closeAllConnections();
		await new Promise<void>((done) => this.#server.close(() => done()));
	}

	/** A Hermes restart: the in-memory store and turn counters are gone, open streams break. */
	restart(): void {
		this.tasks.clear();
		this.#turns.clear();
		for (const socket of this.#streams) socket.destroy();
		this.#streams.clear();
	}

	finish(taskId: string, reply: string): void {
		const task = this.tasks.get(taskId);
		if (!task?.finish) throw new Error(`task ${taskId} is not waiting`);
		task.finish(STATE.completed, reply);
	}

	calls(method: string): FakeRequest[] {
		return this.requests.filter((request) => request.method === method);
	}

	sends(): FakeRequest[] {
		return this.calls("SendStreamingMessage").filter((request) => request.status === 200);
	}

	async waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const value = probe();
			if (value !== undefined && value !== false) return value;
			if (Date.now() > deadline) throw new Error(`fake hermes: condition not met; requests ${this.#summary()}`);
			await new Promise((done) => setTimeout(done, 10));
		}
	}

	#summary(): string {
		return JSON.stringify(this.requests.map((request) => [request.method, request.status]));
	}

	// ---------- HTTP ----------

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const path = new URL(req.url ?? "/", "http://fake.invalid").pathname;
		if (req.method === "GET" && (path === "/.well-known/agent-card.json" || path === "/.well-known/agent.json")) {
			this.cardHits += 1;
			if (this.cardBroken) {
				res.writeHead(503).end();
				return;
			}
			this.#json(res, 200, this.#card());
			return;
		}
		if (req.method !== "POST") {
			this.#json(res, 404, { error: "not found" });
			return;
		}
		let raw = "";
		for await (const chunk of req as AsyncIterable<Buffer>) raw += chunk.toString();
		const body = JSON.parse(raw || "{}") as { id?: unknown; method?: string; params?: Record<string, unknown> };
		const id = body.id ?? null;
		const method = body.method ?? "";
		const params = body.params ?? {};
		const record = (status: number) =>
			this.requests.push({ method, params, headers: req.headers, status, at: Date.now() });
		const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
		const peer = Object.entries(this.#tokens).find(([, token]) => token === match?.[1])?.[0];
		if (!peer) {
			record(401);
			this.#json(res, 401, rpcError(null, -32050, "unauthorized"));
			return;
		}
		const version = String(req.headers["a2a-version"] ?? "").trim();
		if (version && version !== "1.0" && version !== "1.0.0") {
			record(200);
			this.#json(res, 200, rpcError(id, -32602, `unsupported A2A-Version: ${version}`));
			return;
		}
		if (!this.#allow(peer)) {
			record(429);
			this.#json(res, 429, rpcError(id, -32051, "rate limit exceeded"));
			return;
		}
		if (!this.#trusted.has(peer)) {
			record(403);
			this.#json(res, 403, rpcError(id, -32052, `peer '${peer}' not trusted`));
			return;
		}
		record(200);
		if (method === "SendStreamingMessage" && this.nextError) {
			const { code, message } = this.nextError;
			this.nextError = undefined;
			this.#json(res, 200, rpcError(id, code, message));
			return;
		}
		switch (method) {
			case "SendStreamingMessage":
				this.#stream(req, res, id, params, peer);
				return;
			case "GetTask": {
				const task = this.tasks.get(taskIdParam(params));
				this.#json(res, 200, task ? rpcResult(id, toTask(task)) : rpcError(id, -32001, "task not found"));
				return;
			}
			case "ListTasks": {
				const contextId = typeof params["contextId"] === "string" ? params["contextId"] : "";
				const tasks = [...this.tasks.values()]
					.filter((task) => !contextId || task.contextId === contextId)
					.sort((a, b) => b.seq - a.seq)
					.map(toTask);
				this.#json(res, 200, rpcResult(id, { tasks, nextPageToken: "", pageSize: 50, totalSize: tasks.length }));
				return;
			}
			case "CancelTask": {
				const task = this.tasks.get(taskIdParam(params));
				if (!task) {
					this.#json(res, 200, rpcError(id, -32001, "task not found"));
					return;
				}
				if (TERMINAL.has(task.state)) {
					this.#json(res, 200, rpcError(id, -32002, `task ${task.id} already ${task.state}`));
					return;
				}
				this.#complete(task, STATE.canceled, "");
				this.#json(res, 200, rpcResult(id, toTask(task)));
				return;
			}
			case "SubscribeToTask":
				this.#subscribe(res, id, params);
				return;
			default:
				this.#json(res, 200, rpcError(id, -32601, `method not found: ${method}`));
		}
	}

	#card(): Record<string, unknown> {
		return {
			name: "hermes",
			description: "Fake Hermes Agent",
			url: this.url,
			version: "1.0.0",
			supportedInterfaces: [{ url: this.url, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
			capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: false },
			defaultInputModes: ["text/plain"],
			defaultOutputModes: ["text/plain"],
			skills: this.#skills ?? [
				{ id: "toolset.web", name: "web", description: "Hermes 'web' capabilities", tags: ["web", "web_search"] },
			],
			securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
			security: [{ bearer: [] }],
		};
	}

	#allow(peer: string): boolean {
		if (!this.rateLimit) return true;
		const now = Date.now();
		const hits = (this.#hits.get(peer) ?? []).filter((at) => now - at < (this.rateLimit?.windowMs ?? 0));
		if (hits.length >= this.rateLimit.limit) {
			this.#hits.set(peer, hits);
			return false;
		}
		hits.push(now);
		this.#hits.set(peer, hits);
		return true;
	}

	#json(res: ServerResponse, status: number, body: unknown): void {
		const text = JSON.stringify(body);
		res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
		res.end(text);
	}

	#newTask(contextId: string, peer: string, text: string): FakeTask {
		const task: FakeTask = {
			id: `task-${randomBytes(8).toString("hex")}`,
			contextId,
			peer,
			text,
			state: STATE.submitted,
			reply: "",
			seq: ++this.#seq,
		};
		this.tasks.set(task.id, task);
		return task;
	}

	#complete(task: FakeTask, state: string, reply: string): void {
		if (TERMINAL.has(task.state)) return;
		const finish = task.finish;
		task.finish = undefined;
		task.state = state;
		task.reply = reply;
		finish?.(state, reply);
	}

	#stream(req: IncomingMessage, res: ServerResponse, id: unknown, params: Record<string, unknown>, peer: string): void {
		const message = (params["message"] ?? {}) as { contextId?: string; parts?: { text?: string }[] };
		const contextId = message.contextId || `ctx-${randomBytes(8).toString("hex")}`;
		const text = (message.parts ?? []).map((part) => part.text ?? "").join("\n");
		const drop = this.nextDrop;
		this.nextDrop = undefined;
		if (drop === "no-task") {
			req.socket.destroy();
			return;
		}
		const turn = (this.#turns.get(contextId) ?? 0) + 1;
		this.#turns.set(contextId, turn);
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
		res.flushHeaders();
		const socket = res.socket;
		if (socket) this.#streams.add(socket);
		const write = (frame: string) => {
			if (!res.writableEnded && !res.destroyed) res.write(frame);
		};
		const event = (payload: unknown) => write(`data: ${JSON.stringify(rpcResult(id, payload))}\n\n`);
		const end = () => {
			write(": done\n\n");
			res.end();
			if (socket) this.#streams.delete(socket);
		};
		const task = this.#newTask(contextId, peer, text);
		if (turn > this.maxTurns) {
			const reason = `Anti-loop protection: context ${contextId} exceeded ${this.maxTurns} turns. Start a new context or increase A2A_MAX_PINGPONG_TURNS.`;
			this.#complete(task, STATE.rejected, reason);
			event(statusUpdate(task, STATE.rejected, reason));
			end();
			return;
		}
		task.state = STATE.working;
		const disconnect = () => {
			clearInterval(keepalive);
			if (this.tasks.get(task.id) === task && !this.keepOnDisconnect) {
				this.#complete(task, STATE.failed, "[client disconnected]");
			}
		};
		const keepalive = setInterval(() => write(": keepalive\n\n"), this.#keepaliveMs);
		res.on("close", () => {
			if (!res.writableFinished) disconnect();
			else clearInterval(keepalive);
		});
		task.finish = (state, reply) => {
			clearInterval(keepalive);
			if (res.destroyed || res.writableEnded) return;
			const completed = reply !== "" && state === STATE.completed;
			if (completed) event(artifactUpdate(task, reply));
			event(statusUpdate(task, state, completed ? "" : reply));
			end();
		};
		if (drop === "before-task" || drop === "silent") {
			if (drop === "before-task") res.destroy();
			this.#reply(task, text);
			return;
		}
		event({ task: { id: task.id, contextId, status: { state: STATE.submitted, timestamp: now() } } });
		event(statusUpdate(task, STATE.working, ""));
		if (drop === "after-task") res.destroy();
		this.#reply(task, text);
	}

	#reply(task: FakeTask, text: string): void {
		const reply = this.respond(text, task);
		if (reply === undefined) return;
		setImmediate(() => {
			if (this.tasks.get(task.id) !== task || TERMINAL.has(task.state)) return;
			const stripped = reply.trimStart();
			if (stripped.toUpperCase().startsWith(INPUT_REQUIRED_MARKER)) {
				this.#complete(task, STATE.inputRequired, stripped.slice(INPUT_REQUIRED_MARKER.length).trim());
			} else {
				this.#complete(task, STATE.completed, reply);
			}
		});
	}

	#subscribe(res: ServerResponse, id: unknown, params: Record<string, unknown>): void {
		const task = this.tasks.get(taskIdParam(params));
		if (!task) {
			this.#json(res, 200, rpcError(id, -32001, "task not found"));
			return;
		}
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
		const emit = (state: string, reply: string) => {
			const completed = reply !== "" && state === STATE.completed;
			if (completed) res.write(`data: ${JSON.stringify(rpcResult(id, artifactUpdate(task, reply)))}\n\n`);
			res.write(`data: ${JSON.stringify(rpcResult(id, statusUpdate(task, state, completed ? "" : reply)))}\n\n`);
			res.end(": done\n\n");
		};
		if (TERMINAL.has(task.state) || task.state === STATE.inputRequired) {
			emit(task.state, task.reply);
			return;
		}
		const previous = task.finish;
		task.finish = (state, reply) => {
			previous?.(state, reply);
			emit(state, reply);
		};
	}
}

function taskIdParam(params: Record<string, unknown>): string {
	const id = params["id"] ?? params["taskId"];
	return typeof id === "string" ? id : "";
}

function now(): string {
	return new Date().toISOString();
}

function rpcResult(id: unknown, result: unknown) {
	return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function textMessage(text: string, contextId: string) {
	return { role: "ROLE_AGENT", parts: [{ text, mediaType: "text/plain" }], messageId: randomUUID(), contextId };
}

function statusUpdate(task: FakeTask, state: string, text: string) {
	const status: Record<string, unknown> = { state, timestamp: now() };
	if (text) status["message"] = textMessage(text, task.contextId);
	return { statusUpdate: { taskId: task.id, contextId: task.contextId, status } };
}

function artifactUpdate(task: FakeTask, text: string) {
	const artifact = { artifactId: randomUUID().replace(/-/g, ""), parts: [{ text, mediaType: "text/plain" }] };
	return { artifactUpdate: { taskId: task.id, contextId: task.contextId, artifact } };
}

/** Hermes `TaskStore.to_task`: a message for any reply, and an artifact for a completed one. */
function toTask(task: FakeTask): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: task.id,
		contextId: task.contextId,
		status: { state: task.state, timestamp: now() },
	};
	if (task.reply) {
		(out["status"] as Record<string, unknown>)["message"] = textMessage(task.reply, task.contextId);
		if (task.state === STATE.completed) {
			out["artifacts"] = [{ artifactId: randomUUID().replace(/-/g, ""), parts: [{ text: task.reply }] }];
		}
	}
	return out;
}
