import { describe, expect, it } from "vite-plus/test";
import type { InboxItem, PendingResult, TaskUpdateBody } from "@orswn/a2a-hub-protocol";
import type { HubClient, OutgoingMessage, SendOutcome } from "./hub/client.ts";
import { HubHttpError } from "./hub/client.ts";
import type { AgentInfo } from "./protocol.ts";
import {
	type ActionHost,
	formatSendResult,
	inboxAction,
	peersAction,
	probeAction,
	replyAction,
	sendAction,
	type SendResult,
	setStatusAction,
} from "./tool.ts";

const SELF = "9".repeat(32);
const ASKER = "a".repeat(32);

function agent(name: string, hex: string, extra: Partial<AgentInfo> = {}): AgentInfo {
	return {
		id: hex.repeat(32),
		name,
		kind: "session",
		host: "mars",
		cwd: "/",
		role: null,
		labels: {},
		parent: null,
		topics: [],
		online: true,
		state: "idle",
		activity: null,
		status: { text: "", at: null },
		lastSeenAt: null,
		...extra,
	};
}

function item(extra: Partial<InboxItem> = {}): InboxItem {
	return {
		messageId: "e".repeat(32),
		taskId: null,
		contextId: "f".repeat(32),
		direction: "in",
		from: { agent: ASKER, name: "asker", kind: "session" },
		to: { agent: SELF, name: "me" },
		kind: "question",
		wake: "now",
		subject: null,
		priority: null,
		expectReply: true,
		replyTo: null,
		text: "q",
		createdAt: new Date(0).toISOString(),
		read: false,
		...extra,
	};
}

interface Fake {
	sends: { to: string; message: OutgoingMessage }[];
	updates: { taskId: string; body: TaskUpdateBody }[];
	read: string[];
	status: string[];
	threads: string[];
	agentInfo: string[];
}

function host(
	options: {
		agents?: AgentInfo[];
		outcome?: (to: string) => SendOutcome;
		messages?: InboxItem[];
		owed?: PendingResult;
		pending?: PendingResult;
		statusOffline?: boolean;
	} = {},
): { host: ActionHost; fake: Fake } {
	const fake: Fake = { sends: [], updates: [], read: [], status: [], threads: [], agentInfo: [] };
	const empty: PendingResult = { expectReply: [], tasks: [] };
	const messages = options.messages ?? [];
	const client = {
		sendMessage: async (to: string, message: OutgoingMessage) => {
			fake.sends.push({ to, message });
			return options.outcome?.(to) ?? { state: "delivered", contextId: message.contextId };
		},
		thread: async (id: string) => {
			fake.threads.push(id);
			throw new HubHttpError(404, "404 not-found");
		},
		message: async (id: string) => {
			const found = messages.find((entry) => entry.messageId.startsWith(id));
			if (!found) throw new HubHttpError(404, "404 not-found");
			return found;
		},
		owed: async () => options.owed ?? empty,
		pending: async () => options.pending ?? empty,
		taskUpdate: async (taskId: string, body: TaskUpdateBody) => {
			fake.updates.push({ taskId, body });
			return { id: taskId, contextId: "f".repeat(32), status: { message: { messageId: "9".repeat(32) } } };
		},
		agentInfo: async (id: string) => {
			fake.agentInfo.push(id);
			return agent("x", "x", { id, online: true });
		},
		inbox: async () => messages,
	} as unknown as HubClient;
	const actionHost: ActionHost = {
		wakePolicy: "all",
		hub: () => client,
		self: () => ({ id: SELF, name: "me", labels: {}, topics: [], cwd: "/", ephemeral: false }),
		hubUrl: () => "http://hub",
		linkText: () => "online",
		agents: async () => [agent("me", "9"), ...(options.agents ?? [])],
		markRead: async (ids) => {
			fake.read.push(...ids);
		},
		setTopics: () => {},
		setStatus: async (text) => {
			fake.status.push(text);
			return { text, sent: options.statusOffline !== true };
		},
		sent: () => {},
		changed: () => {},
		statusLine: () => "bus: online",
	};
	return { host: actionHost, fake };
}

const three = [agent("alpha", "1"), agent("beta", "2"), agent("gamma", "3"), agent("delta", "4")];
const mixedOutcome = (to: string): SendOutcome =>
	to.startsWith("1")
		? { state: "delivered", contextId: "c" }
		: to.startsWith("2")
			? { state: "unconfirmed", contextId: "c" }
			: to.startsWith("3")
				? { state: "failed", reason: "hub unreachable: ECONNREFUSED" }
				: { state: "queued", contextId: "c" };

describe("peers and probe", () => {
	it("hide the session kind and the pi harness, and show other kinds and harnesses", async () => {
		const { host: h } = host({
			agents: [
				agent("pi-one", "1", { labels: { harness: "pi" } }),
				agent("claude", "2", { labels: { harness: "claude-code" } }),
				agent("hermes", "3", { kind: "external", labels: {} }),
				agent("echo", "4", { kind: "builtin" }),
			],
		});
		expect((await peersAction(h)).text.split("\n")).toEqual([
			`pi-one id:${"1".repeat(12)} idle host=mars cwd=/`,
			`claude id:${"2".repeat(12)} harness=claude-code idle host=mars cwd=/`,
			`hermes id:${"3".repeat(12)} kind=external idle host=mars cwd=/`,
			`echo id:${"4".repeat(12)} kind=builtin idle host=mars cwd=/`,
		]);
	});

	it("show the whole stored status text", async () => {
		const text = `${"s".repeat(150)} long tail`;
		const { host: h } = host({ agents: [agent("alpha", "1", { status: { text, at: null } })] });
		expect((await peersAction(h)).text).toContain(`status="${text}"`);
		expect((await probeAction(h, "name:alpha")).text).toContain(`status="${text}"`);
	});
});

describe("send results", () => {
	it("prints one line per delivery state", () => {
		const result: SendResult = {
			messageId: "d".repeat(32),
			threadId: "c".repeat(32),
			lines: [
				{ name: "alpha", id: "1".repeat(32), state: "delivered" },
				{ name: "beta", id: "2".repeat(32), state: "unconfirmed" },
				{ name: "gamma", id: "3".repeat(32), state: "failed", reason: "refused" },
				{ name: "delta", id: "4".repeat(32), state: "queued" },
				{ name: "eps", id: "5".repeat(32), state: "queued" },
				{ name: "zeta", id: "6".repeat(32), state: "unconfirmed", reason: "no answer from the hub" },
			],
		};
		expect(formatSendResult("Sent", result).split("\n")).toEqual([
			"Sent on thread cccccccccccc (messageId dddddddddddd).",
			"delivered: alpha (id:111111111111)",
			"queued: delta (id:444444444444), eps (id:555555555555)",
			"unconfirmed: beta (stored; the peer did not confirm yet), zeta (no answer from the hub)",
			"failed: gamma (refused)",
		]);
	});

	it("sends one message id to every match and returns when one was handed over", async () => {
		const { host: h, fake } = host({ agents: three, outcome: mixedOutcome });
		const sent = await sendAction(h, { action: "send", target: "all", body: "hi" });
		expect(sent.text).toContain("queued: delta");
		expect(new Set(fake.sends.map((send) => send.message.messageId)).size).toBe(1);
		expect(fake.sends.map((send) => send.to).sort()).toEqual(three.map((a) => a.id).sort());
		expect(fake.sends[0]?.message.meta).toEqual({ kind: "note", wake: "now" });
	});

	it("makes a send with nothing handed over an error", async () => {
		const { host: h } = host({
			agents: [agent("gamma", "3")],
			outcome: () => ({ state: "failed", reason: "refused" }),
		});
		await expect(sendAction(h, { action: "send", target: "all", body: "hi" })).rejects.toThrow(
			/failed: gamma \(refused\)/,
		);
	});

	it("asks the hub for a thread only by prefix", async () => {
		const { host: h, fake } = host({ agents: [agent("alpha", "1")] });
		const full = "0190aaaa-2222-7222-8222-222222222222";
		const sent = await sendAction(h, { action: "send", target: "name:alpha", body: "hi", threadId: full });
		expect(fake.threads).toEqual([]);
		expect(fake.sends[0]?.message.contextId).toBe(full);
		expect(sent.text).toContain("on thread 0190aaaa2222");
		await expect(
			sendAction(h, { action: "send", target: "name:alpha", body: "hi", threadId: "0190aaaa" }),
		).rejects.toThrow("No thread 0190aaaa.");
		expect(fake.threads).toEqual(["0190aaaa"]);
	});

	it("refuses a unicast selector that matches two agents", async () => {
		const { host: h, fake } = host({ agents: [agent("twin", "1"), agent("twin", "2")] });
		await expect(sendAction(h, { action: "send", target: "name:twin", body: "hi" })).rejects.toThrow(
			/matches 2 agents/,
		);
		expect(fake.sends).toEqual([]);
	});

	it("settles the one open task of the recipient with a result instead of a new message", async () => {
		const owed: PendingResult = {
			expectReply: [],
			tasks: [{ taskId: "t1", contextId: "c", agent: ASKER, name: "asker", state: "working", createdAt: "" }],
		};
		const { host: h, fake } = host({ agents: [agent("asker", "a")], owed });
		const sent = await sendAction(h, { action: "send", target: "name:asker", body: "done", kind: "result" });
		expect(fake.sends).toEqual([]);
		expect(fake.updates).toEqual([
			{ taskId: "t1", body: { state: "completed", text: "done", artifact: { name: "result", text: "done" } } },
		]);
		expect(sent.text).toContain("queued: asker (id:aaaaaaaaaaaa, task completed)");
		expect(sent.text).toContain("(messageId 999999999999)");
		expect(fake.agentInfo).toEqual([]);
	});

	it("sends a plain message when the recipient has two open tasks", async () => {
		const task = { contextId: "c", agent: ASKER, name: "asker", state: "working" as const, createdAt: "" };
		const owed: PendingResult = {
			expectReply: [],
			tasks: [
				{ ...task, taskId: "t1" },
				{ ...task, taskId: "t2" },
			],
		};
		const { host: h, fake } = host({ agents: [agent("asker", "a")], owed });
		await sendAction(h, { action: "send", target: "name:asker", body: "done", kind: "result" });
		expect(fake.updates).toEqual([]);
		expect(fake.sends).toHaveLength(1);
	});
});

describe("reply", () => {
	it("answers a note with a message to the sender in the same thread", async () => {
		const { host: h, fake } = host({ messages: [item({ kind: "note" })] });
		const replied = await replyAction(h, { action: "reply", body: "a", messageId: "eeeeeeee" });
		expect(replied.text).toContain("Replied to asker id:aaaaaaaaaaaa");
		expect(fake.sends).toHaveLength(1);
		expect(fake.sends[0]?.to).toBe(ASKER);
		expect(fake.sends[0]?.message.contextId).toBe("f".repeat(32));
		expect(fake.sends[0]?.message.meta.replyTo).toBe("e".repeat(32));
	});

	it("completes an open task from a peer principal and asks back with a question", async () => {
		const task = item({
			kind: "task",
			taskId: "t1",
			taskState: "working",
			from: { name: "hermes", kind: "peer" },
		});
		const owed: PendingResult = {
			expectReply: [],
			tasks: [{ taskId: "t1", contextId: "c", agent: null, name: "hermes", state: "working", createdAt: "" }],
		};
		const { host: h, fake } = host({ messages: [task], owed });
		const asked = await replyAction(h, { action: "reply", body: "which file?", messageId: "eeee", kind: "question" });
		expect(asked.text).toContain("Replied to hermes on thread");
		expect(asked.text).toContain("queued: hermes (principal, task input-required)");
		const done = await replyAction(h, { action: "reply", body: "here", messageId: "eeee", kind: "result" });
		expect(done.text).toContain("task completed");
		expect(fake.updates.map((update) => update.body.state)).toEqual(["input-required", "completed"]);
		expect(fake.sends).toEqual([]);
	});

	it("refuses a reply to a principal whose task is closed", async () => {
		const task = item({ kind: "task", taskId: "t1", taskState: "completed", from: { name: "hermes", kind: "peer" } });
		const { host: h } = host({ messages: [task] });
		await expect(replyAction(h, { action: "reply", body: "late", messageId: "eeee" })).rejects.toThrow(
			/not a bus agent/,
		);
	});

	it("refuses a target and an own message", async () => {
		const { host: h } = host({
			messages: [item({ direction: "out", from: { agent: SELF, name: "me", kind: "session" } })],
		});
		await expect(replyAction(h, { action: "reply", target: "all", body: "x", messageId: "e" })).rejects.toThrow(
			/reply derives the recipient/,
		);
		await expect(replyAction(h, { action: "reply", body: "x", messageId: "eeee" })).rejects.toThrow(
			/was sent by this session/,
		);
	});
});

describe("inbox", () => {
	it("marks only fully shown bodies as read", async () => {
		const short = item({ messageId: "1".repeat(32), kind: "note", text: "short" });
		const long = item({ messageId: "2".repeat(32), kind: "note", text: "y".repeat(500) });
		const { host: h, fake } = host({ messages: [short, long] });
		const shown = await inboxAction(h, {});
		expect(shown.text).toContain("messageId=111111111111");
		expect(shown.text).toContain("messageId=222222222222");
		expect(fake.read).toEqual(["1".repeat(32)]);
	});

	it("shows a principal sender by name", async () => {
		const { host: h } = host({ messages: [item({ from: { name: "hermes", kind: "peer" }, kind: "task" })] });
		expect((await inboxAction(h, {})).text).toContain("task from hermes ·");
	});
});

describe("set_status", () => {
	it("sets and clears the status text", async () => {
		const { host: h, fake } = host();
		expect((await setStatusAction(h, "testing step 3")).text).toBe("Status set: testing step 3");
		expect((await setStatusAction(h, undefined)).text).toBe("Status cleared.");
		expect(fake.status).toEqual(["testing step 3", ""]);
	});

	it("says when the hub gets the text later", async () => {
		const { host: h } = host({ statusOffline: true });
		expect((await setStatusAction(h, "x")).text).toBe("Status set: x\nThe hub gets it when the link is back.");
	});
});
