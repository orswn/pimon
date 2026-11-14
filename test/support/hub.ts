import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Message, SendMessageRequest, type SendMessageRequest as SendMessageRequestType } from "@a2a-js/sdk";
import {
	type Client,
	ClientFactory,
	ClientFactoryOptions,
	DefaultAgentCardResolver,
	JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";

export const HUB_MAIN = resolve(import.meta.dirname, "../../src/hub/main.ts");
export const BUS_URI = "https://github.com/orswn/pimon/a2a/bus/v1";
export const HOST_TOKEN = "mars-token";
export const OTHER_HOST_TOKEN = "venus-token";
export const PEER_TOKEN = "hermes-token";

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function tempDir(prefix: string): { dir: string; dispose(): void } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeTokens(dir: string): string {
	const hex = (token: string) => createHash("sha256").update(token).digest("hex");
	const file = join(dir, "tokens.json");
	writeFileSync(
		file,
		JSON.stringify({
			mars: { kind: "host", sha256: hex(HOST_TOKEN) },
			venus: { kind: "host", sha256: hex(OTHER_HOST_TOKEN) },
			hermes: { kind: "peer", sha256: hex(PEER_TOKEN) },
		}),
	);
	return file;
}

export interface HubProcess {
	url: string;
	port: number;
	child: ChildProcess;
	stderr(): string;
	stop(signal?: NodeJS.Signals): Promise<number | null>;
}

export async function startHubProcess(options: {
	dataDir: string;
	tokensFile?: string;
	externalFile?: string;
	testAgents?: boolean;
	env?: Record<string, string>;
}): Promise<HubProcess> {
	const args = [HUB_MAIN, "--listen", "127.0.0.1:0", "--data", options.dataDir];
	if (options.tokensFile) args.push("--tokens", options.tokensFile);
	if (options.externalFile) args.push("--external", options.externalFile);
	if (options.testAgents) args.push("--test-agents");
	const child = spawn(process.execPath, ["--no-warnings", ...args], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...options.env },
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
	const port = await new Promise<number>((done, fail) => {
		let out = "";
		const timer = setTimeout(() => fail(new Error(`hub did not start: ${stderr}`)), 10_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
			const match = /listening (\d+)/.exec(out);
			if (match) {
				clearTimeout(timer);
				done(Number(match[1]));
			}
		});
		void exited.then((code) => {
			clearTimeout(timer);
			fail(new Error(`hub exited with ${code}: ${stderr}`));
		});
	});
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		child,
		stderr: () => stderr,
		stop: async (signal = "SIGTERM") => {
			if (child.exitCode === null && child.signalCode === null) child.kill(signal);
			return exited;
		},
	};
}

function authFetch(headers: Record<string, string>): typeof fetch {
	return (input, init) => {
		const merged = new Headers(init?.headers);
		for (const [key, value] of Object.entries(headers)) merged.set(key, value);
		return fetch(input, { ...init, headers: merged });
	};
}

/** The SDK resolver drops sub paths of a base URL, so the client gets the full card URL. */
export async function a2aClient(hubUrl: string, agent: string, headers: Record<string, string> = {}): Promise<Client> {
	const fetchImpl = authFetch(headers);
	const factory = new ClientFactory(
		ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
			transports: [new JsonRpcTransportFactory({ fetchImpl })],
			cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
		}),
	);
	return factory.createFromUrl(`${hubUrl}/a2a/${agent}/.well-known/agent-card.json`, "");
}

export function bearer(token: string, agent?: string): Record<string, string> {
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (agent) headers["X-Pimon-Agent"] = agent;
	return headers;
}

export function sendRequest(
	text: string,
	options: {
		taskId?: string;
		contextId?: string;
		messageId?: string;
		bus?: Record<string, unknown>;
		returnImmediately?: boolean;
		push?: { url: string; token?: string; id?: string };
	} = {},
): SendMessageRequestType {
	const message: Record<string, unknown> = {
		messageId: options.messageId ?? crypto.randomUUID(),
		role: "ROLE_USER",
		parts: [{ text }],
	};
	if (options.taskId) message["taskId"] = options.taskId;
	if (options.contextId) message["contextId"] = options.contextId;
	if (options.bus) message["metadata"] = { [BUS_URI]: options.bus };
	const configuration: Record<string, unknown> = {};
	if (options.returnImmediately) configuration["returnImmediately"] = true;
	if (options.push) configuration["taskPushNotificationConfig"] = options.push;
	return SendMessageRequest.fromJSON({ message: Message.toJSON(Message.fromJSON(message)), configuration });
}

export function partText(item: { parts?: { content?: { $case: string; value: unknown } }[] } | undefined): string {
	return (item?.parts ?? []).map((part) => (part.content?.$case === "text" ? String(part.content.value) : "")).join("");
}

export interface LinkEventRecord {
	id: number;
	type: string;
	data: Record<string, unknown>;
}

export class LinkClient {
	readonly events: LinkEventRecord[] = [];
	readonly #hub: string;
	readonly #headers: Record<string, string>;
	readonly agent: string;
	#controller: AbortController | undefined;
	#waiters: (() => void)[] = [];
	#done: Promise<void> | undefined;
	closedByServer = false;

	constructor(hub: string, agent: string, token = HOST_TOKEN) {
		this.#hub = hub;
		this.agent = agent;
		this.#headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	}

	async request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
		const init: RequestInit = { method, headers: this.#headers };
		if (body !== undefined) init.body = JSON.stringify(body);
		const response = await fetch(`${this.#hub}${path}`, init);
		const text = await response.text();
		return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
	}

	async ok(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
		const result = await this.request(method, path, body);
		if (result.status !== 200) throw new Error(`${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`);
		return result.body as Record<string, unknown>;
	}

	register(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		return this.ok("POST", "/link/register", { agent: this.agent, protocol: 2, ...extra });
	}

	async connect(options: { lastEventId?: string; query?: string } = {}): Promise<void> {
		this.#controller = new AbortController();
		const headers: Record<string, string> = { ...this.#headers };
		if (options.lastEventId !== undefined) headers["Last-Event-ID"] = options.lastEventId;
		const query = options.query === undefined ? "" : `?${options.query}`;
		const response = await fetch(`${this.#hub}/link/${this.agent}/events${query}`, {
			headers,
			signal: this.#controller.signal,
		});
		if (response.status !== 200 || !response.body) throw new Error(`events: ${response.status}`);
		const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
		this.#done = (async () => {
			let buffer = "";
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += value;
					let end = buffer.indexOf("\n\n");
					while (end >= 0) {
						this.#frame(buffer.slice(0, end));
						buffer = buffer.slice(end + 2);
						end = buffer.indexOf("\n\n");
					}
				}
				this.closedByServer = true;
			} catch {
				// aborted by close()
			}
			this.#wake();
		})();
	}

	#frame(frame: string): void {
		let id = 0;
		let type = "message";
		let data = "";
		for (const line of frame.split("\n")) {
			if (line.startsWith("id: ")) id = Number(line.slice(4));
			else if (line.startsWith("event: ")) type = line.slice(7);
			else if (line.startsWith("data: ")) data += line.slice(6);
		}
		if (!data) return;
		this.events.push({ id, type, data: JSON.parse(data) as Record<string, unknown> });
		this.#wake();
	}

	#wake(): void {
		for (const wake of this.#waiters.splice(0)) wake();
	}

	async next(
		type: string,
		match: (data: Record<string, unknown>) => boolean = () => true,
		timeoutMs = 5000,
	): Promise<LinkEventRecord> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.events.find((event) => event.type === type && match(event.data));
			if (found) return found;
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`no ${type} event for ${this.agent}; got ${JSON.stringify(this.events)}`);
			await new Promise<void>((done) => {
				const timer = setTimeout(done, left);
				this.#waiters.push(() => {
					clearTimeout(timer);
					done();
				});
			});
		}
	}

	ack(upTo: number): Promise<Record<string, unknown>> {
		return this.ok("POST", `/link/${this.agent}/ack`, { upTo });
	}

	update(taskId: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
		return this.request("POST", `/link/${this.agent}/tasks/${taskId}`, body);
	}

	status(text: string): Promise<Record<string, unknown>> {
		return this.ok("POST", `/link/${this.agent}/status`, { text });
	}

	async close(): Promise<void> {
		this.#controller?.abort();
		await this.#done;
	}
}

export interface Webhook {
	url: string;
	calls: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[];
	waitFor(match: (body: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<void>;
	close(): Promise<void>;
}

export async function startWebhook(): Promise<Webhook> {
	const calls: Webhook["calls"] = [];
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		req.on("end", () => {
			calls.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(body) as Record<string, unknown> });
			res.writeHead(200).end();
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		calls,
		async waitFor(match, timeoutMs = 5000) {
			const deadline = Date.now() + timeoutMs;
			while (!calls.some((call) => match(call.body))) {
				if (Date.now() > deadline) throw new Error(`no matching push; got ${JSON.stringify(calls.map((c) => c.body))}`);
				await sleep(20);
			}
		},
		close: () =>
			new Promise<void>((done) => {
				server.closeAllConnections();
				server.close(() => done());
			}),
	};
}
