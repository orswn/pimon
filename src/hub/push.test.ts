import { describe, expect, it } from "vite-plus/test";
import { openDb } from "./db.ts";
import { Engine, HubError, PUSH_BACKLOG_MAX } from "./engine.ts";
import { HUB_PROTOCOL } from "./protocol.ts";
import { PUSH_BACKOFF_MS, PushSender, pushHeaders } from "./push.ts";
import { PushGuard } from "./push-guard.ts";

function setup(allow: string[] = ["127.0.0.0/8"]) {
	let clock = 1_000_000;
	const guard = new PushGuard(allow, async (host) => (host === "inside.example" ? ["10.0.0.7"] : ["93.184.216.34"]));
	const engine = new Engine(openDb(":memory:"), { now: () => clock, pushGuard: guard });
	const calls: { url: string; headers: Record<string, string>; body: string; redirect: string | undefined }[] = [];
	let status = 500;
	const fetchStub = (async (url: string, init: RequestInit) => {
		calls.push({
			url,
			headers: init.headers as Record<string, string>,
			body: typeof init.body === "string" ? init.body : "",
			redirect: init.redirect,
		});
		return new Response(null, { status });
	}) as typeof fetch;
	const sender = new PushSender(engine, { fetch: fetchStub, now: () => clock, guard });
	engine.register({ name: "mars", kind: "host" }, { agent: "a1", protocol: HUB_PROTOCOL });
	const caller = { principal: { name: "hermes", kind: "peer" as const } };
	const taskId =
		engine.send({ agentId: "a1", caller, message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "x" }] } }).task
			?.id ?? "";
	return {
		engine,
		sender,
		calls,
		caller,
		taskId,
		setStatus(value: number) {
			status = value;
		},
		advance(ms: number) {
			clock += ms;
		},
		now: () => clock,
	};
}

describe("push headers", () => {
	it("uses Authorization when authentication is set, else the token header", () => {
		expect(pushHeaders({ token: "t", authScheme: "Bearer", authCredentials: "abc" })).toEqual({
			"Content-Type": "application/a2a+json",
			Authorization: "Bearer abc",
		});
		expect(pushHeaders({ token: "t", authScheme: null, authCredentials: null })).toEqual({
			"Content-Type": "application/a2a+json",
			"X-A2A-Notification-Token": "t",
		});
		expect(pushHeaders({ token: null, authScheme: null, authCredentials: null })).toEqual({
			"Content-Type": "application/a2a+json",
		});
	});

	it("sends the token header when authentication has no credentials", () => {
		expect(pushHeaders({ token: "t", authScheme: "Bearer", authCredentials: null })).toEqual({
			"Content-Type": "application/a2a+json",
			"X-A2A-Notification-Token": "t",
		});
		expect(pushHeaders({ token: null, authScheme: "Bearer", authCredentials: null })).toEqual({
			"Content-Type": "application/a2a+json",
		});
	});
});

describe("push outbox", () => {
	it("enqueues one row per config on each task event, in order", () => {
		const t = setup();
		t.engine.createPushConfig("a1", t.caller, { taskId: t.taskId, url: "http://127.0.0.1:1/a", token: "tok" });
		t.engine.createPushConfig("a1", t.caller, { taskId: t.taskId, url: "http://127.0.0.1:1/b", id: "b" });
		t.engine.linkUpdate("a1", t.taskId, { state: "working" });
		t.engine.linkUpdate("a1", t.taskId, { state: "completed" });
		const due = t.engine.duePushes(t.now(), 10);
		expect(due).toHaveLength(2);
		expect(JSON.parse(due[0]?.payload ?? "{}")).toMatchObject({
			statusUpdate: { taskId: t.taskId, status: { state: "TASK_STATE_WORKING" } },
		});
		t.engine.pushDone(due[0]?.id ?? 0);
		const next = t.engine.duePushes(t.now(), 10).find((item) => item.url.endsWith("/a"));
		expect(JSON.parse(next?.payload ?? "{}")).toMatchObject({
			statusUpdate: { status: { state: "TASK_STATE_COMPLETED" } },
		});
	});

	it("retries after 1 s, 5 s, and 30 s, then drops the row", async () => {
		const t = setup();
		t.engine.createPushConfig("a1", t.caller, { taskId: t.taskId, url: "http://127.0.0.1:1/hook", token: "tok" });
		t.engine.linkUpdate("a1", t.taskId, { state: "working" });
		const waits: number[] = [];
		for (let attempt = 0; attempt < 4; attempt++) {
			const [item] = t.engine.duePushes(t.now(), 10);
			expect(item?.attempts).toBe(attempt);
			expect(await t.sender.deliver(item ?? expect.unreachable())).toBe(false);
			const next = t.engine.nextPushAt();
			if (next !== undefined) {
				waits.push(next - t.now());
				t.advance(next - t.now());
			}
		}
		expect(waits).toEqual([...PUSH_BACKOFF_MS]);
		expect(t.engine.duePushes(t.now() + 1e9, 10)).toEqual([]);
		expect(t.calls).toHaveLength(4);
		expect(t.calls[0]?.headers).toMatchObject({ "X-A2A-Notification-Token": "tok" });
	});

	it("deletes the row after a 2xx answer", async () => {
		const t = setup();
		t.setStatus(204);
		t.engine.createPushConfig("a1", t.caller, { taskId: t.taskId, url: "http://127.0.0.1:1/hook" });
		t.engine.linkUpdate("a1", t.taskId, { state: "working" });
		const [item] = t.engine.duePushes(t.now(), 10);
		expect(await t.sender.deliver(item ?? expect.unreachable())).toBe(true);
		expect(t.engine.nextPushAt()).toBeUndefined();
	});

	it("refuses a config URL that is not http or https", () => {
		const t = setup();
		for (const url of ["file:///etc/passwd", "ftp://x/y", "not a url", ""]) {
			expect(() => t.engine.createPushConfig("a1", t.caller, { taskId: t.taskId, url })).toThrow(HubError);
		}
	});

	it("removes queued rows when the config is deleted", () => {
		const t = setup();
		t.engine.createPushConfig("a1", t.caller, { taskId: t.taskId, url: "http://127.0.0.1:1/hook", id: "c1" });
		t.engine.linkUpdate("a1", t.taskId, { state: "working" });
		t.engine.deletePushConfig("a1", t.caller, t.taskId, "c1");
		expect(t.engine.nextPushAt()).toBeUndefined();
	});

	it("does not follow redirects and counts a 3xx as a failed attempt", async () => {
		const t = setup();
		t.setStatus(302);
		t.engine.createPushConfig("a1", t.caller, { taskId: t.taskId, url: "https://hooks.example/a" });
		t.engine.linkUpdate("a1", t.taskId, { state: "working" });
		const [item] = t.engine.duePushes(t.now(), 10);
		expect(await t.sender.deliver(item ?? expect.unreachable())).toBe(false);
		expect(t.calls[0]?.redirect).toBe("manual");
		expect(t.engine.duePushes(t.now() + 60_000, 10)[0]?.attempts).toBe(1);
	});

	it("refuses at send time a host name that resolves to a denied address", async () => {
		const t = setup([]);
		t.setStatus(200);
		t.engine.createPushConfig("a1", t.caller, { taskId: t.taskId, url: "https://inside.example/a" });
		t.engine.linkUpdate("a1", t.taskId, { state: "working" });
		const [item] = t.engine.duePushes(t.now(), 10);
		expect(await t.sender.deliver(item ?? expect.unreachable())).toBe(false);
		expect(t.calls).toEqual([]);
		expect(t.engine.duePushes(t.now() + 60_000, 10)[0]?.attempts).toBe(1);
	});

	it("refuses at config time an IP literal in a denied range", () => {
		const t = setup([]);
		for (const url of ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:9/x", "http://[fd00::1]/x"]) {
			expect(() => t.engine.createPushConfig("a1", t.caller, { taskId: t.taskId, url }), url).toThrow(/not allowed/);
		}
	});

	it("keeps at most the newest rows of one config while a webhook is down", () => {
		const t = setup();
		t.engine.createPushConfig("a1", t.caller, { taskId: t.taskId, url: "https://hooks.example/a", id: "c1" });
		t.engine.createPushConfig("a1", t.caller, { taskId: t.taskId, url: "https://hooks.example/b", id: "c2" });
		t.engine.linkUpdate("a1", t.taskId, { state: "working" });
		for (let i = 0; i < PUSH_BACKLOG_MAX + 10; i++) t.engine.setStatus("a1", `step ${i}`);
		const rows = t.engine.db
			.prepare("SELECT config_id, count(*) AS n FROM push_outbox GROUP BY config_id ORDER BY config_id")
			.all();
		expect(rows).toEqual([
			{ config_id: "c1", n: PUSH_BACKLOG_MAX },
			{ config_id: "c2", n: PUSH_BACKLOG_MAX },
		]);
		const oldest = t.engine.duePushes(t.now(), 10)[0];
		expect(JSON.parse(oldest?.payload ?? "{}")).toMatchObject({
			statusUpdate: { status: { message: { parts: [{ text: "step 10" }] } } },
		});
	});
});
