import { TaskState } from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
	a2aClient,
	bearer,
	type HubProcess,
	LinkClient,
	PEER_TOKEN,
	partText,
	sendRequest,
	sleep,
	startHubProcess,
	startWebhook,
	tempDir,
	type Webhook,
	writeTokens,
} from "../support/hub.ts";

type AnyTask = Awaited<ReturnType<Client["getTask"]>>;
const asTask = (value: unknown) => value as AnyTask;

describe("hub A2A face", () => {
	const tmp = tempDir("hub-a2a-");
	let hub: HubProcess;
	let hook: Webhook;
	let link: LinkClient;
	let client: Client;
	const agent = "pi-b";

	beforeAll(async () => {
		hub = await startHubProcess({
			dataDir: `${tmp.dir}/data`,
			tokensFile: writeTokens(tmp.dir),
			env: { HUB_PUSH_ALLOW: "127.0.0.1" },
		});
		hook = await startWebhook();
		link = new LinkClient(hub.url, agent);
		await link.register({ name: "bee" });
		await link.connect();
		client = await a2aClient(hub.url, agent, bearer(PEER_TOKEN));
	});

	afterAll(async () => {
		await link.close();
		await hook.close();
		await hub.stop();
		tmp.dispose();
	});

	let taskId = "";
	let contextId = "";

	it("1. returns a SUBMITTED task at once with returnImmediately", async () => {
		const task = asTask(await client.sendMessage(sendRequest("run the smoke test", { returnImmediately: true })));
		expect(task.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
		taskId = task.id;
		contextId = task.contextId;
	});

	it("2. delivers the task to the link and shows the status text on the WORKING task", async () => {
		const event = await link.next("message", (data) => data["taskId"] === taskId);
		expect(event.data).toMatchObject({
			text: "run the smoke test",
			kind: "task",
			from: { name: "hermes", kind: "peer" },
		});
		expect((await link.update(taskId, { state: "working" })).status).toBe(200);
		await link.status("smoke testing the fix");
		const task = await client.getTask({ id: taskId, tenant: "" } as never);
		expect(task.status?.state).toBe(TaskState.TASK_STATE_WORKING);
		expect(partText(task.status?.message)).toBe("smoke testing the fix");
		expect(task.history).toHaveLength(1);
	});

	it("3. takes a follow-up on an INPUT_REQUIRED task and moves it back to WORKING", async () => {
		await link.update(taskId, { state: "input-required", text: "Which branch?" });
		const asked = await client.getTask({ id: taskId } as never);
		expect(asked.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
		expect(partText(asked.status?.message)).toBe("Which branch?");
		const followUp = asTask(
			await client.sendMessage(sendRequest("branch main", { taskId, contextId, returnImmediately: true })),
		);
		expect(followUp.id).toBe(taskId);
		expect(followUp.status?.state).toBe(TaskState.TASK_STATE_WORKING);
		const event = await link.next("message", (data) => data["text"] === "branch main");
		expect(event.data["taskId"]).toBe(taskId);
	});

	it("4. streams the artifact and the COMPLETED status to a subscriber", async () => {
		const seen: string[] = [];
		const stream = (async () => {
			for await (const event of client.resubscribeTask({ id: taskId } as never)) {
				const payload = event.payload;
				if (payload?.$case === "statusUpdate") seen.push(`status:${payload.value.status?.state}`);
				else if (payload) seen.push(payload.$case);
			}
		})();
		await sleep(150);
		await link.update(taskId, { state: "completed", text: "done", artifact: { name: "out", text: "smoke passed" } });
		await stream;
		expect(seen).toEqual(["task", "artifactUpdate", `status:${TaskState.TASK_STATE_COMPLETED}`]);
		const task = await client.getTask({ id: taskId } as never);
		expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
		expect(partText(task.artifacts[0])).toBe("smoke passed");
	});

	it("5. holds a blocking SendMessage until the link completes the task", async () => {
		let settled = false;
		const pending = client.sendMessage(sendRequest("blocking please", { contextId })).then((result) => {
			settled = true;
			return asTask(result);
		});
		const event = await link.next("message", (data) => data["text"] === "blocking please");
		await sleep(300);
		expect(settled).toBe(false);
		await link.update(String(event.data["taskId"]), { state: "completed", artifact: { text: "blocking result" } });
		const task = await pending;
		expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
		expect(partText(task.artifacts[0])).toBe("blocking result");
	});

	let otherTask = "";

	it("6. lists only the tasks of one context", async () => {
		otherTask = asTask(await client.sendMessage(sendRequest("other thread", { returnImmediately: true }))).id;
		// The SDK client sends UNRECOGNIZED for a missing status, which a server must refuse.
		const list = await client.listTasks({
			contextId,
			pageSize: 50,
			status: TaskState.TASK_STATE_UNSPECIFIED,
		} as never);
		expect(list.tasks).toHaveLength(2);
		expect(list.tasks.every((task) => task.contextId === contextId)).toBe(true);
		expect(list.tasks.map((task) => task.id)).toContain(taskId);
	});

	it("7. cancels a WORKING task, tells the link, and refuses a later link update", async () => {
		await link.update(otherTask, { state: "working" });
		const canceled = await client.cancelTask({ id: otherTask } as never);
		expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
		await link.next("cancel", (data) => data["taskId"] === otherTask);
		expect((await link.update(otherTask, { state: "completed" })).status).toBe(409);
	});

	it("8. pushes each update with the configured auth headers", async () => {
		const task = asTask(await client.sendMessage(sendRequest("push me", { returnImmediately: true })));
		await client.createTaskPushNotificationConfig({
			taskId: task.id,
			id: "cfg-auth",
			url: `${hook.url}/auth`,
			token: "tok",
			authentication: { scheme: "Bearer", credentials: "cred" },
		} as never);
		await client.createTaskPushNotificationConfig({
			taskId: task.id,
			id: "cfg-token",
			url: `${hook.url}/token`,
			token: "tok",
		} as never);
		const listed = await client.listTaskPushNotificationConfig({ taskId: task.id } as never);
		expect(listed.configs.map((config) => config.id).sort()).toEqual(["cfg-auth", "cfg-token"]);
		await link.update(task.id, { state: "working" });
		await link.update(task.id, { state: "completed", artifact: { text: "push result" } });
		const completed = (body: Record<string, unknown>) =>
			JSON.stringify(body).includes(task.id) && JSON.stringify(body).includes("TASK_STATE_COMPLETED");
		await hook.waitFor(completed);
		await sleep(100);
		const auth = hook.calls.filter((call) => call.path === "/auth");
		const token = hook.calls.filter((call) => call.path === "/token");
		expect(auth.map((call) => Object.keys(call.body)[0])).toEqual(["statusUpdate", "artifactUpdate", "statusUpdate"]);
		expect(auth[0]?.headers["authorization"]).toBe("Bearer cred");
		expect(auth[0]?.headers["x-a2a-notification-token"]).toBeUndefined();
		expect(auth[0]?.headers["content-type"]).toBe("application/a2a+json");
		expect(token[0]?.headers["x-a2a-notification-token"]).toBe("tok");
		expect(token[0]?.headers["authorization"]).toBeUndefined();
	});

	it("9. queues a task for an offline agent and replays it on connect", async () => {
		await link.close();
		await link.ok("DELETE", `/link/${agent}`);
		const task = asTask(await client.sendMessage(sendRequest("while you were away", { returnImmediately: true })));
		expect(task.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
		const info = await link.ok("GET", `/agents/${agent}`);
		expect(info["online"]).toBe(false);
		const fresh = new LinkClient(hub.url, agent);
		await fresh.connect();
		const event = await fresh.next("message", (data) => data["taskId"] === task.id);
		expect(event.data["text"]).toBe("while you were away");
		await fresh.update(task.id, { state: "completed", text: "got it" });
		expect((await client.getTask({ id: task.id } as never)).status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
		link = fresh;
	});

	it("keeps a link update with no open request in GetTask and pushes it", async () => {
		const task = asTask(await client.sendMessage(sendRequest("detached", { returnImmediately: true })));
		await client.createTaskPushNotificationConfig({ taskId: task.id, id: "late", url: `${hook.url}/late` } as never);
		await link.update(task.id, { state: "completed", text: "finished later" });
		const got = await client.getTask({ id: task.id } as never);
		expect(got.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
		expect(partText(got.status?.message)).toBe("finished later");
		await hook.waitFor((body) => JSON.stringify(body).includes(task.id) && JSON.stringify(body).includes("COMPLETED"));
	});

	it("serves the card with cache headers and 304 on a matching ETag", async () => {
		const response = await fetch(`${hub.url}/a2a/${agent}/.well-known/agent-card.json`);
		expect(response.headers.get("cache-control")).toBe("max-age=60");
		const etag = response.headers.get("etag") ?? "";
		const card = (await response.json()) as Record<string, unknown>;
		expect(card).toMatchObject({
			name: "bee",
			description: "pi session on mars",
			supportedInterfaces: [{ url: `${hub.url}/a2a/${agent}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
			securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: "bearer" } } },
		});
		expect(JSON.stringify(card)).not.toContain("smoke");
		const again = await fetch(`${hub.url}/a2a/${agent}/.well-known/agent.json`, { headers: { "If-None-Match": etag } });
		expect(again.status).toBe(304);
	});

	it("refuses a missing token, an unknown version, and an unknown agent", async () => {
		const rpc = (headers: Record<string, string>, path = agent) =>
			fetch(`${hub.url}/a2a/${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "GetTask", params: { id: "x" } }),
			});
		expect((await rpc({})).status).toBe(401);
		const old = (await (await rpc({ ...bearer(PEER_TOKEN) })).json()) as { error: { code: number } };
		expect(old.error.code).toBe(-32009);
		const future = (await (await rpc({ ...bearer(PEER_TOKEN), "A2A-Version": "99.0" })).json()) as {
			error: { code: number };
		};
		expect(future.error.code).toBe(-32009);
		const patch = (await (await rpc({ ...bearer(PEER_TOKEN), "A2A-Version": "1.0.2" })).json()) as {
			error: { code: number };
		};
		expect(patch.error.code).toBe(-32001);
		expect((await rpc({ ...bearer(PEER_TOKEN), "A2A-Version": "1.0" }, "@nobody")).status).toBe(404);
	});
});
