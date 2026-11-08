import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BusNode } from "./node.ts";
import { type BusDirs, busDirs, ensureDirs, pidBirth, writePresence } from "./registry.ts";

let root: string;
let dirs: BusDirs;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bus-node-"));
	dirs = ensureDirs(busDirs(root));
	vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});

describe("bus node peer list", () => {
	it("rescans on a zero max age even within the same millisecond", () => {
		const node = new BusNode({ owner: "o", desiredName: "self", dirs, onEnvelope: () => {} });
		expect(node.peers(0)).toEqual([]);
		const id = "5b1d2c3e-4f50-4a61-8b72-c3d4e5f60718";
		writePresence(
			{
				instanceId: id,
				owner: "6c2e3d4f-5061-4b72-9c83-d4e5f6071829",
				name: "late",
				pid: process.pid,
				cwd: "/",
				sock: join(dirs.socks, `${id.replace(/-/g, "")}.sock`),
				labels: {},
				protocol: 1,
				host: "h",
				topics: [],
				state: "idle",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				pidBirth: pidBirth(process.pid),
			},
			dirs,
		);
		expect(node.peers(0).map((peer) => peer.name)).toEqual(["late"]);
		expect(node.resolve("name:late")).toHaveLength(1);
	});
});
