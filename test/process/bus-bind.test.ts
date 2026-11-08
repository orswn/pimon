import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BusNode } from "../../src/features/bus/node.ts";
import { HEARTBEAT_MS } from "../../src/features/bus/protocol.ts";
import { busDirs } from "../../src/features/bus/registry.ts";

describe("bus bind errors", () => {
	let root: string;
	const nodes: BusNode[] = [];
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bus-bind-"));
	});
	afterEach(async () => {
		for (const node of nodes.splice(0)) await node.stop();
		rmSync(root, { recursive: true, force: true });
	});

	it("fails at once with the error code when the bind error is not an occupied path", async () => {
		const node = new BusNode({
			owner: randomUUID(),
			desiredName: "worker",
			dirs: busDirs("", join(root, "bus")),
			socketBase: join(root, "missing", "worker.sock"),
			onEnvelope: () => {},
		});
		const started = Date.now();
		await expect(node.start()).rejects.toThrow(/^cannot bind .*: E[A-Z]+$/);
		expect(Date.now() - started).toBeLessThan(500);
		expect(node.isStarted).toBe(false);
	});

	it("binds its socket again within one heartbeat after the bus dir is removed", async () => {
		const node = new BusNode({
			owner: randomUUID(),
			desiredName: "worker",
			dirs: busDirs("", join(root, "bus")),
			onEnvelope: () => {},
		});
		nodes.push(node);
		await node.start();
		rmSync(join(root, "bus"), { recursive: true, force: true });
		const deadline = Date.now() + HEARTBEAT_MS + 1_000;
		while (!existsSync(node.socketPath) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(existsSync(node.socketPath)).toBe(true);
	}, 15_000);
});
