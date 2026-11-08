// Runs the new BusNode without pi under plain `node`, with the same JSONL command set as the old bus harness.
import { randomUUID } from "node:crypto";
import { BusNode } from "../../src/features/bus/node.ts";
import type { Envelope, PeerRecord } from "../../src/features/bus/protocol.ts";
import { busDirs, parseLabels } from "../../src/features/bus/registry.ts";

const [, , rawName, rawLabels, ...rest] = process.argv;
const mute = rest.includes("--mute");
const dir = process.env["PI_BUS_DIR"];
if (!dir) throw new Error("PI_BUS_DIR is required");

function emit(event: string, payload: unknown): void {
	process.stdout.write(`${JSON.stringify({ event, payload })}\n`);
}

let lastThread: string | undefined;
let lastSend: { envelope: Envelope; targets: PeerRecord[] } | undefined;

const node: BusNode = new BusNode({
	owner: randomUUID(),
	desiredName: rawName || "driver",
	labels: parseLabels(rawLabels),
	dirs: busDirs("", dir),
	log: (message) => emit("log", { message }),
	onEnvelope: async (envelope) => {
		lastThread = envelope.threadId;
		emit("envelope", {
			messageId: envelope.id,
			threadId: envelope.threadId,
			from: envelope.from.name,
			kind: envelope.kind,
			wake: envelope.wake,
			body: envelope.body,
			corrId: envelope.corrId,
		});
		if (envelope.kind === "question" && !mute) {
			const result = await node.sendTo(envelope.from, {
				body: `ack from ${node.name}: ${envelope.body}`,
				kind: "answer",
				threadId: envelope.threadId,
				corrId: envelope.id,
				wake: "now",
			});
			emit("replied", { to: envelope.from.name, delivered: result.delivered.map((peer) => peer.name) });
		}
	},
	onPeerGone: (event) =>
		emit("peer_gone", { name: event.record.name, reason: event.reason, pending: event.pending.length }),
});

await node.start();
emit("started", { name: node.name, instanceId: node.instanceId, pid: process.pid, sock: node.socketPath });

async function run(command: Record<string, string>): Promise<void> {
	switch (command["cmd"]) {
		case "peers":
			emit(
				"peers",
				node.peers(0).map((peer) => ({ name: peer.name, heartbeatAt: peer.heartbeatAt, owner: peer.owner })),
			);
			return;
		case "send": {
			const result = await node.send(command["to"] ?? "", {
				body: command["body"] || "hello",
				kind: (command["kind"] as never) || "note",
				wake: "now",
				replyExpected: command["kind"] === "question",
			});
			emit("send_result", {
				delivered: result.delivered.map((peer) => peer.name),
				unknown: result.unknown,
				failed: result.failed,
			});
			return;
		}
		case "answer": {
			const result = await node.send(command["to"] ?? "", {
				body: command["body"] || "manual answer",
				kind: (command["kind"] as never) || "answer",
				corrId: command["corrId"],
				threadId: command["thread"] === "true" ? lastThread : undefined,
			});
			emit("answered", { delivered: result.delivered.map((peer) => peer.name) });
			return;
		}
		case "senddup": {
			const first = await node.send(command["to"] ?? "", { body: command["body"] || "dup", kind: "note" });
			const second = await node.resend(first.envelope, first.delivered);
			emit("dup_result", { first: first.acks, second: second.acks });
			return;
		}
		case "pending":
			emit(
				"pending",
				node.pendingQuestions().map((entry) => ({
					body: entry.body,
					outstanding: entry.targets.filter((target) => !target.answered && !target.gone).map((target) => target.name),
				})),
			);
			return;
		case "watch":
			for (const peer of node.resolve(command["to"] ?? "")) node.watch(peer);
			emit("watching", { names: node.watching().map((peer) => peer.name) });
			return;
		case "sendbig":
			try {
				await node.send(command["to"] ?? "", { body: "x".repeat(300 * 1024), kind: "note" });
				emit("bigsend", { rejected: false });
			} catch (error) {
				emit("bigsend", { rejected: true, reason: (error as Error).message });
			}
			return;
		case "block": {
			const until = Date.now() + Number(command["ms"] || 1000);
			emit("blocking", {});
			while (Date.now() < until) {
				// Deliberate event-loop stall, like a wedged pi instance.
			}
			emit("unblocked", {});
			return;
		}
		case "quitrace": {
			const { rmSync } = await import("node:fs");
			rmSync(node.socketPath, { force: true });
			emit("quitrace", { sock: node.socketPath });
			await node.stop();
			emit("quitraced", { sock: node.socketPath });
			process.exit(0);
			return;
		}
		case "resend_dead": {
			const first = await node.send(command["to"] ?? "", { body: command["body"] || "retry me", kind: "task" });
			lastSend = { envelope: first.envelope, targets: first.delivered };
			emit("resend_first", { delivered: first.delivered.map((peer) => peer.name) });
			return;
		}
		case "resend_now": {
			if (!lastSend) throw new Error("nothing to resend");
			const again = await node.resend(lastSend.envelope, lastSend.targets);
			emit("resend_result", {
				matched: again.matched.map((peer) => peer.name),
				delivered: again.delivered.map((peer) => peer.name),
				failed: again.failed,
			});
			return;
		}
		case "quit":
			await node.stop();
			process.exit(0);
			return;
		case "endpoint_stop":
			await node.stop();
			emit("endpoint_stopped", { name: node.name });
			return;
		default:
			emit("error", { reason: `unknown command ${command["cmd"]}` });
	}
}

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	while (buffer.includes("\n")) {
		const index = buffer.indexOf("\n");
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		run(JSON.parse(line) as Record<string, string>).catch((error: unknown) =>
			emit("error", { reason: (error as Error).message }),
		);
	}
});

process.on("SIGTERM", () => {
	void node.stop().then(() => process.exit(0));
});
