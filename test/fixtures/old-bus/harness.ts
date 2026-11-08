/**
 * Dev harness: run a BusNode without pi so the transport can be tested
 * with several real processes.
 *
 *   node harness.ts <name> [labels] [--exit-after=ms]
 *
 * Prints one JSONL line per bus event on stdout.
 */

import { BusNode } from "./node.ts";
import { parseLabels } from "./registry.ts";

const [, , rawName, rawLabels, ...rest] = process.argv;
const exitAfterArg = rest.find((arg) => arg.startsWith("--exit-after="));
const exitAfter = exitAfterArg ? Number(exitAfterArg.split("=")[1]) : 0;
const sockArg = rest.find((arg) => arg.startsWith("--sock="));
const socketBase = sockArg ? sockArg.split("=")[1] : undefined;
const mute = rest.includes("--mute");
let failNudges = Number((rest.find((arg) => arg.startsWith("--fail-nudge=")) || "=0").split("=")[1]) || 0;

function emit(event: string, payload: unknown): void {
	process.stdout.write(`${JSON.stringify({ event, payload })}\n`);
}

let lastInbound: { threadId: string; from: { instanceId: string; name: string; sock: string } } | undefined;

const node = new BusNode({
	desiredName: rawName || "harness",
	labels: parseLabels(rawLabels),
	socketBase,
	log: (message) => emit("log", { message }),
	onEnvelope: async (envelope) => {
		lastInbound = { threadId: envelope.threadId, from: envelope.from };
		emit("envelope", {
			messageId: envelope.id,
			threadId: envelope.threadId,
			from: envelope.from.name,
			kind: envelope.kind,
			wake: envelope.wake,
			to: envelope.to,
			subject: envelope.subject,
			body: envelope.body,
			corrId: envelope.corrId,
			data: envelope.data,
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
		if (envelope.kind === "control" && envelope.body === "shutdown") {
			emit("shutdown", { by: envelope.from.name });
			await node.stop();
			process.exit(0);
		}
	},
	onPeerGone: (event) => emit("peer_gone", { name: event.record.name, reason: event.reason, pending: event.pending.length }),
	onPendingOverdue: (pending) => {
		if (failNudges > 0) {
			failNudges--;
			emit("nudge_rejected", { remaining: failNudges });
			throw new Error("nudge consumer is unavailable");
		}
		emit("pending_overdue", pending.map((entry) => entry.body));
	},
	onPeersChanged: (peers) => emit("peers", peers.map((peer) => `${peer.name}:${peer.state}`)),
});

await node.start();
emit("started", { name: node.name, instanceId: node.instanceId, pid: process.pid, sock: node.socketPath });

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", async (chunk) => {
	buffer += chunk;
	while (buffer.includes("\n")) {
		const index = buffer.indexOf("\n");
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		try {
			const command = JSON.parse(line) as Record<string, string>;
			await run(command);
		} catch (error) {
			emit("error", { reason: (error as Error).message });
		}
	}
});

let lastSend: { envelope: import("./protocol.ts").Envelope; targets: import("./protocol.ts").PeerRecord[] } | undefined;

async function run(command: Record<string, string>): Promise<void> {
	if (command.cmd === "peers") {
		emit("peers", node.peers(0).map((peer) => ({ name: peer.name, state: peer.state, labels: peer.labels, topics: peer.topics })));
		return;
	}
	if (command.cmd === "resolve") {
		try {
			emit("resolved", node.resolve(command.to).map((peer) => peer.name));
		} catch (error) {
			emit("resolve_error", { reason: (error as Error).message });
		}
		return;
	}
	if (command.cmd === "send") {
		try {
			const result = await node.send(command.to, {
				body: command.body || "hello",
				kind: (command.kind as never) || "note",
				wake: (command.wake as never) || "now",
				replyExpected: command.replyExpected === "true" || command.kind === "question",
				nudgeAfterMs: command.nudgeAfterMs ? Number(command.nudgeAfterMs) : undefined,
				allowEmpty: command.allowEmpty === "true",
			});
			emit("send_result", {
				matched: result.matched.map((peer) => peer.name),
				delivered: result.delivered.map((peer) => peer.name),
				unknown: result.unknown,
				failed: result.failed,
			});
		} catch (error) {
			emit("send_error", { reason: (error as Error).message });
		}
		return;
	}
	if (command.cmd === "answer") {
		const onThread = command.thread === "true";
		if (onThread && !lastInbound) {
			emit("answer_error", { reason: "no inbound envelope to answer" });
			return;
		}
		const result = await node.send(command.to, {
			body: command.body || "manual answer",
			kind: (command.kind as never) || "answer",
			corrId: command.corrId,
			threadId: onThread ? lastInbound?.threadId : undefined,
		});
		emit("answered", { delivered: result.delivered.map((peer) => peer.name), thread: onThread });
		return;
	}
	if (command.cmd === "pending") {
		emit(
			"pending",
			node.pendingQuestions().map((entry) => ({
				body: entry.body,
				outstanding: entry.targets.filter((target) => !target.answered && !target.gone).map((target) => target.name),
				answered: entry.targets.filter((target) => target.answered).map((target) => target.name),
				gone: entry.targets.filter((target) => target.gone).map((target) => target.name),
			})),
		);
		return;
	}	if (command.cmd === "probe") {
		emit("probe_result", await node.probe(command.to));
		return;
	}
	if (command.cmd === "watch") {
		for (const peer of node.resolve(command.to)) node.watch(peer);
		emit("watching", { to: command.to, names: node.watching().map((peer) => peer.name) });
		return;
	}
	if (command.cmd === "block") {
		const ms = Number(command.ms || 1000);
		emit("blocking", { ms });
		const until = Date.now() + ms;
		while (Date.now() < until) {
			// Deliberate event-loop stall modelling a wedged pi instance.
		}
		emit("unblocked", {});
		return;
	}
	if (command.cmd === "senddup") {
		const first = await node.send(command.to, { body: command.body || "dup", kind: "note" });
		const second = await node.resend(first.envelope, first.delivered);
		emit("dup_result", { first: first.acks, second: second.acks });
		return;
	}
	if (command.cmd === "sendbig") {
		try {
			await node.send(command.to, { body: "x".repeat(300 * 1024), kind: "note" });
			emit("bigsend", { rejected: false });
		} catch (error) {
			emit("bigsend", { rejected: true, reason: (error as Error).message });
		}
		return;
	}
	if (command.cmd === "subscribe") {
		node.subscribe(command.topic);
		emit("subscribed", { topic: command.topic });
		return;
	}
	if (command.cmd === "state") {
		node.setState(command.state as never, command.activity);
		emit("state", { state: node.state, activity: node.activity });
		return;
	}
	if (command.cmd === "restart") {
		const before = node.instanceId;
		await node.stop();
		await node.start();
		emit("restarted", { before, after: node.instanceId, name: node.name, sock: node.socketPath });
		return;
	}
	if (command.cmd === "endpoint_stop") {
		// Stop the bus endpoint but keep the host process alive, as an extension
		// reload does.
		await node.stop();
		emit("endpoint_stopped", { name: node.name });
		return;
	}
	if (command.cmd === "quitrace") {
		// Provoke a rebind, then tear down while the bind is in flight.
		const { rmSync } = await import("node:fs");
		try {
			rmSync(node.socketPath);
		} catch {
			// Already gone.
		}
		emit("quitrace", { sock: node.socketPath });
		await node.stop();
		emit("quitraced", { sock: node.socketPath });
		process.exit(0);
	}
	if (command.cmd === "resend_dead") {
		const first = await node.send(command.to, { body: command.body || "retry me", kind: "task" });
		emit("resend_first", { delivered: first.delivered.map((peer) => peer.name) });
		lastSend = { envelope: first.envelope, targets: first.delivered };
		return;
	}
	if (command.cmd === "resend_now") {
		if (!lastSend) {
			emit("error", { reason: "nothing to resend" });
			return;
		}
		const again = await node.resend(lastSend.envelope, lastSend.targets);
		emit("resend_result", {
			matched: again.matched.map((peer) => peer.name),
			delivered: again.delivered.map((peer) => peer.name),
			failed: again.failed,
		});
		return;
	}
	if (command.cmd === "quit") {
		await node.stop();
		process.exit(0);
	}
	emit("error", { reason: `unknown command ${command.cmd}` });
}

if (exitAfter > 0) {
	setTimeout(() => {
		emit("exit_after", { ms: exitAfter });
		process.exit(0);
	}, exitAfter).unref?.();
}

process.on("SIGTERM", async () => {
	await node.stop();
	process.exit(0);
});
