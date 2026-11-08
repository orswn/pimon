import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { BusNode, type PeerGone } from "../../src/features/bus/node.ts";
import type { Envelope } from "../../src/features/bus/protocol.ts";
import { busDirs } from "../../src/features/bus/registry.ts";

const DRIVER = new URL("../fixtures/new-bus-driver.ts", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs = 6_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await sleep(20);
	}
}

// One sequence, like a conversation: each step depends on the questions the earlier steps settled.
describe("pending question resolution", () => {
	let root: string;
	let asker: BusNode;
	let answerer: ReturnType<typeof spawn>;
	const inbound: Envelope[] = [];
	const answererEvents: { event: string; payload: Record<string, unknown> }[] = [];
	const gone: PeerGone[] = [];

	const send = (command: Record<string, string>) => answerer.stdin?.write(`${JSON.stringify(command)}\n`);
	const answererEnvelopes = () => answererEvents.filter((entry) => entry.event === "envelope");
	const open = () => asker.pendingQuestions().map((entry) => entry.body);

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "bus-pending-"));
		const dir = join(root, "bus");
		answerer = spawn(process.execPath, [DRIVER, "answerer", "", "--mute"], {
			env: { ...process.env, PI_BUS_DIR: dir },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let buffer = "";
		answerer.stdout?.setEncoding("utf8");
		answerer.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const index = buffer.indexOf("\n");
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (line) answererEvents.push(JSON.parse(line) as (typeof answererEvents)[number]);
			}
		});
		asker = new BusNode({
			owner: randomUUID(),
			desiredName: "asker",
			dirs: busDirs("", dir),
			onEnvelope: (envelope) => {
				inbound.push(envelope);
			},
			onPeerGone: (event) => gone.push(event),
		});
		await asker.start();
		await until(() => answererEvents.some((entry) => entry.event === "started"));
	});

	afterAll(async () => {
		answerer.kill("SIGKILL");
		await asker.stop();
		rmSync(root, { recursive: true, force: true });
	});

	it("normalizes a legacy next-turn wake before transport", async () => {
		const seen = answererEnvelopes().length;
		await asker.send("name:answerer", { body: "legacy wake", wake: "next-turn" });
		await until(() => answererEnvelopes().length > seen);
		expect(answererEnvelopes().at(-1)?.payload["wake"]).toBe("now");
	});

	it("resolves an answer that carries corrId", async () => {
		const result = await asker.send("name:answerer", { body: "Q1 with corrId", kind: "question", replyExpected: true });
		expect(result.delivered.map((peer) => peer.name)).toEqual(["answerer"]);
		await until(() => answererEnvelopes().at(-1)?.payload["body"] === "Q1 with corrId");
		expect(open()).toEqual(["Q1 with corrId"]);
		const messageId = answererEnvelopes().at(-1)?.payload["messageId"];
		expect(typeof messageId).toBe("string");
		send({ cmd: "answer", to: "name:asker", body: "A1", corrId: String(messageId) });
		await until(() => open().length === 0);
	});

	it("resolves an answer on the thread without corrId", async () => {
		await asker.send("name:answerer", { body: "Q2 no corrId", kind: "question", replyExpected: true });
		await until(() => answererEnvelopes().at(-1)?.payload["body"] === "Q2 no corrId");
		expect(open()).toEqual(["Q2 no corrId"]);
		send({ cmd: "answer", to: "name:asker", body: "A2 on thread", thread: "true" });
		await until(() => open().length === 0);
	});

	it("settles on a result and not on a status", async () => {
		await asker.send("name:answerer", { body: "Q3 result", kind: "question", replyExpected: true });
		await until(() => answererEnvelopes().at(-1)?.payload["body"] === "Q3 result");
		send({ cmd: "answer", to: "name:asker", body: "R3", kind: "result", thread: "true" });
		await until(() => open().length === 0);

		await asker.send("name:answerer", { body: "Q4 status", kind: "question", replyExpected: true });
		await until(() => answererEnvelopes().at(-1)?.payload["body"] === "Q4 status");
		const before = inbound.length;
		send({ cmd: "answer", to: "name:asker", body: "S4", kind: "status", thread: "true" });
		await until(() => inbound.length > before);
		expect(open()).toEqual(["Q4 status"]);
	});

	it("leaves the question open on an off-thread answer", async () => {
		const before = inbound.length;
		send({ cmd: "answer", to: "name:asker", body: "stray answer" });
		await until(() => inbound.length > before);
		expect(open()).toEqual(["Q4 status"]);
		const outstanding = asker.pendingQuestions()[0]?.targets.filter((target) => !target.answered);
		expect(outstanding?.map((target) => target.name)).toEqual(["answerer"]);
	});

	it("reports nothing owed when an answered peer dies", async () => {
		send({ cmd: "answer", to: "name:asker", body: "A4 finally", thread: "true" });
		await until(() => open().length === 0);
		answerer.kill("SIGKILL");
		await until(() => gone.length > 0, 20_000);
		expect(gone[0]?.pending).toEqual([]);
	});
});
