import { Message, SendMessageRequest, type StreamResponse, TaskState } from "@a2a-js/sdk";
import { A2AError, RequestMalformedError } from "@a2a-js/sdk/errors";
import { defaultServerCallContextBuilder } from "@a2a-js/sdk/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buildCard, HOLD_LIMIT, HoldLimiter, HubRequestHandler } from "./a2a.ts";
import { openDb } from "./db.ts";
import { type Caller, Engine } from "./engine.ts";
import { HUB_PROTOCOL } from "./protocol.ts";

const HERMES: Caller = { principal: { name: "hermes", kind: "peer" } };

function setup() {
	const lines: string[] = [];
	const engine = new Engine(openDb(":memory:"));
	engine.register({ name: "mars", kind: "host" }, { agent: "a1", protocol: HUB_PROTOCOL });
	const holds = new HoldLimiter();
	const handler = (signal?: AbortSignal, caller: Caller = HERMES) => {
		const agent = engine.requireAgent("a1");
		const input: ConstructorParameters<typeof HubRequestHandler>[0] = {
			engine,
			agent,
			caller,
			card: buildCard({ agent, baseUrl: "http://hub", version: "1" }),
			holds,
			log: (line) => lines.push(line),
		};
		if (signal) input.signal = signal;
		return new HubRequestHandler(input);
	};
	const taskIds = () =>
		(engine.db.prepare("SELECT id FROM tasks ORDER BY created_at, id").all() as { id: string }[]).map((row) => row.id);
	return { engine, holds, handler, taskIds, lines };
}

const context = () =>
	defaultServerCallContextBuilder({ extensions: [], user: undefined, headers: {}, requestedVersion: "1.0" });

function request(text: string, configuration: Record<string, unknown> = {}): SendMessageRequest {
	return SendMessageRequest.fromJSON({
		message: Message.toJSON(Message.fromJSON({ messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }] })),
		configuration,
	});
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function error(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (caught) {
		return caught;
	}
	throw new Error("expected a rejection");
}

afterEach(() => {
	vi.useRealTimers();
});

describe("a2a handler: waits", () => {
	it("frees the listener, the timer, and the hold when a blocking send is aborted", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const t = setup();
		const controller = new AbortController();
		const pending = t.handler(controller.signal).sendMessage(request("hold"), context());
		await flush();
		const [id] = t.taskIds();
		expect(t.engine.listenerCount(id ?? "")).toBe(1);
		expect(vi.getTimerCount()).toBe(1);
		expect(t.holds.count("hermes")).toBe(1);
		controller.abort();
		await pending;
		expect(t.engine.listenerCount(id ?? "")).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		expect(t.holds.count("hermes")).toBe(0);
	});

	it("frees the listener and the hold when a stream is aborted", async () => {
		const t = setup();
		const controller = new AbortController();
		const stream = t.handler(controller.signal).sendMessageStream(request("stream"), context());
		const first = await stream.next();
		expect((first.value as StreamResponse).payload?.$case).toBe("task");
		const [id] = t.taskIds();
		const second = stream.next();
		await flush();
		expect(t.engine.listenerCount(id ?? "")).toBe(1);
		expect(t.holds.count("hermes")).toBe(1);
		controller.abort();
		expect((await second).done).toBe(true);
		expect(t.engine.listenerCount(id ?? "")).toBe(0);
		expect(t.holds.count("hermes")).toBe(0);
	});

	it("ends a stream at AUTH_REQUIRED", async () => {
		const t = setup();
		const stream = t.handler().sendMessageStream(request("auth"), context());
		await stream.next();
		const [id] = t.taskIds();
		const rest = (async () => {
			const seen: string[] = [];
			for await (const event of stream) seen.push(event.payload?.$case ?? "");
			return seen;
		})();
		await flush();
		t.engine.applyChange(id ?? "", { state: "TASK_STATE_AUTH_REQUIRED" });
		expect(await rest).toEqual(["statusUpdate"]);
		expect(t.engine.listenerCount(id ?? "")).toBe(0);
	});

	it("refuses a hold above the limit per principal with an internal error", async () => {
		const t = setup();
		const controller = new AbortController();
		const holds = Array.from({ length: HOLD_LIMIT }, () =>
			t.handler(controller.signal).sendMessage(request("hold"), context()),
		);
		await flush();
		expect(t.holds.count("hermes")).toBe(HOLD_LIMIT);
		const refused = await error(t.handler().sendMessage(request("one more"), context()));
		expect(refused).toBeInstanceOf(A2AError);
		expect((refused as Error).message).toMatch(/limit/);
		expect(t.taskIds()).toHaveLength(HOLD_LIMIT);
		const host: Caller = { principal: { name: "mars", kind: "host" } };
		const other = await t.handler(undefined, host).sendMessage(request("x", { returnImmediately: true }), context());
		expect(other).toBeDefined();
		controller.abort();
		await Promise.all(holds);
		expect(t.holds.count("hermes")).toBe(0);
	});
});

describe("a2a handler: errors", () => {
	it("refuses a negative historyLength", async () => {
		const t = setup();
		const sent = await t.handler().sendMessage(request("x", { returnImmediately: true }), context());
		const id = t.taskIds()[0] ?? "";
		expect(sent).toBeDefined();
		const handler = t.handler();
		expect(await error(handler.getTask({ id, historyLength: -5 } as never))).toBeInstanceOf(RequestMalformedError);
		expect(await error(handler.listTasks({ pageSize: 10, historyLength: -1 } as never))).toBeInstanceOf(
			RequestMalformedError,
		);
		expect(
			await error(handler.sendMessage(request("y", { historyLength: -2, returnImmediately: true }), context())),
		).toBeInstanceOf(RequestMalformedError);
		expect(t.taskIds()).toHaveLength(1);
		expect((await handler.getTask({ id, historyLength: 0 } as never)).status?.state).toBe(
			TaskState.TASK_STATE_SUBMITTED,
		);
	});

	it("logs an unexpected error and sends only a generic message", async () => {
		const t = setup();
		t.engine.db.exec("DROP TABLE task_messages");
		const caught = await error(t.handler().sendMessage(request("x", { returnImmediately: true }), context()));
		expect(caught).toBeInstanceOf(A2AError);
		expect((caught as Error).message).toBe("internal error");
		expect(t.lines.join("\n")).toMatch(/task_messages/);
	});
});
