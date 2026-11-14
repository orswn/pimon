import { describe, expect, it } from "vite-plus/test";
import { ANONYMOUS, type Principal } from "./auth.ts";
import { openDb } from "./db.ts";
import { type Caller, defaultAgentName, Engine, HubError, type WireMessage } from "./engine.ts";
import { BUS_EXTENSION_URI, HUB_PROTOCOL, type LinkEvent } from "./protocol.ts";

const MARS: Principal = { name: "mars", kind: "host" };
const VENUS: Principal = { name: "venus", kind: "host" };
const HERMES: Principal = { name: "hermes", kind: "peer" };

function setup(start = Date.parse("2026-01-01T00:00:00Z")) {
	let clock = start;
	let counter = 0;
	const engine = new Engine(openDb(":memory:"), {
		now: () => clock,
		newId: () => `id-${String(++counter).padStart(4, "0")}`,
	});
	const events: { agent: string; event: LinkEvent }[] = [];
	engine.onLink((agent, event) => events.push({ agent, event }));
	return {
		engine,
		events,
		advance(ms: number) {
			clock += ms;
		},
		register(agent: string, extra: Record<string, unknown> = {}, principal: Principal = MARS) {
			return engine.register(principal, { agent, protocol: HUB_PROTOCOL, ...extra });
		},
	};
}

function message(text: string, extra: Partial<WireMessage> = {}, meta?: Record<string, unknown>): WireMessage {
	const msg: WireMessage = { messageId: `m-${text}`, role: "ROLE_USER", parts: [{ text }], ...extra };
	if (meta) msg.metadata = { [BUS_EXTENSION_URI]: meta };
	return msg;
}

function reason(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error) {
		if (error instanceof HubError) return error.reason;
		throw error;
	}
	return undefined;
}

const fromHermes: Caller = { principal: HERMES };

describe("engine: register and host binding", () => {
	it("binds an agent to the first host and refuses another host", () => {
		const t = setup();
		expect(t.register("a1", { name: "worker" })).toEqual({ agent: "a1", name: "worker", host: "mars" });
		expect(reason(() => t.register("a1", {}, VENUS))).toBe("forbidden");
		expect(t.register("a1", { name: "renamed" }).name).toBe("renamed");
	});

	it("refuses a peer principal and a wrong protocol", () => {
		const t = setup();
		expect(reason(() => t.register("a1", {}, HERMES))).toBe("forbidden");
		expect(reason(() => t.engine.register(MARS, { agent: "a1", protocol: 1 }))).toBe("upgrade");
	});

	it("derives the default name from the host and a hash of the id", () => {
		const t = setup();
		const result = t.register("agent-xyz");
		expect(result.name).toBe(defaultAgentName("mars", "agent-xyz"));
		expect(result.name).toMatch(/^mars-[0-9a-f]{6}$/);
	});

	it("allows a host to act only for its own agents", () => {
		const t = setup();
		t.register("a1");
		expect(t.engine.requireOwnAgent(MARS, "a1").id).toBe("a1");
		expect(reason(() => t.engine.requireOwnAgent(VENUS, "a1"))).toBe("forbidden");
		expect(reason(() => t.engine.requireOwnAgent(HERMES, "a1"))).toBe("forbidden");
		expect(reason(() => t.engine.requireOwnAgent(MARS, "nope"))).toBe("forbidden");
	});
});

describe("engine: alias resolution", () => {
	it("resolves ids, built-in names, and the one online pi agent", () => {
		const t = setup();
		t.engine.ensureBuiltin("tck", "tck");
		t.register("a1", { name: "worker" });
		expect(t.engine.resolveRef("@worker")).toBeUndefined();
		t.engine.setOnline("a1", true);
		expect(t.engine.resolveRef("@worker")).toMatchObject({ agent: { id: "a1" } });
		expect(t.engine.resolveRef("@tck")).toMatchObject({ agent: { id: "tck" } });
		expect(t.engine.resolveRef("a1")).toMatchObject({ agent: { id: "a1" } });
		expect(t.engine.resolveRef("missing")).toBeUndefined();
	});

	it("prefers a built-in agent over a pi agent with the same name", () => {
		const t = setup();
		t.register("a1", { name: "echo" });
		t.engine.setOnline("a1", true);
		t.engine.ensureBuiltin("echo", "echo");
		expect(t.engine.resolveRef("@echo")).toMatchObject({ agent: { id: "echo" } });
	});

	it("reports every online match when two pi agents share a name", () => {
		const t = setup();
		t.register("a1", { name: "worker" });
		t.register("a2", { name: "worker" });
		t.engine.setOnline("a1", true);
		t.advance(10);
		t.engine.setOnline("a2", true);
		expect(t.engine.resolveRef("@worker")).toEqual({ ambiguous: ["a2", "a1"] });
		t.engine.setOnline("a2", false);
		expect(t.engine.resolveRef("@worker")).toMatchObject({ agent: { id: "a1" } });
	});
});

describe("engine: task lifecycle", () => {
	it("creates a SUBMITTED task with the message as history and a link event", () => {
		const t = setup();
		t.register("a1");
		const result = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("hi") });
		expect(result.created).toBe(true);
		expect(result.task?.status.state).toBe("TASK_STATE_SUBMITTED");
		expect(result.task?.history?.map((m) => m.messageId)).toEqual(["m-hi"]);
		expect(result.task?.contextId).toBeTruthy();
		const event = t.events.find((e) => e.event.type === "message");
		expect(event?.agent).toBe("a1");
		expect(event?.event.payload).toMatchObject({
			messageId: "m-hi",
			taskId: result.task?.id,
			kind: "task",
			wake: "now",
			text: "hi",
			taskState: "submitted",
			from: { name: "hermes", kind: "peer" },
		});
		expect(t.engine.inbox("a1", true, 10).map((item) => item.messageId)).toEqual(["m-hi"]);
	});

	it("stores a note without a task and returns a stored message", () => {
		const t = setup();
		t.register("a1");
		const result = t.engine.send({
			agentId: "a1",
			caller: fromHermes,
			message: message("fyi", { contextId: "ctx" }, { kind: "note", wake: "never" }),
		});
		expect(result.task).toBeUndefined();
		expect(result.message).toMatchObject({ role: "ROLE_AGENT", contextId: "ctx", parts: [{ text: "stored" }] });
		expect(t.events[0]?.event.payload).toMatchObject({ kind: "note", wake: "never", contextId: "ctx" });
	});

	it("moves through working and input-required to completed and stays final", () => {
		const t = setup();
		t.register("a1");
		const id = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("go") }).task?.id ?? "";
		const states: string[] = [];
		t.engine.onTask(id, (event) => states.push(event.state));
		t.engine.linkUpdate("a1", id, { state: "working" });
		t.engine.linkUpdate("a1", id, { state: "input-required", text: "which file?" });
		const followUp = t.engine.send({
			agentId: "a1",
			caller: fromHermes,
			message: message("main.ts", { taskId: id }),
		});
		expect(followUp.task?.status.state).toBe("TASK_STATE_WORKING");
		const done = t.engine.linkUpdate("a1", id, {
			state: "completed",
			text: "done",
			artifact: { name: "out", text: "x" },
		});
		expect(done.status.state).toBe("TASK_STATE_COMPLETED");
		expect(done.status.message?.parts).toEqual([{ text: "done" }]);
		expect(done.artifacts?.[0]).toMatchObject({ name: "out", parts: [{ text: "x" }] });
		expect(done.history?.map((m) => m.role)).toEqual(["ROLE_USER", "ROLE_AGENT", "ROLE_USER", "ROLE_AGENT"]);
		expect(states).toEqual([
			"TASK_STATE_WORKING",
			"TASK_STATE_INPUT_REQUIRED",
			"TASK_STATE_WORKING",
			// the artifact update comes before the final status update
			"TASK_STATE_WORKING",
			"TASK_STATE_COMPLETED",
		]);
		expect(reason(() => t.engine.linkUpdate("a1", id, { state: "working" }))).toBe("task-terminal");
		expect(reason(() => t.engine.cancel("a1", fromHermes, id))).toBe("not-cancelable");
		expect(
			reason(() => t.engine.send({ agentId: "a1", caller: fromHermes, message: message("more", { taskId: id }) })),
		).toBe("task-terminal");
	});

	it("rejects failed and rejected as final states too", () => {
		const t = setup();
		t.register("a1");
		for (const state of ["failed", "rejected"] as const) {
			const id = t.engine.send({ agentId: "a1", caller: fromHermes, message: message(state) }).task?.id ?? "";
			expect(t.engine.linkUpdate("a1", id, { state }).status.state).toBe(
				state === "failed" ? "TASK_STATE_FAILED" : "TASK_STATE_REJECTED",
			);
			expect(reason(() => t.engine.linkUpdate("a1", id, { state: "working" }))).toBe("task-terminal");
		}
	});

	it("checks follow-up rules: unknown task, other agent, and context mismatch", () => {
		const t = setup();
		t.register("a1");
		t.register("a2");
		const task = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("go") }).task;
		const id = task?.id ?? "";
		const send = (agentId: string, extra: Partial<WireMessage>) =>
			reason(() => t.engine.send({ agentId, caller: fromHermes, message: message("x", extra) }));
		expect(send("a1", { taskId: "missing" })).toBe("task-not-found");
		expect(send("a2", { taskId: id })).toBe("task-not-found");
		expect(send("a1", { taskId: id, contextId: "other" })).toBe("invalid");
		expect(send("a1", { taskId: id, contextId: task?.contextId ?? "" })).toBeUndefined();
	});

	it("does not change state on a follow-up to a WORKING task", () => {
		const t = setup();
		t.register("a1");
		const id = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("go") }).task?.id ?? "";
		t.engine.linkUpdate("a1", id, { state: "working" });
		const states: string[] = [];
		t.engine.onTask(id, (event) => states.push(event.state));
		const result = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("also", { taskId: id }) });
		expect(result.task?.status.state).toBe("TASK_STATE_WORKING");
		expect(result.task?.history).toHaveLength(2);
		expect(states).toEqual([]);
	});

	it("cancels a task, tells the recipient and the sender agent, and refuses a second cancel", () => {
		const t = setup();
		t.register("a1");
		t.register("sender");
		const caller: Caller = { principal: MARS, agent: "sender" };
		const id = t.engine.send({ agentId: "a1", caller, message: message("go") }).task?.id ?? "";
		const canceled = t.engine.cancel("a1", caller, id);
		expect(canceled.status.state).toBe("TASK_STATE_CANCELED");
		expect(t.events.filter((e) => e.event.type === "cancel")).toEqual([
			{ agent: "a1", event: expect.objectContaining({ payload: { taskId: id } }) },
		]);
		expect(t.events.find((e) => e.event.type === "update")).toMatchObject({
			agent: "sender",
			event: { payload: { taskId: id, state: "canceled", from: { agent: "a1" } } },
		});
		expect(reason(() => t.engine.cancel("a1", caller, id))).toBe("not-cancelable");
	});

	it("sends an update link event to the sender agent on each change", () => {
		const t = setup();
		t.register("a1", { name: "worker" });
		t.register("sender");
		const caller: Caller = { principal: MARS, agent: "sender" };
		const id = t.engine.send({ agentId: "a1", caller, message: message("go") }).task?.id ?? "";
		t.engine.linkUpdate("a1", id, { state: "completed", text: "ok", artifact: { name: "r", text: "body" } });
		expect(t.events.find((e) => e.agent === "sender")?.event.payload).toEqual({
			taskId: id,
			contextId: expect.any(String),
			state: "completed",
			messageId: expect.any(String),
			kind: "result",
			text: "ok",
			artifacts: [{ name: "r", text: "body" }],
			from: { agent: "a1", name: "worker" },
		});
	});

	it("keeps the event and the rows unchanged when a change fails in the middle", () => {
		const t = setup();
		t.register("a1");
		const id = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("go") }).task?.id ?? "";
		const before = t.events.length;
		expect(
			reason(() =>
				t.engine.applyChange(id, {
					state: "TASK_STATE_WORKING",
					artifacts: [{ artifact: { artifactId: "", parts: [] } }],
				}),
			),
		).toBe("invalid");
		expect(t.engine.readTask(id)?.status.state).toBe("TASK_STATE_SUBMITTED");
		expect(t.events.length).toBe(before);
	});
});

describe("engine: context-level follow-ups", () => {
	const asker: Caller = { principal: MARS, agent: "asker" };
	const ask = (t: ReturnType<typeof setup>, agentId: string, caller: Caller, text: string, contextId = "ctx-1") =>
		t.engine.send({ agentId, caller, message: message(text, { contextId }) });

	it("continues the one interrupted task when a peer sends again in its context", () => {
		const t = setup();
		t.register("a1");
		const id = ask(t, "a1", fromHermes, "plan").task?.id ?? "";
		t.engine.linkUpdate("a1", id, { state: "input-required", text: "which day?" });
		const next = ask(t, "a1", fromHermes, "monday");
		expect(next.created).toBe(false);
		expect(next.task?.id).toBe(id);
		expect(next.task?.status.state).toBe("TASK_STATE_WORKING");
		expect(next.task?.history?.map((m) => m.messageId)).toEqual(["m-plan", expect.any(String), "m-monday"]);
		expect(t.events.at(-1)?.event.payload).toMatchObject({ taskId: id, messageId: "m-monday", taskState: "working" });
	});

	it("starts a new task when the context has two interrupted tasks, none, or another sender", () => {
		const t = setup();
		t.register("a1");
		const first = ask(t, "a1", fromHermes, "one").task?.id ?? "";
		const second = ask(t, "a1", fromHermes, "two").task?.id ?? "";
		t.engine.linkUpdate("a1", first, { state: "input-required", text: "?" });
		t.engine.linkUpdate("a1", second, { state: "input-required", text: "?" });
		const third = ask(t, "a1", fromHermes, "three");
		expect(third.created).toBe(true);
		expect([first, second]).not.toContain(third.task?.id);
		expect(ask(t, "a1", fromHermes, "other context", "ctx-2").created).toBe(true);
		const other: Caller = { principal: { name: "athena", kind: "peer" } };
		t.engine.linkUpdate("a1", second, { state: "completed" });
		expect(ask(t, "a1", other, "four").created).toBe(true);
		expect(t.engine.readTask(first)?.history).toHaveLength(2);
	});

	it("keeps pi-to-pi traffic on explicit task ids", () => {
		const t = setup();
		t.register("asker");
		t.register("helper");
		const id = ask(t, "helper", asker, "go").task?.id ?? "";
		t.engine.linkUpdate("helper", id, { state: "input-required", text: "which?" });
		const next = ask(t, "helper", asker, "that");
		expect(next.created).toBe(true);
		expect(next.task?.id).not.toBe(id);
		expect(t.engine.readTask(id)?.status.state).toBe("TASK_STATE_INPUT_REQUIRED");
	});

	it("continues the interrupted task of an external agent when its pi sender writes in the context", () => {
		const t = setup();
		t.register("asker");
		t.register("asker-2");
		t.engine.ensureExternal("hermes", "hermes");
		const id = ask(t, "hermes", asker, "research").task?.id ?? "";
		t.engine.applyChange(id, { state: "TASK_STATE_INPUT_REQUIRED", message: t.engine.agentMessage("which topic?") });
		expect(ask(t, "hermes", { principal: MARS, agent: "asker-2" }, "mine").created).toBe(true);
		const next = ask(t, "hermes", asker, "A2A");
		expect(next.created).toBe(false);
		expect(next.task?.id).toBe(id);
		expect(next.task?.status.state).toBe("TASK_STATE_WORKING");
	});

	it("queues a send for each task message and swaps a waiting send for a cancel", () => {
		const t = setup();
		t.register("asker", { name: "bee" });
		t.engine.ensureExternal("hermes", "Hermes");
		let kicks = 0;
		t.engine.onExternal(() => kicks++);
		const first = ask(t, "hermes", asker, "research").task;
		const id = first?.id ?? "";
		expect(kicks).toBe(1);
		expect(t.engine.externalJobs()).toMatchObject([{ agentId: "hermes", taskId: id, op: "send" }]);
		const remote = t.engine.startRemote(t.engine.externalJobs()[0]!);
		expect(t.engine.externalJobs()).toEqual([]);
		expect(t.engine.remoteBusy("hermes", first?.contextId ?? "")).toBe(true);
		t.engine.remoteDone(remote);
		t.engine.applyChange(id, { state: "TASK_STATE_INPUT_REQUIRED", message: t.engine.agentMessage("which?") });
		const inbox = t.engine.inbox("asker", true, 10)[0];
		expect(inbox?.from).toEqual({ agent: "hermes", name: "Hermes", kind: "external" });
		const next = ask(t, "hermes", asker, "A2A");
		expect(next.task?.id).toBe(id);
		const [job] = t.engine.externalJobs();
		expect(job).toMatchObject({ taskId: id, op: "send" });
		expect(t.engine.outboundMessage(id, job?.messageId ?? "")).toEqual({
			text: "A2A",
			contextId: first?.contextId,
			senderName: "bee",
			senderHost: "mars",
		});
		t.engine.cancel("hermes", asker, id);
		expect(t.engine.externalJobs()).toMatchObject([{ taskId: id, op: "cancel" }]);
	});

	it("refuses a message to an external agent that makes no task", () => {
		const t = setup();
		t.register("asker");
		t.engine.ensureExternal("hermes", "hermes");
		const note = () =>
			t.engine.send({
				agentId: "hermes",
				caller: asker,
				message: message("fyi", { contextId: "ctx-1" }, { kind: "note" }),
			});
		expect(note).toThrow("external agents take only task, question, or correction messages");
		expect(reason(note)).toBe("invalid");
		expect(t.engine.inbox("hermes", false, 10)).toEqual([]);
		for (const kind of ["question", "correction"]) {
			const sent = t.engine.send({
				agentId: "hermes",
				caller: asker,
				message: message(kind, { contextId: `ctx-${kind}` }, { kind }),
			});
			expect(sent.created).toBe(true);
		}
	});

	it("refuses a follow-up to an external task that does not wait for input", () => {
		const t = setup();
		t.register("asker");
		t.engine.ensureExternal("hermes", "hermes");
		const id = ask(t, "hermes", asker, "research").task?.id ?? "";
		const follow = (text: string) => () =>
			t.engine.send({ agentId: "hermes", caller: asker, message: message(text, { taskId: id }) });
		expect(follow("queued")).toThrow(
			`Task ${id} of external agent hermes takes a follow-up only when it waits for input`,
		);
		t.engine.applyChange(id, { state: "TASK_STATE_WORKING" });
		expect(reason(follow("running"))).toBe("invalid");
		expect(t.engine.externalJobs()).toHaveLength(1);
		t.engine.applyChange(id, { state: "TASK_STATE_AUTH_REQUIRED", message: t.engine.agentMessage("login") });
		expect(follow("done")().task?.id).toBe(id);
		expect(t.engine.externalJobs()).toHaveLength(2);
	});

	it("leaves anonymous callers and built-in agents on explicit task ids", () => {
		const t = setup();
		t.engine.ensureBuiltin("tck", "tck");
		t.register("a1");
		const anonymous: Caller = { principal: ANONYMOUS };
		const first = ask(t, "a1", anonymous, "plan").task?.id ?? "";
		t.engine.linkUpdate("a1", first, { state: "input-required", text: "which?" });
		expect(ask(t, "a1", anonymous, "other").created).toBe(true);
		const builtin = ask(t, "tck", fromHermes, "plan", "ctx-2").task?.id ?? "";
		t.engine.applyChange(builtin, { state: "TASK_STATE_INPUT_REQUIRED", message: t.engine.agentMessage("which?") });
		expect(ask(t, "tck", fromHermes, "other", "ctx-2").created).toBe(true);
	});

	it("keeps a pi id out of the external rows", () => {
		const t = setup();
		t.register("asker");
		expect(() => t.engine.ensureExternal("asker", "x")).toThrow(HubError);
		expect(t.engine.externalJobs()).toEqual([]);
		ask(t, "asker", { principal: MARS, agent: "asker" }, "self");
		expect(t.engine.externalJobs()).toEqual([]);
	});
});

describe("engine: status text", () => {
	it("puts the status text on every WORKING task without history growth", () => {
		const t = setup();
		t.register("a1");
		const working = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("w") }).task?.id ?? "";
		const submitted = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("s") }).task?.id ?? "";
		t.engine.linkUpdate("a1", working, { state: "working" });
		const updates: unknown[] = [];
		t.engine.onTask(working, (event) => updates.push(event.response));
		t.advance(1000);
		expect(t.engine.setStatus("a1", "  reading\n files  ")).toBe("reading files");
		const task = t.engine.readTask(working);
		expect(task?.status.message).toMatchObject({
			role: "ROLE_AGENT",
			parts: [{ text: "reading files" }],
			metadata: { [BUS_EXTENSION_URI]: { statusText: true } },
		});
		expect(task?.status.timestamp).toBe("2026-01-01T00:00:01.000Z");
		expect(task?.history).toHaveLength(1);
		expect(updates).toHaveLength(1);
		expect(t.engine.readTask(submitted)?.status.message).toBeUndefined();
		t.engine.setStatus("a1", "");
		expect(t.engine.readTask(working)?.status.message).toBeUndefined();
	});

	it("limits the text to 160 chars and emits nothing when it does not change", () => {
		const t = setup();
		t.register("a1");
		expect(t.engine.setStatus("a1", "x".repeat(300))).toHaveLength(160);
		const id = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("go") }).task?.id ?? "";
		t.engine.linkUpdate("a1", id, { state: "working" });
		const updates: unknown[] = [];
		t.engine.onTask(id, (event) => updates.push(event));
		t.engine.setStatus("a1", "x".repeat(200));
		expect(updates).toEqual([]);
	});

	it("sets the status text when a task enters WORKING", () => {
		const t = setup();
		t.register("a1");
		t.engine.setStatus("a1", "busy compiling");
		const id = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("go") }).task?.id ?? "";
		const task = t.engine.linkUpdate("a1", id, { state: "working" });
		expect(task.status.message?.parts).toEqual([{ text: "busy compiling" }]);
		expect(task.history).toHaveLength(1);
	});
});

describe("engine: expect_reply", () => {
	it("settles an open question when the reply with replyTo arrives", () => {
		const t = setup();
		t.register("asker");
		t.register("helper");
		const asker: Caller = { principal: MARS, agent: "asker" };
		const helper: Caller = { principal: MARS, agent: "helper" };
		const sent = t.engine.send({
			agentId: "helper",
			caller: asker,
			message: message("ping", {}, { kind: "note", expectReply: true }),
		});
		expect(t.engine.pending("asker").expectReply.map((row) => row.messageId)).toEqual(["m-ping"]);
		t.engine.send({
			agentId: "asker",
			caller: helper,
			message: message("pong", { contextId: sent.message?.contextId ?? "" }, { kind: "answer", replyTo: "m-ping" }),
		});
		expect(t.engine.pending("asker").expectReply).toEqual([]);
	});

	it("settles a task question on INPUT_REQUIRED or a final state", () => {
		const t = setup();
		t.register("asker");
		t.register("helper");
		const asker: Caller = { principal: MARS, agent: "asker" };
		const id =
			t.engine.send({ agentId: "helper", caller: asker, message: message("q", {}, { expectReply: true }) }).task?.id ??
			"";
		expect(t.engine.pending("asker")).toMatchObject({
			expectReply: [{ messageId: "m-q", taskId: id }],
			tasks: [{ taskId: id, agent: "helper", state: "submitted" }],
		});
		t.engine.linkUpdate("helper", id, { state: "working" });
		expect(t.engine.pending("asker").expectReply).toHaveLength(1);
		t.engine.linkUpdate("helper", id, { state: "input-required", text: "?" });
		expect(t.engine.pending("asker").expectReply).toEqual([]);
		expect(t.engine.pending("asker").tasks).toHaveLength(1);
		t.engine.send({ agentId: "helper", caller: asker, message: message("a", { taskId: id }) });
		t.engine.linkUpdate("helper", id, { state: "completed" });
		expect(t.engine.pending("asker").tasks).toEqual([]);
	});
});

describe("engine: scope", () => {
	it("shows a task to its sender principal and to the host of the agent only", () => {
		const t = setup();
		t.register("a1");
		const other: Caller = { principal: { name: "other", kind: "peer" } };
		const id = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("go") }).task?.id ?? "";
		expect(t.engine.getTask("a1", fromHermes, id).id).toBe(id);
		expect(t.engine.getTask("a1", { principal: MARS }, id).id).toBe(id);
		expect(reason(() => t.engine.getTask("a1", other, id))).toBe("task-not-found");
		expect(reason(() => t.engine.getTask("a1", { principal: VENUS }, id))).toBe("task-not-found");
		const list = (caller: Caller) =>
			t.engine.listTasks("a1", caller, { pageSize: 10, includeArtifacts: false }).tasks.map((task) => task.id);
		expect(list(fromHermes)).toEqual([id]);
		expect(list(other)).toEqual([]);
	});

	it("limits a caller with an agent header to tasks that agent sent or received", () => {
		const t = setup();
		t.register("a1");
		t.register("s1");
		t.register("s2");
		const s1: Caller = { principal: MARS, agent: "s1" };
		const s2: Caller = { principal: MARS, agent: "s2" };
		const id = t.engine.send({ agentId: "a1", caller: s1, message: message("go") }).task?.id ?? "";
		expect(t.engine.getTask("a1", s1, id).id).toBe(id);
		expect(t.engine.getTask("a1", { principal: MARS, agent: "a1" }, id).id).toBe(id);
		expect(reason(() => t.engine.getTask("a1", s2, id))).toBe("task-not-found");
	});

	it("limits each agent route to the tasks of that agent", () => {
		const t = setup();
		t.register("a1");
		t.register("a2");
		const id = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("go") }).task?.id ?? "";
		expect(reason(() => t.engine.getTask("a2", fromHermes, id))).toBe("task-not-found");
		expect(t.engine.listTasks("a2", fromHermes, { pageSize: 10, includeArtifacts: false }).tasks).toEqual([]);
	});
});

describe("engine: list tasks", () => {
	it("pages by status timestamp descending and filters", () => {
		const t = setup();
		t.register("a1");
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			t.advance(1000);
			ids.push(
				t.engine.send({ agentId: "a1", caller: fromHermes, message: message(`t${i}`, { contextId: `c${i % 2}` }) }).task
					?.id ?? "",
			);
		}
		const first = t.engine.listTasks("a1", fromHermes, { pageSize: 2, includeArtifacts: false });
		expect(first.tasks.map((task) => task.id)).toEqual([ids[4], ids[3]]);
		expect(first.totalSize).toBe(5);
		expect(first.tasks[0]?.artifacts).toBeUndefined();
		const second = t.engine.listTasks("a1", fromHermes, {
			pageSize: 2,
			pageToken: first.nextPageToken,
			includeArtifacts: false,
		});
		expect(second.tasks.map((task) => task.id)).toEqual([ids[2], ids[1]]);
		const last = t.engine.listTasks("a1", fromHermes, {
			pageSize: 2,
			pageToken: second.nextPageToken,
			includeArtifacts: false,
		});
		expect(last.tasks.map((task) => task.id)).toEqual([ids[0]]);
		expect(last.nextPageToken).toBe("");
		expect(
			t.engine
				.listTasks("a1", fromHermes, { pageSize: 10, contextId: "c1", includeArtifacts: true })
				.tasks.map((task) => task.id),
		).toEqual([ids[3], ids[1]]);
		const one = t.engine.listTasks("a1", fromHermes, { pageSize: 1, historyLength: 0, includeArtifacts: true });
		expect(one.tasks[0]?.history).toBeUndefined();
		expect(
			reason(() => t.engine.listTasks("a1", fromHermes, { pageSize: 1, pageToken: "bad", includeArtifacts: false })),
		).toBe("invalid");
	});
});

describe("engine: link mailbox", () => {
	it("keeps events until acked and sends presence to the parent and children", () => {
		const t = setup();
		t.register("parent");
		t.register("child", { parent: "parent", name: "kid" });
		t.engine.setOnline("child", true);
		expect(t.engine.unacked("parent").map((event) => event.payload)).toEqual([
			{ agent: "child", name: "kid", online: true, relation: "child" },
		]);
		t.engine.setOnline("parent", true);
		expect(t.engine.unacked("child").map((event) => event.type)).toEqual(["presence"]);
		const seq = t.engine.unacked("parent")[0]?.seq ?? 0;
		t.engine.ack("parent", seq);
		expect(t.engine.unacked("parent")).toEqual([]);
		t.engine.setOnline("child", true);
		expect(t.engine.unacked("parent")).toEqual([]);
	});

	it("allows control close only from the parent", () => {
		const t = setup();
		t.register("parent");
		t.register("child", { parent: "parent" });
		t.register("stranger");
		expect(reason(() => t.engine.control("stranger", "child", "close"))).toBe("forbidden");
		expect(reason(() => t.engine.control("parent", "child", "close"))).toBe("conflict");
		t.engine.setOnline("child", true);
		t.engine.control("parent", "child", "close");
		expect(t.engine.unacked("child").map((event) => event.type)).toEqual(["control"]);
	});

	it("replays only unacked events after a given seq", () => {
		const t = setup();
		t.register("child");
		for (const text of ["one", "two", "three"]) {
			t.engine.send({ agentId: "child", caller: fromHermes, message: message(text, {}, { kind: "note" }) });
		}
		const [first, second] = t.engine.unacked("child");
		t.engine.ack("child", first?.seq);
		const texts = (events: { payload: unknown }[]) => events.map((event) => (event.payload as { text: string }).text);
		expect(texts(t.engine.replay("child", second?.seq))).toEqual(["three"]);
		expect(texts(t.engine.replay("child"))).toEqual(["two", "three"]);
		expect(texts(t.engine.replay("child", 0))).toEqual(["two", "three"]);
	});

	it("acks and skips control events older than 30 s on replay", () => {
		const t = setup();
		t.register("parent");
		t.register("child", { parent: "parent" });
		t.engine.setOnline("child", true);
		t.engine.control("parent", "child", "close");
		t.engine.send({ agentId: "child", caller: fromHermes, message: message("keep", {}, { kind: "note" }) });
		t.advance(10_000);
		expect(t.engine.replay("child").map((event) => event.type)).toEqual(["control", "message"]);
		t.advance(25_000);
		expect(t.engine.replay("child").map((event) => event.type)).toEqual(["message"]);
		expect(t.engine.unacked("child").map((event) => event.type)).toEqual(["message"]);
	});

	it("finds a message by prefix and reports an ambiguous prefix", () => {
		const t = setup();
		t.register("a1");
		t.register("a2");
		t.engine.send({
			agentId: "a1",
			caller: fromHermes,
			message: message("x", { messageId: "abc-1" }, { kind: "note" }),
		});
		t.engine.send({
			agentId: "a1",
			caller: fromHermes,
			message: message("y", { messageId: "abc-2" }, { kind: "note" }),
		});
		t.engine.send({
			agentId: "a2",
			caller: fromHermes,
			message: message("z", { messageId: "abc-3" }, { kind: "note" }),
		});
		expect(t.engine.message("a1", "abc-1")).toMatchObject({ messageId: "abc-1", text: "x", direction: "in" });
		try {
			t.engine.message("a1", "abc");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(HubError);
			expect((error as HubError).status).toBe(409);
			expect((error as HubError).details?.["candidates"]).toHaveLength(2);
		}
		expect(reason(() => t.engine.message("a1", "zzz"))).toBe("not-found");
		expect(t.engine.markRead("a1", ["abc-1"])).toBe(1);
		expect(t.engine.inbox("a1", true, 10).map((item) => item.messageId)).toEqual(["abc-2"]);
	});

	it("keeps one inbox row per recipient when a fan-out reuses a messageId", () => {
		const t = setup();
		t.register("a1");
		t.register("a2");
		for (const agentId of ["a1", "a2"]) {
			t.engine.send({ agentId, caller: fromHermes, message: message("same", { messageId: "fan" }, { kind: "note" }) });
		}
		expect(t.engine.inbox("a1", false, 10)).toHaveLength(1);
		expect(t.engine.inbox("a2", false, 10)).toHaveLength(1);
	});
});

describe("engine: retention sweep", () => {
	it("deletes old final tasks, messages, acked events, settled rows, and stale ephemeral agents", () => {
		const t = setup();
		t.register("a1");
		t.register("eph", { ephemeral: true });
		t.engine.setOnline("eph", true);
		const done = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("old") }).task?.id ?? "";
		const open = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("open") }).task?.id ?? "";
		t.engine.linkUpdate("a1", done, { state: "completed" });
		t.engine.ack("a1", 1_000_000);
		t.engine.send({ agentId: "eph", caller: fromHermes, message: message("queued", {}, { kind: "note" }) });
		t.engine.setOnline("eph", false);
		t.advance(25 * 60 * 60 * 1000);
		expect(t.engine.sweep()).toMatchObject({ agents: 1, tasks: 0 });
		expect(t.engine.agent("eph")).toBeUndefined();
		expect(t.engine.unacked("eph")).toEqual([]);
		t.advance(30 * 24 * 60 * 60 * 1000);
		const result = t.engine.sweep();
		expect(result.tasks).toBe(1);
		expect(result.messages).toBeGreaterThanOrEqual(2);
		expect(result.events).toBeGreaterThanOrEqual(1);
		expect(t.engine.readTask(done)).toBeUndefined();
		expect(t.engine.readTask(open)).toBeDefined();
	});

	it("removes every row of a swept agent, so a new owner of the id sees nothing", () => {
		const t = setup();
		t.register("peer-of-eph");
		t.register("eph", { ephemeral: true });
		const toEph = t.engine.send({ agentId: "eph", caller: fromHermes, message: message("secret for mars") }).task?.id;
		const fromEph = t.engine.send({
			agentId: "peer-of-eph",
			caller: { principal: MARS, agent: "eph" },
			message: message("question", {}, { kind: "task", expectReply: true }),
		}).task?.id;
		t.engine.setOnline("eph", true);
		t.engine.setOnline("eph", false);
		t.advance(2 * 24 * 60 * 60 * 1000);
		expect(t.engine.sweep()).toMatchObject({ agents: 1, tasks: 2 });
		t.register("eph", {}, VENUS);
		const venus: Caller = { principal: VENUS, agent: "eph" };
		expect(t.engine.inbox("eph", false, 10)).toEqual([]);
		expect(reason(() => t.engine.getTask("eph", { principal: VENUS }, toEph ?? ""))).toBe("task-not-found");
		expect(reason(() => t.engine.getTask("peer-of-eph", venus, fromEph ?? ""))).toBe("task-not-found");
		expect(t.engine.pending("eph")).toEqual({ expectReply: [], tasks: [] });
		expect(t.engine.owed("peer-of-eph")).toEqual({ expectReply: [], tasks: [] });
		expect(reason(() => t.engine.thread("eph", "id-"))).toBe("not-found");
		expect(t.engine.unacked("eph")).toEqual([]);
	});

	it("removes a non-ephemeral agent after 90 days offline", () => {
		const t = setup();
		t.register("old");
		t.register("recent");
		t.engine.send({ agentId: "old", caller: fromHermes, message: message("pending work") });
		t.engine.setOnline("old", true);
		t.engine.setOnline("old", false);
		t.advance(89 * 24 * 60 * 60 * 1000);
		t.engine.setOnline("recent", true);
		t.engine.setOnline("recent", false);
		expect(t.engine.sweep().agents).toBe(0);
		t.advance(2 * 24 * 60 * 60 * 1000);
		expect(t.engine.sweep()).toMatchObject({ agents: 1, tasks: 1 });
		expect(t.engine.agent("old")).toBeUndefined();
		expect(t.engine.agent("recent")).toBeDefined();
	});
});

describe("engine: push config scope", () => {
	it("shows a push config only to the principal that created it", () => {
		const t = setup();
		t.register("a1");
		const id = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("job") }).task?.id ?? "";
		const config = { taskId: id, id: "c1", url: "https://hooks.example/x", token: "SECRET" };
		t.engine.createPushConfig("a1", fromHermes, config);
		const host: Caller = { principal: MARS };
		expect(t.engine.getTask("a1", host, id).id).toBe(id);
		expect(t.engine.listPushConfigs("a1", host, id)).toEqual([]);
		expect(reason(() => t.engine.getPushConfig("a1", host, id, "c1"))).toBe("task-not-found");
		expect(reason(() => t.engine.deletePushConfig("a1", host, id, "c1"))).toBe("task-not-found");
		expect(reason(() => t.engine.createPushConfig("a1", host, { ...config, url: "https://evil.example/" }))).toBe(
			"invalid",
		);
		expect(t.engine.getPushConfig("a1", fromHermes, id, "c1")).toMatchObject({
			url: "https://hooks.example/x",
			token: "SECRET",
		});
		t.engine.createPushConfig("a1", host, { taskId: id, id: "c2", url: "https://hooks.example/host" });
		expect(t.engine.listPushConfigs("a1", fromHermes, id).map((c) => c.id)).toEqual(["c1"]);
		t.engine.deletePushConfig("a1", fromHermes, id, "c1");
		expect(t.engine.listPushConfigs("a1", fromHermes, id)).toEqual([]);
	});
});

describe("engine: robustness", () => {
	it("keeps topics and ephemeral when a later register leaves them out", () => {
		const t = setup();
		t.register("a1", { topics: ["build"], ephemeral: true });
		t.register("a1", { name: "renamed" });
		expect(t.engine.agent("a1")).toMatchObject({ name: "renamed", topics: '["build"]', ephemeral: 1 });
		t.register("a1", { topics: [], ephemeral: false });
		expect(t.engine.agent("a1")).toMatchObject({ topics: "[]", ephemeral: 0 });
	});

	it("runs every after-commit listener when one throws, and logs the error", () => {
		const lines: string[] = [];
		const engine = new Engine(openDb(":memory:"), { log: (line) => lines.push(line) });
		engine.register(MARS, { agent: "a1", protocol: HUB_PROTOCOL });
		const id = engine.send({ agentId: "a1", caller: fromHermes, message: message("job") }).task?.id ?? "";
		const seen: string[] = [];
		engine.onTask(id, () => {
			throw new Error("listener broke");
		});
		engine.onTask(id, (event) => seen.push(event.state));
		engine.onLink(() => {
			throw new Error("link listener broke");
		});
		expect(() => engine.linkUpdate("a1", id, { state: "working" })).not.toThrow();
		expect(seen).toEqual(["TASK_STATE_WORKING"]);
		expect(lines.join("\n")).toMatch(/listener broke/);
	});

	it("releases the task listener and the timer when a wait is aborted", async () => {
		const t = setup();
		t.register("a1");
		const id = t.engine.send({ agentId: "a1", caller: fromHermes, message: message("job") }).task?.id ?? "";
		const controller = new AbortController();
		const wait = t.engine.waitForTask(id, () => false, 60_000, controller.signal);
		expect(t.engine.listenerCount(id)).toBe(1);
		controller.abort();
		await wait;
		expect(t.engine.listenerCount(id)).toBe(0);
	});
});

describe("engine: client support", () => {
	const asker: Caller = { principal: MARS, agent: "asker" };
	const helper: Caller = { principal: MARS, agent: "helper" };

	function pair() {
		const t = setup();
		t.register("asker", { name: "Asker" });
		t.register("helper", { name: "Helper" });
		return t;
	}

	it("turns a task update with text into an inbox row for the sender agent", () => {
		const t = pair();
		const task = t.engine.send({ agentId: "helper", caller: asker, message: message("go") }).task;
		const id = task?.id ?? "";
		t.engine.linkUpdate("helper", id, { state: "working" });
		t.engine.linkUpdate("helper", id, { state: "working", text: "halfway" });
		t.engine.linkUpdate("helper", id, { state: "input-required", text: "which?" });
		t.engine.send({ agentId: "helper", caller: asker, message: message("that", { taskId: id }) });
		t.engine.linkUpdate("helper", id, { state: "completed", text: "done" });
		const rows = t.engine.inbox("asker", false, 10).reverse();
		expect(rows.map((row) => [row.kind, row.wake, row.text])).toEqual([
			["status", "never", "halfway"],
			["question", "now", "which?"],
			["result", "now", "done"],
		]);
		expect(rows[2]).toMatchObject({
			taskId: id,
			contextId: task?.contextId,
			direction: "in",
			from: { agent: "helper", name: "Helper", kind: "pi" },
			to: { agent: "asker", name: "Asker" },
		});
		const updates = t.events.filter((e) => e.agent === "asker" && e.event.type === "update");
		expect(updates.map((e) => e.event.payload)).toContainEqual(
			expect.objectContaining({ state: "completed", kind: "result", messageId: rows[2]?.messageId }),
		);
		const plain = updates.find((e) => (e.event.payload as { text?: string }).text === undefined);
		expect(plain?.event.payload).not.toHaveProperty("messageId");
	});

	it("returns a thread in order for both sides and refuses an ambiguous prefix", () => {
		const t = pair();
		t.engine.send({
			agentId: "helper",
			caller: asker,
			message: message("q", { contextId: "ctx-a1" }, { kind: "note" }),
		});
		t.engine.send({
			agentId: "asker",
			caller: helper,
			message: message("a", { contextId: "ctx-a1" }, { kind: "answer" }),
		});
		t.engine.send({
			agentId: "helper",
			caller: asker,
			message: message("other", { contextId: "ctx-a2" }, { kind: "note" }),
		});
		const thread = t.engine.thread("asker", "ctx-a1");
		expect(thread.messages.map((m) => [m.text, m.direction])).toEqual([
			["q", "out"],
			["a", "in"],
		]);
		expect(t.engine.thread("helper", "ctx-a1").messages.map((m) => m.direction)).toEqual(["in", "out"]);
		try {
			t.engine.thread("asker", "ctx-a");
			expect.unreachable();
		} catch (error) {
			expect((error as HubError).status).toBe(409);
			expect((error as HubError).details?.["candidates"]).toHaveLength(2);
		}
		expect(reason(() => t.engine.thread("asker", "nope"))).toBe("not-found");
		expect(reason(() => t.engine.thread("asker", "ctx-a2x"))).toBe("not-found");
	});

	it("keeps one expect_reply row per recipient and lists what each side owes", () => {
		const t = pair();
		t.register("third", { name: "Third" });
		for (const agentId of ["helper", "third"]) {
			t.engine.send({
				agentId,
				caller: asker,
				message: message("ping", { messageId: "fan-1", contextId: "c" }, { kind: "note", expectReply: true }),
			});
		}
		expect(t.engine.pending("asker").expectReply.map((row) => row.agent)).toEqual(["helper", "third"]);
		expect(t.engine.owed("helper").expectReply).toEqual([
			expect.objectContaining({ messageId: "fan-1", agent: "asker", name: "Asker" }),
		]);
		t.engine.send({
			agentId: "asker",
			caller: helper,
			message: message("pong", { contextId: "c" }, { kind: "answer", replyTo: "fan-1" }),
		});
		expect(t.engine.pending("asker").expectReply.map((row) => row.agent)).toEqual(["third"]);
		expect(t.engine.owed("helper").expectReply).toEqual([]);
		const id = t.engine.send({ agentId: "helper", caller: asker, message: message("job") }).task?.id ?? "";
		expect(t.engine.owed("helper").tasks).toEqual([
			expect.objectContaining({ taskId: id, agent: "asker", name: "Asker", state: "submitted" }),
		]);
		t.engine.send({ agentId: "helper", caller: fromHermes, message: message("peer job") });
		expect(t.engine.owed("helper").tasks.at(-1)).toMatchObject({ agent: null, name: "hermes" });
	});

	it("sends presence to agents with an open question or a live task, either way", () => {
		const t = pair();
		t.register("asker2");
		t.register("idle");
		t.engine.send({ agentId: "helper", caller: asker, message: message("job") });
		t.engine.send({
			agentId: "asker2",
			caller: helper,
			message: message("q", {}, { kind: "note", expectReply: true }),
		});
		t.engine.setOnline("helper", true);
		const presence = t.events.filter((e) => e.event.type === "presence");
		expect(presence.map((e) => [e.agent, (e.event.payload as { relation: string }).relation])).toEqual(
			expect.arrayContaining([
				["asker", "peer"],
				["asker2", "peer"],
			]),
		);
		expect(presence).toHaveLength(2);
	});

	it("adds the bus fields to inbox and message items", () => {
		const t = pair();
		t.engine.send({
			agentId: "helper",
			caller: asker,
			message: message(
				"fyi",
				{ messageId: "rich" },
				{
					kind: "note",
					wake: "never",
					priority: "urgent",
					expectReply: true,
					replyTo: "x",
					subject: "s",
					data: { n: 1 },
				},
			),
		});
		const expected = {
			messageId: "rich",
			kind: "note",
			wake: "never",
			priority: "urgent",
			expectReply: true,
			replyTo: "x",
			subject: "s",
			data: { n: 1 },
			from: { agent: "asker", name: "Asker", kind: "pi" },
			to: { agent: "helper", name: "Helper" },
		};
		expect(t.engine.inbox("helper", true, 10)[0]).toMatchObject({ ...expected, direction: "in" });
		expect(t.engine.message("asker", "rich")).toMatchObject({ ...expected, direction: "out" });
	});

	it("pre-registers a child that a later register from the same host takes over", () => {
		const t = setup();
		t.register("parent");
		expect(
			t.engine.addChild(MARS, "parent", { id: "kid", name: "Kid", role: "tester", labels: { model: "m1" } }),
		).toEqual({
			agent: "kid",
			name: "Kid",
			host: "mars",
		});
		expect(t.engine.agentInfo(t.engine.requireAgent("kid"))).toMatchObject({
			online: false,
			parent: "parent",
			role: "tester",
			labels: { model: "m1" },
		});
		const id = t.engine.send({
			agentId: "kid",
			caller: { principal: MARS, agent: "parent" },
			message: message("first"),
		}).task?.id;
		expect(t.engine.unacked("kid")[0]?.payload).toMatchObject({ taskId: id, text: "first" });
		t.register("other");
		expect(reason(() => t.engine.addChild(MARS, "other", { id: "kid" }))).toBe("conflict");
		expect(reason(() => t.engine.addChild(VENUS, "parent", { id: "kid" }))).toBe("conflict");
		expect(t.register("kid", { cwd: "/w" })).toEqual({ agent: "kid", name: "Kid", host: "mars" });
		expect(t.engine.agentInfo(t.engine.requireAgent("kid"))).toMatchObject({
			parent: "parent",
			cwd: "/w",
			role: "tester",
		});
		expect(reason(() => t.register("kid", {}, VENUS))).toBe("forbidden");
	});
});

describe("engine: task state on items", () => {
	it("adds the current state of the linked task to inbox, message, and thread items", () => {
		const t = setup();
		t.register("asker");
		t.register("helper");
		const asker: Caller = { principal: MARS, agent: "asker" };
		const task = t.engine.send({
			agentId: "helper",
			caller: asker,
			message: message("go", { messageId: "go-1" }),
		}).task;
		t.engine.send({
			agentId: "helper",
			caller: asker,
			message: message("fyi", { messageId: "note-1" }, { kind: "note" }),
		});
		expect(t.engine.message("helper", "go-1").taskState).toBe("submitted");
		t.engine.linkUpdate("helper", task?.id ?? "", { state: "completed", text: "done" });
		expect(t.engine.message("helper", "go-1").taskState).toBe("completed");
		expect(t.engine.inbox("asker", false, 10)[0]).toMatchObject({ text: "done", taskState: "completed" });
		expect(t.engine.thread("asker", task?.contextId ?? "").messages.map((m) => m.taskState)).toEqual([
			"completed",
			"completed",
		]);
		expect(t.engine.message("helper", "note-1")).not.toHaveProperty("taskState");
	});
});
