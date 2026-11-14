import { TaskState } from "@a2a-js/sdk";
import type { Client } from "@a2a-js/sdk/client";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
	a2aClient,
	bearer,
	type HubProcess,
	LinkClient,
	PEER_TOKEN,
	partText,
	sendRequest,
	startHubProcess,
	startWebhook,
	tempDir,
	writeTokens,
} from "../support/hub.ts";

type AnyTask = Awaited<ReturnType<Client["getTask"]>>;

describe("hub restart", () => {
	const tmp = tempDir("hub-restart-");
	const hubs: HubProcess[] = [];
	const links: LinkClient[] = [];

	afterAll(async () => {
		for (const link of links) await link.close();
		for (const hub of hubs) await hub.stop("SIGKILL");
		tmp.dispose();
	});

	it("keeps a WORKING task across a restart, then completes and pushes it", async () => {
		const tokensFile = writeTokens(tmp.dir);
		const dataDir = `${tmp.dir}/data`;
		const env = { HUB_PUSH_ALLOW: "127.0.0.1" };
		const hook = await startWebhook();
		try {
			const first = await startHubProcess({ dataDir, tokensFile, env });
			hubs.push(first);
			const link = new LinkClient(first.url, "survivor");
			links.push(link);
			await link.register();
			await link.connect();
			const client = await a2aClient(first.url, "survivor", bearer(PEER_TOKEN));
			const task = (await client.sendMessage(
				sendRequest("long job", { returnImmediately: true, push: { url: `${hook.url}/r`, token: "t" } }),
			)) as AnyTask;
			await link.next("message", (data) => data["taskId"] === task.id);
			await link.update(task.id, { state: "working" });
			expect(await first.stop("SIGTERM")).toBe(0);
			await link.close();

			const second = await startHubProcess({ dataDir, tokensFile, env });
			hubs.push(second);
			const again = new LinkClient(second.url, "survivor");
			links.push(again);
			await again.register();
			await again.connect();
			expect((await again.update(task.id, { state: "completed", text: "after restart" })).status).toBe(200);
			const client2 = await a2aClient(second.url, "survivor", bearer(PEER_TOKEN));
			const got = await client2.getTask({ id: task.id } as never);
			expect(got.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
			expect(partText(got.status?.message)).toBe("after restart");
			await hook.waitFor(
				(body) => JSON.stringify(body).includes(task.id) && JSON.stringify(body).includes("COMPLETED"),
			);
		} finally {
			await hook.close();
		}
	});
});
