import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BusNode } from "../../src/features/bus/node.ts";
import { HEARTBEAT_MS } from "../../src/features/bus/protocol.ts";
import { type BusDirs, busDirs, readPeers } from "../../src/features/bus/registry.ts";

describe("bus presence writes", () => {
	let root: string;
	let dirs: BusDirs;
	let node: BusNode;

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		root = mkdtempSync(join(tmpdir(), "bus-presence-"));
		dirs = busDirs("", join(root, "bus"));
		node = new BusNode({ owner: randomUUID(), desiredName: "worker", dirs, onEnvelope: () => {} });
		await node.start();
	});

	afterEach(async () => {
		await node.stop({ announce: false });
		vi.useRealTimers();
		rmSync(root, { recursive: true, force: true });
	});

	const presence = () => readPeers(dirs).find((peer) => peer.instanceId === node.instanceId);

	it("writes the presence file on a state change, and leaves a new activity to the heartbeat", () => {
		node.setState("busy", "bash");
		expect(presence()).toMatchObject({ state: "busy", activity: "bash" });

		node.setState("busy", "read");
		expect(presence()).toMatchObject({ state: "busy", activity: "bash" });
		expect(node.activity).toBe("read");

		vi.advanceTimersByTime(HEARTBEAT_MS);
		expect(presence()).toMatchObject({ state: "busy", activity: "read" });

		node.setState("idle");
		expect(presence()?.state).toBe("idle");
		expect(presence()?.activity).toBeUndefined();
	});
});
