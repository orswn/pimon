import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { AgentCard, Extensions, formatSSEErrorEvent, formatSSEEvent, SSE_HEADERS } from "@a2a-js/sdk";
import { ContentTypeNotSupportedError } from "@a2a-js/sdk/errors";
import { defaultServerCallContextBuilder, JsonRpcTransportHandler, validateVersion } from "@a2a-js/sdk/server";
import { buildCard, cardEtag, HoldLimiter, HubRequestHandler, toA2AError } from "./a2a.ts";
import { ANONYMOUS, authenticate, loadTokens, parseTokens, type Principal, TokenTable } from "./auth.ts";
import { type HubConfig, parseListen } from "./config.ts";
import { openDb } from "./db.ts";
import { type AgentRow, type Caller, Engine, HubError } from "./engine.ts";
import { LinkHub } from "./link.ts";
import { AGENT_HEADER } from "./protocol.ts";
import { PushSender, type PushOptions } from "./push.ts";
import { PushGuard, TEST_AGENT_ALLOW } from "./push-guard.ts";
import { type BuiltinAgent, installBuiltins } from "./test-agents.ts";

export const BODY_LIMIT = 1024 * 1024;
const SWEEP_MS = 24 * 60 * 60 * 1000;
const CARD_MAX_AGE_S = 60;
const AMBIGUOUS_ALIAS = -32602;
const JSON_TYPES = new Set(["application/json", "application/a2a+json"]);

export const HUB_VERSION: string = (() => {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
			version?: string;
		};
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

export type TokenSpec = Record<string, { kind: "host" | "peer"; sha256: string }>;

export interface StartHubOptions {
	/** `host:port`. Default `127.0.0.1:0`: a free port on loopback. */
	listen?: string;
	/** A data directory, or `:memory:`. */
	dataDir: string;
	tokensFile?: string;
	tokens?: TokenSpec | TokenTable;
	testAgents?: boolean;
	publicUrl?: string;
	presenceGraceMs?: number;
	heartbeatMs?: number;
	/** Private host names, addresses, and CIDRs that push webhooks may reach. Test agents add loopback. */
	pushAllow?: string[];
	push?: PushOptions;
	log?: (line: string) => void;
}

export interface RunningHub {
	url: string;
	port: number;
	hub: Hub;
	/** Reads `tokensFile` again. Keeps the old tokens when the file is bad. */
	reloadTokens(): void;
	close(): Promise<void>;
}

/** Opens the database, starts the server, and resolves once it listens. It installs no signal handler. */
export async function startHub(options: StartHubOptions): Promise<RunningHub> {
	const { host, port } = parseListen(options.listen ?? "127.0.0.1:0");
	const readTokens = (): TokenTable => {
		if (options.tokens instanceof TokenTable) return options.tokens;
		if (options.tokens) return parseTokens(JSON.stringify(options.tokens));
		return loadTokens(options.tokensFile);
	};
	const db = openDb(options.dataDir);
	const hubOptions: HubOptions = {
		config: {
			host,
			port,
			testAgents: options.testAgents === true,
			publicUrl: options.publicUrl,
			presenceGraceMs: options.presenceGraceMs ?? 20_000,
			heartbeatMs: options.heartbeatMs ?? 15_000,
			pushAllow: [...new Set([...(options.pushAllow ?? []), ...(options.testAgents ? TEST_AGENT_ALLOW : [])])],
		},
		db,
		tokens: readTokens(),
	};
	if (options.push) hubOptions.push = options.push;
	if (options.log) hubOptions.log = options.log;
	const hub = new Hub(hubOptions);
	let bound: number;
	try {
		bound = await hub.listen();
	} catch (error) {
		await hub.close().catch(() => {});
		db.close();
		throw error;
	}
	const urlHost = host.includes(":") ? `[${host}]` : host === "0.0.0.0" ? "127.0.0.1" : host;
	let closed = false;
	return {
		url: `http://${urlHost}:${bound}`,
		port: bound,
		hub,
		reloadTokens: () => hub.setTokens(readTokens()),
		close: async () => {
			if (closed) return;
			closed = true;
			await hub.close();
			db.close();
		},
	};
}

export interface HubOptions {
	config: Pick<
		HubConfig,
		"host" | "port" | "testAgents" | "publicUrl" | "presenceGraceMs" | "heartbeatMs" | "pushAllow"
	>;
	db: DatabaseSync;
	tokens: TokenTable;
	push?: PushOptions;
	log?: (line: string) => void;
}

class HttpError extends Error {
	readonly status: number;
	readonly details: Record<string, unknown> | undefined;

	constructor(status: number, message: string, details?: Record<string, unknown>) {
		super(message);
		this.status = status;
		this.details = details;
	}
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(text),
		...headers,
	});
	res.end(text);
}

function sendError(res: ServerResponse, error: unknown, log: (line: string) => void): void {
	if (res.headersSent) {
		if (!res.writableEnded) res.end();
		return;
	}
	if (error instanceof HubError || error instanceof HttpError) {
		sendJson(res, error.status, { error: error.message, ...error.details });
		return;
	}
	log(`internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	sendJson(res, 500, { error: "internal error" });
}

async function readBody(req: IncomingMessage): Promise<string> {
	const declared = Number(req.headers["content-length"] ?? 0);
	if (declared > BODY_LIMIT) throw new HttpError(413, "body is larger than 1 MB");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as AsyncIterable<Buffer>) {
		size += chunk.length;
		if (size > BODY_LIMIT) throw new HttpError(413, "body is larger than 1 MB");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	const text = await readBody(req);
	if (text.trim() === "") return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new HttpError(400, "body is not valid JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new HttpError(400, "body must be a JSON object");
	return value as Record<string, unknown>;
}

function header(req: IncomingMessage, name: string): string | undefined {
	const value = req.headers[name.toLowerCase()];
	return Array.isArray(value) ? value[0] : value;
}

/** A value that is not a non-negative integer is ignored: the stream then replays every unacked event. */
export function lastEventId(req: IncomingMessage, url: URL): number | undefined {
	const header = req.headers["last-event-id"];
	const raw = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("lastEventId") ?? "";
	const value = raw.trim();
	return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined;
}

/** `1.0.3` counts as `1.0`: only Major.Minor selects the semantics. An absent version means 0.3. */
export function requestedVersion(req: IncomingMessage, url: URL): string {
	const raw = (header(req, "a2a-version") ?? url.searchParams.get("A2A-Version") ?? "").trim();
	if (raw === "") return "0.3";
	const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(raw);
	return match ? `${match[1]}.${match[2]}` : raw;
}

function rpcError(id: unknown, error: { code: number; message: string; data?: unknown }) {
	return { jsonrpc: "2.0", id: id ?? null, error };
}

export class Hub {
	readonly engine: Engine;
	readonly link: LinkHub;
	readonly push: PushSender;
	readonly server: Server;
	readonly #config: HubOptions["config"];
	readonly #builtins: Map<string, BuiltinAgent>;
	readonly #log: (line: string) => void;
	readonly #holds = new HoldLimiter();
	#tokens: TokenTable;
	#sweep: NodeJS.Timeout | undefined;

	constructor(options: HubOptions) {
		this.#config = options.config;
		this.#tokens = options.tokens;
		this.#log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
		const guard = options.push?.guard ?? new PushGuard(options.config.pushAllow);
		this.engine = new Engine(options.db, { pushGuard: guard, log: this.#log });
		this.#builtins = options.config.testAgents ? installBuiltins(this.engine) : new Map();
		this.link = new LinkHub(this.engine, {
			presenceGraceMs: options.config.presenceGraceMs,
			heartbeatMs: options.config.heartbeatMs,
		});
		this.push = new PushSender(this.engine, { log: this.#log, ...options.push, guard });
		this.server = createServer((req, res) => {
			this.#handle(req, res).catch((error: unknown) => sendError(res, error, this.#log));
		});
		this.server.keepAliveTimeout = 65_000;
	}

	setTokens(tokens: TokenTable): void {
		this.#tokens = tokens;
	}

	async listen(): Promise<number> {
		const online = this.engine
			.listAgents(false)
			.filter((agent) => agent.kind === "pi")
			.map((agent) => agent.id);
		this.link.start(online);
		this.push.start();
		this.engine.sweep();
		this.#sweep = setInterval(() => {
			try {
				this.engine.sweep();
			} catch (error) {
				this.#log(`sweep failed: ${String(error)}`);
			}
		}, SWEEP_MS);
		this.#sweep.unref();
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.#config.port, this.#config.host, () => {
				this.server.off("error", reject);
				resolve();
			});
		});
		return (this.server.address() as AddressInfo).port;
	}

	async close(): Promise<void> {
		if (this.#sweep) clearInterval(this.#sweep);
		this.push.stop();
		this.link.stop();
		const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
		this.server.closeAllConnections();
		await closed;
	}

	// ---------- routing ----------

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://hub.invalid");
		let path: string[];
		try {
			path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
		} catch {
			throw new HttpError(400, "malformed percent escape in path");
		}
		const method = req.method ?? "GET";
		const [root, ...rest] = path;

		if (root === "healthz" && rest.length === 0 && method === "GET") {
			sendJson(res, 200, { ok: true, version: HUB_VERSION, agents: this.engine.onlineCount() });
			return;
		}
		if (root === "a2a" && rest[0]) {
			const ref = rest[0];
			if (method === "GET" && rest.length === 3 && rest[1] === ".well-known") {
				if (rest[2] === "agent-card.json" || rest[2] === "agent.json") {
					this.#card(req, res, ref);
					return;
				}
			}
			if (method === "POST" && rest.length === 1) {
				await this.#jsonRpc(req, res, url, ref);
				return;
			}
			throw new HttpError(404, "not found");
		}
		if (root === "link") {
			await this.#linkRoute(req, res, url, method, rest);
			return;
		}
		if (root === "agents" && method === "GET" && rest.length <= 1) {
			this.#requireHost(req);
			if (rest[0]) {
				sendJson(res, 200, this.engine.agentInfo(this.engine.requireAgent(rest[0])));
				return;
			}
			sendJson(res, 200, { agents: this.engine.listAgents(url.searchParams.get("offline") === "1") });
			return;
		}
		throw new HttpError(404, "not found");
	}

	#principal(req: IncomingMessage, allowAnonymous = false): Principal {
		const result = authenticate(header(req, "authorization"), this.#tokens, allowAnonymous);
		if (!result.ok) throw new HttpError(401, "unauthorized");
		return result.principal;
	}

	#requireHost(req: IncomingMessage): Principal {
		const principal = this.#principal(req);
		if (principal.kind !== "host") throw new HttpError(403, "host principal required");
		return principal;
	}

	#baseUrl(req: IncomingMessage): string {
		if (this.#config.publicUrl) return this.#config.publicUrl;
		const proto = header(req, "x-forwarded-proto")?.split(",")[0]?.trim();
		const host = header(req, "x-forwarded-host")?.split(",")[0]?.trim();
		if (proto && host) return `${proto}://${host}`;
		return `http://${header(req, "host") ?? `${this.#config.host}:${this.#config.port}`}`;
	}

	#resolve(ref: string): AgentRow | { ambiguous: string[] } {
		const found = this.engine.resolveRef(ref);
		if (!found) throw new HttpError(404, `unknown agent ${ref}`);
		return "ambiguous" in found ? found : found.agent;
	}

	#cardFor(req: IncomingMessage, agent: AgentRow): Record<string, unknown> {
		return buildCard({
			agent,
			baseUrl: this.#baseUrl(req),
			version: HUB_VERSION,
			builtin: this.#builtins.get(agent.id),
		});
	}

	/** A built-in agent answers without a token in test mode. Its ids and names are public. */
	#isBuiltinRef(ref: string): boolean {
		if (this.#builtins.has(ref)) return true;
		return ref.startsWith("@") && [...this.#builtins.values()].some((agent) => agent.name === ref.slice(1));
	}

	#card(req: IncomingMessage, res: ServerResponse, ref: string): void {
		const agent = this.#resolve(ref);
		if ("ambiguous" in agent) throw new HttpError(409, `agent alias ${ref} is ambiguous`);
		const json = JSON.stringify(this.#cardFor(req, agent));
		const etag = cardEtag(json);
		const headers = { "Cache-Control": `max-age=${CARD_MAX_AGE_S}`, ETag: etag };
		const match = header(req, "if-none-match");
		if (match && match.split(",").some((tag) => tag.trim() === etag || tag.trim() === "*")) {
			res.writeHead(304, headers);
			res.end();
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json), ...headers });
		res.end(json);
	}

	// ---------- JSON-RPC ----------

	async #jsonRpc(req: IncomingMessage, res: ServerResponse, url: URL, ref: string): Promise<void> {
		// Authenticate first, so an anonymous caller cannot learn which agents exist.
		const principal = this.#principal(req, this.#isBuiltinRef(ref));
		const resolved = this.#resolve(ref);
		const builtin = "ambiguous" in resolved ? undefined : this.#builtins.get(resolved.id);
		if (principal === ANONYMOUS && !builtin) throw new HttpError(401, "unauthorized");
		const caller: Caller = { principal };
		const agentHeader = header(req, AGENT_HEADER);
		if (agentHeader) {
			this.engine.requireOwnAgent(principal, agentHeader);
			caller.agent = agentHeader;
		}
		const contentType = header(req, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
		if (contentType && !JSON_TYPES.has(contentType)) {
			const error = JsonRpcTransportHandler.mapToJSONRPCError(
				new ContentTypeNotSupportedError(`Unsupported Content-Type "${contentType}"; expected application/json.`),
			);
			sendJson(res, 200, rpcError(null, error));
			return;
		}
		const text = await readBody(req);
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			sendJson(res, 200, rpcError(null, { code: -32700, message: "Invalid JSON payload." }));
			return;
		}
		const id = (body as { id?: unknown } | null)?.id ?? null;
		if ("ambiguous" in resolved) {
			sendJson(
				res,
				200,
				rpcError(id, {
					code: AMBIGUOUS_ALIAS,
					message: `agent alias ${ref} matches more than one online agent`,
					data: [
						{
							"@type": "type.googleapis.com/google.rpc.ErrorInfo",
							reason: "AMBIGUOUS_ALIAS",
							domain: "pimon",
							metadata: { agents: resolved.ambiguous.join(",") },
						},
					],
				}),
			);
			return;
		}
		const card = this.#cardFor(req, resolved);
		const version = requestedVersion(req, url);
		const context = defaultServerCallContextBuilder({
			extensions: Extensions.parseServiceParameter(header(req, "a2a-extensions")),
			user: undefined,
			headers: req.headers,
			requestedVersion: version,
		});
		try {
			validateVersion(version, AgentCard.fromJSON(card), "JSONRPC");
		} catch (error) {
			sendJson(res, 200, rpcError(id, JsonRpcTransportHandler.mapToJSONRPCError(error)));
			return;
		}
		const controller = new AbortController();
		res.on("close", () => controller.abort());
		const handler = new HubRequestHandler({
			engine: this.engine,
			agent: resolved,
			caller,
			card,
			builtin,
			signal: controller.signal,
			holds: this.#holds,
			log: this.#log,
		});
		const transport = new JsonRpcTransportHandler(handler);
		let outcome: Awaited<ReturnType<JsonRpcTransportHandler["handle"]>>;
		try {
			outcome = await transport.handle(body as Record<string, unknown>, context);
		} catch (error) {
			sendJson(res, 200, rpcError(id, JsonRpcTransportHandler.mapToJSONRPCError(toA2AError(error))));
			return;
		}
		const extensionHeaders: Record<string, string> = {};
		if (context.activatedExtensions && context.activatedExtensions.length > 0) {
			extensionHeaders["A2A-Extensions"] = Extensions.toServiceParameter(context.activatedExtensions);
		}
		if (!(Symbol.asyncIterator in outcome)) {
			sendJson(res, 200, outcome, extensionHeaders);
			return;
		}
		const iterator = outcome[Symbol.asyncIterator]();
		let first: IteratorResult<unknown>;
		try {
			first = await iterator.next();
		} catch (error) {
			sendJson(res, 200, rpcError(id, JsonRpcTransportHandler.mapToJSONRPCError(toA2AError(error))));
			return;
		}
		res.writeHead(200, { ...SSE_HEADERS, ...extensionHeaders });
		res.flushHeaders();
		const heartbeat = setInterval(() => {
			if (!res.writableEnded) res.write(": hb\n\n");
		}, this.#config.heartbeatMs);
		try {
			if (!first.done) res.write(formatSSEEvent(first.value));
			for (;;) {
				const next = await iterator.next();
				if (next.done) break;
				if (res.writableEnded) break;
				res.write(formatSSEEvent(next.value));
			}
		} catch (error) {
			if (!res.writableEnded) {
				res.write(formatSSEErrorEvent(rpcError(id, JsonRpcTransportHandler.mapToJSONRPCError(toA2AError(error)))));
			}
		} finally {
			clearInterval(heartbeat);
			await iterator.return?.(undefined);
			if (!res.writableEnded) res.end();
		}
	}

	// ---------- link ----------

	async #linkRoute(req: IncomingMessage, res: ServerResponse, url: URL, method: string, rest: string[]): Promise<void> {
		const principal = this.#requireHost(req);
		if (rest.length === 1 && rest[0] === "register" && method === "POST") {
			const body = await readJson(req);
			sendJson(res, 200, this.engine.register(principal, body as never));
			return;
		}
		const [agentId, action, arg, ...extra] = rest;
		if (!agentId || extra.length > 0) throw new HttpError(404, "not found");
		this.engine.requireOwnAgent(principal, agentId);
		const route = `${method} ${action ?? ""}${arg === undefined ? "" : " *"}`;
		switch (route) {
			case "GET events":
				this.link.open(agentId, req, res, lastEventId(req, url));
				return;
			case "DELETE ":
				this.link.offlineNow(agentId);
				sendJson(res, 200, { ok: true });
				return;
			case "POST ack": {
				const body = await readJson(req);
				sendJson(res, 200, { acked: this.engine.ack(agentId, body["upTo"]) });
				return;
			}
			case "POST state": {
				const body = await readJson(req);
				this.engine.setState(agentId, body["state"], body["activity"]);
				sendJson(res, 200, { ok: true });
				return;
			}
			case "POST status": {
				const body = await readJson(req);
				sendJson(res, 200, { text: this.engine.setStatus(agentId, body["text"]) });
				return;
			}
			case "POST tasks *": {
				const body = await readJson(req);
				sendJson(res, 200, this.engine.linkUpdate(agentId, arg ?? "", body as never));
				return;
			}
			case "POST topics": {
				const body = await readJson(req);
				sendJson(res, 200, { topics: this.engine.setTopics(agentId, body["subscribe"], body["unsubscribe"]) });
				return;
			}
			case "POST control": {
				const body = await readJson(req);
				this.engine.control(agentId, body["target"], body["action"]);
				sendJson(res, 200, { ok: true });
				return;
			}
			case "GET inbox": {
				const unread = url.searchParams.get("unread") === "1";
				const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20) || 20, 1), 200);
				sendJson(res, 200, { messages: this.engine.inbox(agentId, unread, limit) });
				return;
			}
			case "POST read": {
				const body = await readJson(req);
				sendJson(res, 200, { read: this.engine.markRead(agentId, body["ids"]) });
				return;
			}
			case "GET message *":
				sendJson(res, 200, this.engine.message(agentId, arg ?? ""));
				return;
			case "GET pending":
				sendJson(res, 200, this.engine.pending(agentId));
				return;
			case "GET owed":
				sendJson(res, 200, this.engine.owed(agentId));
				return;
			case "GET thread *":
				sendJson(res, 200, this.engine.thread(agentId, arg ?? ""));
				return;
			case "POST children": {
				const body = await readJson(req);
				sendJson(res, 200, this.engine.addChild(principal, agentId, body as never));
				return;
			}
			default:
				throw new HttpError(404, "not found");
		}
	}
}
