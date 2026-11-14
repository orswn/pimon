import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HubClient } from "../../src/features/bus/hub/client.ts";
import { HubLink } from "../../src/features/bus/hub/link.ts";
import type { LinkEvent } from "../../src/hub/protocol.ts";
import type { LinkStatus } from "../../src/features/bus/hub/link.ts";
import { HOST_TOKEN, startHubProcess, startTestHub, tempDir, type TestHub, writeTokens } from "../support/hub.ts";

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met");
		await new Promise((done) => setTimeout(done, 10));
	}
}

describe("bus hub client against a real hub", () => {
	let hub: TestHub;
	beforeAll(async () => {
		hub = await startTestHub();
	});
	afterAll(async () => {
		await hub.close();
	});

	function agent(name: string, lastSeq?: number) {
		const id = randomUUID();
		const client = new HubClient({ url: hub.url, token: HOST_TOKEN, agent: id });
		const events: LinkEvent[] = [];
		const make = (seq?: number) =>
			new HubLink({
				client,
				registration: () => ({ name }),
				onEvent: (e) => {
					events.push(e);
				},
				onStatus: () => {},
				lastSeq: seq,
			});
		return { id, client, events, link: make(lastSeq), make };
	}

	it("registers, links, sends with delivery states, and replays after a relink", async () => {
		const alice = agent("alice");
		const bob = agent("bob");
		alice.link.start();
		bob.link.start();
		await until(() => alice.link.status.state === "online" && bob.link.status.state === "online");

		const delivered = await alice.client.sendMessage(bob.id, {
			messageId: randomUUID(),
			contextId: randomUUID(),
			text: "hello bob",
			meta: { kind: "note", wake: "now" },
		});
		expect(delivered.state).toBe("delivered");
		await until(() => bob.events.some((event) => event.type === "message"));
		expect(bob.events[0]?.payload).toMatchObject({ text: "hello bob", from: { agent: alice.id, name: "alice" } });

		await bob.link.stop();
		await bob.client.offline();
		const queued = await alice.client.sendMessage(bob.id, {
			messageId: randomUUID(),
			contextId: randomUUID(),
			text: "while away",
			meta: { kind: "task", wake: "now", subject: "later" },
		});
		expect(queued).toMatchObject({ state: "queued" });

		const again = bob.make(bob.link.lastSeq);
		again.start();
		await until(() => bob.events.filter((event) => event.type === "message").length === 2);
		expect(bob.events.at(-1)?.payload).toMatchObject({ text: "while away", kind: "task", taskState: "submitted" });
		await again.stop();
		await alice.link.stop();
	});
});

describe("bus link across a hub process restart", () => {
	it("gets each event once after the hub restarts on the same data", async () => {
		const scratch = tempDir("bus-restart-");
		const dataDir = `${scratch.dir}/data`;
		const tokensFile = writeTokens(scratch.dir);
		let hub = await startHubProcess({ dataDir, tokensFile });
		const port = hub.port;
		const url = hub.url;
		const linked = (name: string) => {
			const id = randomUUID();
			const client = new HubClient({ url, token: HOST_TOKEN, agent: id });
			const events: LinkEvent[] = [];
			const statuses: LinkStatus[] = [];
			const link = new HubLink({
				client,
				registration: () => ({ name }),
				onEvent: (event) => {
					events.push(event);
				},
				onStatus: (status) => statuses.push(status),
			});
			link.start();
			return { id, client, events, statuses, link };
		};
		const send = (from: HubClient, to: string, text: string) =>
			from.sendMessage(to, {
				messageId: randomUUID(),
				contextId: randomUUID(),
				text,
				meta: { kind: "note", wake: "now" },
			});
		const texts = (events: LinkEvent[]) =>
			events.filter((event) => event.type === "message").map((event) => (event.payload as { text: string }).text);
		const alice = linked("alice");
		const bob = linked("bob");
		try {
			await until(() => alice.link.status.state === "online" && bob.link.status.state === "online");
			expect((await send(alice.client, bob.id, "before the restart")).state).toBe("delivered");
			await until(() => texts(bob.events).length === 1);
			await new Promise((done) => setTimeout(done, 200));

			expect(await hub.stop("SIGTERM")).toBe(0);
			await until(() => bob.link.status.state === "retrying");
			hub = await startHubProcess({ dataDir, tokensFile, port });
			const reopened = bob.statuses.length;
			await until(() => bob.statuses.slice(reopened).some((status) => status.state === "online"), 15_000);
			await until(() => alice.link.status.state === "online", 15_000);

			expect((await send(alice.client, bob.id, "after the restart")).state).toBe("delivered");
			await until(() => texts(bob.events).length >= 2);
			await new Promise((done) => setTimeout(done, 300));
			expect(texts(bob.events)).toEqual(["before the restart", "after the restart"]);
			const seqs = bob.events.map((event) => event.seq);
			expect(new Set(seqs).size).toBe(seqs.length);
		} finally {
			await alice.link.stop();
			await bob.link.stop();
			await hub.stop();
			scratch.dispose();
		}
	}, 40_000);
});
