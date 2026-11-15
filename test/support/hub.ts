import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Message, SendMessageRequest, type SendMessageRequest as SendMessageRequestType } from "@a2a-js/sdk";
import {
	type Client,
	ClientFactory,
	ClientFactoryOptions,
	DefaultAgentCardResolver,
	JsonRpcTransportFactory,
} from "@a2a-js/sdk/client";
import { HubClient, type SendOutcome } from "../../src/features/bus/hub/client.ts";
import { HubLink, type Registration } from "../../src/features/bus/hub/link.ts";
import type { ExternalAgentConfig } from "../../src/hub/external.ts";
import type { AgentInfo, AgentsResult, BusMetadata, LinkEvent, LinkEventType } from "../../src/hub/protocol.ts";
import {
	BUS_URI,
	HOST_TOKEN,
	type HubProcess,
	OTHER_HOST_TOKEN,
	PEER_TOKEN,
	sleep,
	startHubProcess,
	tempDir,
} from "./hub-process.ts";

export {
	BUS_URI,
	HOST_TOKEN,
	type HubProcess,
	LinkClient,
	type LinkEventRecord,
	OTHER_HOST_TOKEN,
	PEER_TOKEN,
	PROTOCOL,
	sleep,
	startHubProcess,
	tempDir,
	writeTokens,
} from "./hub-process.ts";

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

/** A hub process that tests reach only over HTTP, so `HUB_BIN` can swap the hub under test. */
export interface TestHub {
	url: string;
	/** What `GET /agents` lists. `offline` also lists agents that went offline lately. */
	agents(offline?: boolean): Promise<AgentInfo[]>;
	/** Stops the process. The port and the data stay for `restart`. */
	stop(): Promise<void>;
	/** Starts the hub again on the same port with the same data. */
	restart(): Promise<void>;
	/** Removes the token of host `mars` from the token file and reloads it with `SIGHUP`. */
	revokeHostToken(): Promise<void>;
	/** Stops the process and deletes its data. */
	close(): Promise<void>;
}

/** External agent entry as the hub external file gives it. The hub defaults the fields that it leaves out. */
export type ExternalAgent = Omit<ExternalAgentConfig, "cardTtlMs">;

function writeTokenFile(file: string, withHost = true): void {
	const hex = (token: string) => createHash("sha256").update(token).digest("hex");
	const tokens: Record<string, { kind: "host" | "peer"; sha256: string }> = {
		venus: { kind: "host", sha256: hex(OTHER_HOST_TOKEN) },
		hermes: { kind: "peer", sha256: hex(PEER_TOKEN) },
	};
	if (withHost) tokens["mars"] = { kind: "host", sha256: hex(HOST_TOKEN) };
	writeFileSync(file, JSON.stringify(tokens), { mode: 0o600 });
}

/** A hub may drain open streams on SIGTERM. A test does not wait for that. */
const STOP_WAIT_MS = 2_000;

/** A hub process on a free loopback port with a temp data dir. */
export async function startTestHub(
	options: { presenceGraceMs?: number; external?: ExternalAgent[] } = {},
): Promise<TestHub> {
	const tmp = tempDir("pimon-test-hub-");
	const tokensFile = join(tmp.dir, "tokens.json");
	writeTokenFile(tokensFile);
	let externalFile: string | undefined;
	if (options.external) {
		externalFile = join(tmp.dir, "external.json");
		const entries = Object.fromEntries(options.external.map(({ id, ...entry }) => [id, entry]));
		writeFileSync(externalFile, JSON.stringify(entries), { mode: 0o600 });
	}
	const env = {
		HUB_PRESENCE_GRACE_MS: String(options.presenceGraceMs ?? 300),
		HUB_HEARTBEAT_MS: "60000",
	};
	const launch = (port?: number) =>
		startHubProcess({
			dataDir: join(tmp.dir, "data"),
			tokensFile,
			env,
			...(port === undefined ? {} : { port }),
			...(externalFile ? { externalFile } : {}),
		});
	let current: HubProcess | undefined;
	try {
		current = await launch();
	} catch (error) {
		tmp.dispose();
		throw error;
	}
	const { url, port } = current;
	let closed = false;
	const stop = async () => {
		const running = current;
		current = undefined;
		if (!running) return;
		const exited = await Promise.race([running.stop().then(() => true), sleep(STOP_WAIT_MS).then(() => false)]);
		if (!exited) await running.stop("SIGKILL");
	};
	return {
		url,
		async agents(offline = false) {
			const response = await fetch(`${url}/agents${offline ? "?offline=1" : ""}`, { headers: bearer(HOST_TOKEN) });
			if (response.status !== 200) throw new Error(`GET /agents: ${response.status} ${await response.text()}`);
			return ((await response.json()) as AgentsResult).agents;
		},
		stop,
		async restart() {
			await stop();
			current = await launch(port);
		},
		async revokeHostToken() {
			writeTokenFile(tokensFile, false);
			current?.child.kill("SIGHUP");
			const deadline = Date.now() + 5_000;
			for (;;) {
				const response = await fetch(`${url}/agents`, { headers: bearer(HOST_TOKEN) });
				await response.body?.cancel();
				if (response.status === 401) return;
				if (Date.now() > deadline) throw new Error(`hub still accepts the mars token: ${response.status}`);
				await sleep(20);
			}
		},
		async close() {
			if (closed) return;
			closed = true;
			await stop();
			tmp.dispose();
		},
	};
}

/** Points the bus feature of `agentDir` at `url`: `pimon.json` plus a 0600 token file. Keeps other config. */
export function writeHubConfig(
	agentDir: string,
	url: string,
	options: { token?: string; features?: Record<string, unknown> } = {},
): void {
	const configPath = join(agentDir, "pimon.json");
	let config: { features?: Record<string, unknown> } = {};
	try {
		config = JSON.parse(readFileSync(configPath, "utf8")) as typeof config;
	} catch {
		// No config yet.
	}
	const features = { ...config.features, ...options.features };
	const bus = (features["bus"] ?? {}) as Record<string, unknown>;
	features["bus"] = { ...bus, hub: { url } };
	writeFileSync(configPath, JSON.stringify({ ...config, features }));
	writeFileSync(join(agentDir, "pimon-hub.token"), `${options.token ?? HOST_TOKEN}\n`, { mode: 0o600 });
}

/** Another pi session on the hub, driven by the client modules of the bus feature. */
export interface HubPeer {
	id: string;
	name: string;
	client: HubClient;
	events: LinkEvent[];
	send(
		to: string,
		text: string,
		meta?: Partial<BusMetadata>,
		ids?: { messageId?: string; contextId?: string; taskId?: string },
	): Promise<SendOutcome & { messageId: string }>;
	next<T extends LinkEventType>(
		type: T,
		match?: (payload: LinkEvent<T>["payload"]) => boolean,
		timeoutMs?: number,
	): Promise<LinkEvent<T>>;
	/** Stops the link. `offline` also tells the hub at once. */
	stop(offline?: boolean): Promise<void>;
}

export async function startPeer(
	url: string,
	name: string,
	options: Omit<Registration, "name"> & { token?: string; id?: string } = {},
): Promise<HubPeer> {
	const { token, id: given, ...registration } = options;
	const id = given ?? crypto.randomUUID();
	const client = new HubClient({ url, token: token ?? HOST_TOKEN, agent: id });
	const events: LinkEvent[] = [];
	const waiters = new Set<() => void>();
	const link = new HubLink({
		client,
		registration: () => ({ name, ...registration }),
		onEvent: (event) => {
			events.push(event);
			for (const wake of waiters) wake();
		},
		onStatus: () => {},
	});
	link.start();
	const deadline = Date.now() + 5_000;
	while (link.status.state !== "online") {
		if (Date.now() > deadline) throw new Error(`peer ${name} did not link: ${JSON.stringify(link.status)}`);
		await sleep(10);
	}
	return {
		id,
		name,
		client,
		events,
		async send(to, text, meta = {}, ids = {}) {
			const messageId = ids.messageId ?? crypto.randomUUID();
			const outcome = await client.sendMessage(to, {
				messageId,
				contextId: ids.contextId ?? crypto.randomUUID(),
				taskId: ids.taskId,
				text,
				meta: { kind: "note", wake: "now", ...meta },
			});
			return { ...outcome, messageId };
		},
		async next(type, match = () => true, timeoutMs = 5_000) {
			const end = Date.now() + timeoutMs;
			for (;;) {
				const found = events.find(
					(event): event is LinkEvent<typeof type> =>
						event.type === type && match((event as LinkEvent<typeof type>).payload),
				);
				if (found) return found;
				const left = end - Date.now();
				if (left <= 0) throw new Error(`peer ${name}: no ${type} event; got ${JSON.stringify(events)}`);
				await new Promise<void>((done) => {
					const wake = () => {
						clearTimeout(timer);
						waiters.delete(wake);
						done();
					};
					const timer = setTimeout(wake, left);
					waiters.add(wake);
				});
			}
		},
		async stop(offline = true) {
			await link.stop();
			if (offline) await client.offline().catch(() => {});
		},
	};
}

/** One external agent entry with short timings, as the hub external file gives it. */
export function externalAgent(id: string, url: string, token: string): ExternalAgent {
	return {
		id,
		name: id,
		url,
		token,
		description: `${id} test agent`,
		pollMs: 100,
		idleMs: 2_000,
		retryMs: 300,
		offlineMs: 2_000,
		replyTimeoutMs: 10_000,
	};
}
