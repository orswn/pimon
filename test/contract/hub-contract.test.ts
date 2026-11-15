import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import Schema from "typebox/schema";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
	AGENT_HEADER,
	BUS_URI,
	HARNESS,
	HOST_TOKEN,
	type HubProcess,
	LinkClient,
	type LinkEventRecord,
	OTHER_HOST_TOKEN,
	PEER_TOKEN,
	PROTOCOL,
	startHubProcess,
	tempDir,
	writeTokens,
} from "../support/hub-process.ts";

// Black-box contract of the hub link API. It talks to a hub process only over HTTP and SSE,
// and it checks the bodies against the JSON Schema file of the a2a-hub protocol package, not against TypeScript types.

interface Ref {
	$ref: string;
}

interface RouteEntry {
	method: string;
	path: string;
	request: Ref | null;
	response: Ref | null;
	stream: boolean;
	errors: Record<string, Ref>;
}

interface ProtocolDocument {
	$defs: Record<string, unknown>;
	"x-routes": Record<string, RouteEntry>;
	"x-events": Record<string, { payload: Ref; stored: boolean }>;
}

const SCHEMA_FILE = createRequire(import.meta.url).resolve(`@orswn/a2a-hub-protocol/hub-protocol-v${PROTOCOL}.json`);
const document = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as ProtocolDocument;
const routes = document["x-routes"];
const events = document["x-events"];
const BODY_LIMIT = 1024 * 1024;

/**
 * Sets `additionalProperties: false` on each object schema that does not set it and has no `patternProperties`.
 * So an undeclared field fails, while string maps such as `labels` and objects marked open stay open.
 */
function closeObjects(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(closeObjects);
	if (!node || typeof node !== "object") return node;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) out[key] = closeObjects(value);
	if (out["type"] === "object" && !("additionalProperties" in out) && !("patternProperties" in out)) {
		out["additionalProperties"] = false;
	}
	return out;
}

const closedDefs = closeObjects(document.$defs) as Record<string, unknown>;
const validators = new Map<string, ReturnType<typeof Schema.Compile>>();

function refName(ref: Ref): string {
	const prefix = "#/$defs/";
	if (!ref.$ref.startsWith(prefix)) throw new Error(`unexpected $ref ${ref.$ref}`);
	return ref.$ref.slice(prefix.length);
}

function check(name: string, value: unknown, where: string): void {
	let validator = validators.get(name);
	if (!validator) {
		if (!(name in closedDefs)) throw new Error(`${where}: no definition ${name}`);
		validator = Schema.Compile({ $defs: closedDefs, $ref: `#/$defs/${name}` } as Schema.XSchema);
		validators.set(name, validator);
	}
	const [valid, errors] = validator.Errors(value);
	if (!valid) {
		throw new Error(
			`${where}: value does not match ${name}\nerrors: ${JSON.stringify(errors, null, 2)}\nvalue: ${JSON.stringify(value)}`,
		);
	}
}

function routeOf(method: string, path: string): string {
	const segments = path.split("?")[0]?.split("/").filter(Boolean).map(decodeURIComponent) ?? [];
	for (const [key, route] of Object.entries(routes)) {
		const parts = route.path.split("/").filter(Boolean);
		if (route.method !== method || parts.length !== segments.length) continue;
		if (parts.every((part, index) => part.startsWith(":") || part === segments[index])) return key;
	}
	throw new Error(`${method} ${path} matches no route in ${SCHEMA_FILE}`);
}

describe("hub link contract", () => {
	const tmp = tempDir("hub-contract-");
	let hub: HubProcess;
	const links: LinkClient[] = [];
	const checkedEvents = new WeakSet<LinkEventRecord>();
	const seen = {
		routes: new Set<string>(),
		events: new Set<string>(),
		errorSchemas: new Set<string>(),
		statuses: new Set<number>(),
	};
	let rpcId = 0;

	const alpha = "contract-alpha";
	const beta = "contract-beta";
	const kid = "contract-kid";
	const idle = "contract-idle";
	let alphaLink: LinkClient;
	let betaLink: LinkClient;
	let kidLink: LinkClient;

	beforeAll(async () => {
		hub = await startHubProcess({
			dataDir: `${tmp.dir}/data`,
			tokensFile: writeTokens(tmp.dir),
			env: { HUB_PRESENCE_GRACE_MS: "300" },
		});
	});

	afterAll(async () => {
		try {
			for (const link of links) checkEvents(link);
			const missing = {
				routes: Object.keys(routes).filter((key) => !seen.routes.has(key)),
				events: Object.keys(events).filter((name) => !seen.events.has(name)),
				errorSchemas: [
					...new Set(Object.values(routes).flatMap((route) => Object.values(route.errors).map(refName))),
				].filter((name) => !seen.errorSchemas.has(name)),
				statuses: [400, 401, 403, 404, 409, 413, 426].filter((status) => !seen.statuses.has(status)),
			};
			expect(missing).toEqual({ routes: [], events: [], errorSchemas: [], statuses: [] });
		} finally {
			for (const link of links) await link.close();
			await hub?.stop();
			tmp.dispose();
		}
	});

	/** Sends one request. A 2xx body must match the route response, else the body must match the listed error. */
	async function call(
		method: string,
		path: string,
		options: { token?: string | null; body?: unknown; raw?: string } = {},
	): Promise<{ status: number; body: unknown }> {
		const key = routeOf(method, path);
		const route = routes[key] as RouteEntry;
		const headers: Record<string, string> = {};
		const token = options.token === undefined ? HOST_TOKEN : options.token;
		if (token) headers["Authorization"] = `Bearer ${token}`;
		const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
		if (payload !== undefined) headers["Content-Type"] = "application/json";
		const response = await fetch(`${hub.url}${path}`, { method, headers, body: payload ?? null });
		const text = await response.text();
		const body = text ? (JSON.parse(text) as unknown) : null;
		const where = `${key} ${response.status}`;
		expect(response.headers.get("content-type"), where).toBe("application/json");
		if (response.status >= 200 && response.status < 300) {
			if (!route.response) throw new Error(`${where}: the route has no JSON response`);
			check(refName(route.response), body, where);
			if (route.request && options.body !== undefined) check(refName(route.request), options.body, `${key} request`);
			seen.routes.add(key);
		} else {
			const ref = route.errors[String(response.status)];
			if (!ref) throw new Error(`${where}: status not listed for the route: ${text}`);
			check(refName(ref), body, where);
			seen.errorSchemas.add(refName(ref));
			seen.statuses.add(response.status);
		}
		return { status: response.status, body };
	}

	async function ok(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
		const result = await call(method, path, { body });
		expect(result.status, JSON.stringify(result.body)).toBe(200);
		return result.body as Record<string, unknown>;
	}

	async function fails(
		status: number,
		method: string,
		path: string,
		options: { token?: string | null; body?: unknown; raw?: string } = {},
	): Promise<Record<string, unknown>> {
		const result = await call(method, path, options);
		expect(result.status, JSON.stringify(result.body)).toBe(status);
		return result.body as Record<string, unknown>;
	}

	function checkEvents(link: LinkClient): void {
		for (const event of link.events) {
			if (checkedEvents.has(event)) continue;
			const where = `event ${event.type} for ${link.agent}`;
			const spec = events[event.type];
			if (!spec) throw new Error(`${where}: event type not listed: ${JSON.stringify(event)}`);
			if (spec.stored) expect(event.id, `${where}: id`).toBeGreaterThan(0);
			else expect(event.id, `${where}: id`).toBe(0);
			check(refName(spec.payload), event.data, where);
			checkedEvents.add(event);
			seen.events.add(event.type);
		}
	}

	async function stream(agent: string): Promise<LinkClient> {
		const link = new LinkClient(hub.url, agent);
		links.push(link);
		await link.connect();
		seen.routes.add("GET /link/:agent/events");
		return link;
	}

	async function next(
		link: LinkClient,
		type: string,
		match: (data: Record<string, unknown>) => boolean = () => true,
	): Promise<LinkEventRecord> {
		const event = await link.next(type, match);
		checkEvents(link);
		return event;
	}

	async function rpc(from: string, to: string, method: string, params: unknown): Promise<Record<string, unknown>> {
		const response = await fetch(`${hub.url}/a2a/${to}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${HOST_TOKEN}`,
				[AGENT_HEADER]: from,
				"Content-Type": "application/json",
				"A2A-Version": "1.0",
				"A2A-Extensions": BUS_URI,
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
		});
		const json = (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
		if (response.status !== 200 || !json.result) throw new Error(`${method}: ${JSON.stringify(json)}`);
		return json.result;
	}

	async function send(
		from: string,
		to: string,
		text: string,
		bus: Record<string, unknown>,
		ids: { messageId?: string; contextId?: string } = {},
	): Promise<{ taskId?: string; metadata?: Record<string, unknown> }> {
		const result = await rpc(from, to, "SendMessage", {
			message: {
				messageId: ids.messageId ?? crypto.randomUUID(),
				contextId: ids.contextId ?? crypto.randomUUID(),
				role: "ROLE_USER",
				parts: [{ text }],
				metadata: { [BUS_URI]: bus },
			},
			configuration: { returnImmediately: true },
		});
		const task = result["task"] as { id: string; metadata?: Record<string, unknown> } | undefined;
		const item = task ?? (result["message"] as { metadata?: Record<string, unknown> } | undefined);
		if (!item) throw new Error(`SendMessage gave no task or message: ${JSON.stringify(result)}`);
		return { ...(task ? { taskId: task.id } : {}), ...(item.metadata ? { metadata: item.metadata } : {}) };
	}

	async function sendTask(from: string, to: string, text: string, bus: Record<string, unknown>, contextId?: string) {
		const { taskId } = await send(from, to, text, { kind: "task", ...bus }, contextId ? { contextId } : {});
		if (!taskId) throw new Error(`SendMessage to ${to} gave no task`);
		return taskId;
	}

	it("reads the schema of the protocol under test", () => {
		expect((document as { $id?: string }).$id).toBe(`urn:a2a-hub:protocol:${PROTOCOL}`);
		expect((document as { "x-bus-extension-uri"?: string })["x-bus-extension-uri"]).toBe(BUS_URI);
	});

	it("answers health without a token", async () => {
		await call("GET", "/healthz", { token: null });
		expect(seen.routes.has("GET /healthz")).toBe(true);
	});

	it("registers agents and a child, and lists them", async () => {
		await ok("POST", "/link/register", {
			agent: alpha,
			name: "alpha",
			cwd: "/work",
			role: "lead",
			labels: { harness: HARNESS, team: "core" },
			topics: ["build"],
			ephemeral: false,
			protocol: PROTOCOL,
		});
		const events = await fetch(`${hub.url}/link/${alpha}/events`, {
			headers: { Authorization: `Bearer ${HOST_TOKEN}` },
			signal: AbortSignal.timeout(2_000),
		});
		expect(events.status).toBe(200);
		expect(events.headers.get("content-type")).toBe("text/event-stream");
		await events.body?.cancel();
		alphaLink = await stream(alpha);
		expect(
			await ok("POST", `/link/${alpha}/children`, {
				id: kid,
				name: "kid",
				role: "helper",
				labels: { harness: HARNESS },
				cwd: "/k",
			}),
		).toEqual({ agent: kid, name: "kid", host: "mars" });
		await ok("POST", "/link/register", { agent: kid, parent: alpha, protocol: PROTOCOL });
		kidLink = await stream(kid);
		await next(alphaLink, "presence", (data) => data["agent"] === kid && data["online"] === true);
		await ok("POST", "/link/register", { agent: beta, name: "beta", labels: { harness: HARNESS }, protocol: PROTOCOL });
		betaLink = await stream(beta);

		const listed = await ok("GET", "/agents");
		expect((listed["agents"] as { id: string }[]).map((agent) => agent.id)).toEqual(
			expect.arrayContaining([alpha, beta, kid]),
		);
		await ok("GET", "/agents?offline=1");
		expect(await ok("GET", `/agents/${alpha}`)).toMatchObject({
			id: alpha,
			kind: "session",
			labels: { harness: HARNESS, team: "core" },
		});
	});

	it("stores state, status, and topics", async () => {
		await ok("POST", `/link/${alpha}/state`, { state: "busy", activity: "testing" });
		expect(await ok("POST", `/link/${alpha}/status`, { text: "  checking\n the contract " })).toEqual({
			text: "checking the contract",
		});
		expect(await ok("POST", `/link/${alpha}/topics`, { subscribe: ["a", "b"], unsubscribe: ["b"] })).toEqual({
			topics: ["build", "a"],
		});
	});

	it("delivers a task, its update, and the inbox views", async () => {
		const taskId = await sendTask(
			alpha,
			beta,
			"please review",
			{ wake: "now", expectReply: true, subject: "review", priority: "important", data: { n: 1 } },
			"ctx-review",
		);
		await next(betaLink, "message", (data) => data["taskId"] === taskId);
		expect((await ok("GET", `/link/${beta}/owed`))["tasks"]).toEqual([expect.objectContaining({ taskId })]);
		expect((await ok("GET", `/link/${alpha}/pending`))["tasks"]).toEqual([expect.objectContaining({ taskId })]);
		await ok("POST", `/link/${beta}/tasks/${taskId}`, {
			state: "working",
			text: "on it",
			artifact: { name: "notes", text: "draft", data: { ok: true } },
		});
		const update = await next(alphaLink, "update", (data) => data["taskId"] === taskId);
		const messageId = String(update.data["messageId"]);

		const inbox = await ok("GET", `/link/${alpha}/inbox?unread=1&limit=5`);
		expect((inbox["messages"] as { messageId: string }[]).map((item) => item.messageId)).toContain(messageId);
		expect(await ok("POST", `/link/${alpha}/read`, { ids: [messageId] })).toEqual({ read: 1 });
		const received = await ok("GET", `/link/${beta}/inbox`);
		expect(received["messages"]).toEqual([expect.objectContaining({ data: { n: 1 }, taskState: "working" })]);
		expect(await ok("GET", `/link/${alpha}/message/${messageId.slice(0, 12)}`)).toMatchObject({ text: "on it" });
		const thread = await ok("GET", `/link/${alpha}/thread/ctx-review`);
		expect((thread["messages"] as { text: string }[]).map((item) => item.text)).toEqual(["please review", "on it"]);

		await ok("POST", `/link/${beta}/tasks/${taskId}`, { state: "completed", text: "done" });
		await next(alphaLink, "update", (data) => data["taskId"] === taskId && data["state"] === "completed");
		await fails(409, "POST", `/link/${beta}/tasks/${taskId}`, { body: { state: "completed" } });
	});

	it("cancels a task through A2A and tells both sides", async () => {
		const taskId = await sendTask(alpha, beta, "cancel me", {});
		await next(betaLink, "message", (data) => data["taskId"] === taskId);
		await rpc(alpha, beta, "CancelTask", { id: taskId });
		await next(betaLink, "cancel", (data) => data["taskId"] === taskId);
		await next(alphaLink, "update", (data) => data["taskId"] === taskId && data["state"] === "canceled");
	});

	it("stamps the delivery state on a send", async () => {
		await ok("POST", `/link/${alpha}/children`, { id: idle });
		const sent = await send(alpha, idle, "for later", { kind: "note", deliveryWait: true });
		const stamp = sent.metadata?.[BUS_URI];
		check("BusMetadata", stamp, "SendMessage delivery stamp");
		expect(stamp).toEqual({ delivery: "queued" });
	});

	it("closes a child, replaces an older stream, acks, and goes offline", async () => {
		await ok("POST", `/link/${alpha}/control`, { target: kid, action: "close" });
		const control = await next(kidLink, "control");
		await stream(kid);
		await next(kidLink, "replaced");
		const acked = await ok("POST", `/link/${kid}/ack`, { upTo: control.id });
		expect(acked["acked"]).toBeGreaterThanOrEqual(1);
		await ok("DELETE", `/link/${kid}`);
		await next(alphaLink, "presence", (data) => data["agent"] === kid && data["online"] === false);
	});

	it("gives the listed error bodies", async () => {
		await fails(401, "GET", "/agents", { token: null });
		await fails(401, "GET", "/agents", { token: "wrong-token" });
		await fails(403, "GET", "/agents", { token: PEER_TOKEN });
		await fails(403, "POST", `/link/${alpha}/status`, { token: OTHER_HOST_TOKEN, body: { text: "x" } });
		await fails(400, "POST", `/link/${alpha}/ack`, { body: { upTo: -1 } });
		await fails(400, "POST", `/link/${alpha}/state`, { raw: "{" });
		await fails(404, "GET", "/agents/nobody");
		await fails(404, "POST", `/link/${beta}/tasks/no-such-task`, { body: { state: "completed" } });
		await fails(409, "POST", `/link/${alpha}/control`, { body: { target: idle, action: "close" } });
		expect(await fails(426, "POST", "/link/register", { body: { agent: alpha, protocol: 1 } })).toEqual({
			error: `hub protocol 2 or ${PROTOCOL} required`,
			expected: PROTOCOL,
			supported: [2, PROTOCOL],
		});
		expect(await fails(400, "POST", "/link/register", { body: { agent: "contract-new", protocol: PROTOCOL } })).toEqual(
			{
				error: `labels.harness is required with hub protocol ${PROTOCOL}`,
			},
		);
		await fails(413, "POST", `/link/${alpha}/status`, { raw: "x".repeat(BODY_LIMIT + 1) });

		for (const n of [1, 2]) {
			await send(
				alpha,
				beta,
				`twin ${n}`,
				{ kind: "note" },
				{ messageId: `twin-msg-${n}`, contextId: `twin-ctx-${n}` },
			);
		}
		const messages = await fails(409, "GET", `/link/${beta}/message/twin-msg-`);
		expect((messages["candidates"] as unknown[]).length).toBe(2);
		const threads = await fails(409, "GET", `/link/${beta}/thread/twin-ctx-`);
		expect((threads["candidates"] as unknown[]).length).toBe(2);
	});
});
