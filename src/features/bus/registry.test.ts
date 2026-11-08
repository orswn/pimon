import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { PeerRecord } from "./protocol.ts";
import {
	type BusDirs,
	busDirs,
	ensureDirs,
	loserOfNameConflict,
	ownsSocketPath,
	pickName,
	pidBirth,
	scanPeers,
	socketPathFor,
	writePresence,
} from "./registry.ts";

const ID = "0123456789abcdef0123456789abcdef";
let root: string;
let dirs: BusDirs;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bus-registry-"));
	dirs = ensureDirs(busDirs(root));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function record(extra: Partial<PeerRecord> = {}): PeerRecord {
	return {
		instanceId: ID,
		owner: "f".repeat(32),
		name: "peer",
		pid: process.pid,
		cwd: "/",
		sock: join(dirs.socks, `${ID}.sock`),
		labels: {},
		protocol: 1,
		host: "h",
		topics: [],
		state: "idle",
		startedAt: 1,
		heartbeatAt: Date.now(),
		pidBirth: pidBirth(process.pid),
		...extra,
	};
}

describe("bus registry", () => {
	it("defaults to <agentDir>/bus and honors an override", () => {
		expect(busDirs("/agent").base).toBe("/agent/bus");
		expect(busDirs("/agent", "/elsewhere").peers).toBe("/elsewhere/peers");
	});

	it("keeps a live peer and reaps a dead or recycled one", () => {
		writePresence(record(), dirs);
		expect(scanPeers(dirs).map((peer) => peer.instanceId)).toEqual([ID]);
		const deadSock = join(dirs.socks, `${"1".repeat(32)}.sock`);
		writeFileSync(deadSock, "");
		writePresence(record({ instanceId: "1".repeat(32), pid: 2 ** 22 + 1, sock: deadSock }), dirs);
		writePresence(record({ instanceId: "2".repeat(32), pidBirth: "1" }), dirs);
		expect(scanPeers(dirs).map((peer) => peer.instanceId)).toEqual([ID]);
		expect(readdirSync(dirs.peers)).toEqual([`${ID}.json`]);
		expect(readdirSync(dirs.socks)).toEqual([]);
	});

	it("marks a late heartbeat as stale but keeps the peer", () => {
		writePresence(record({ heartbeatAt: Date.now() - 60_000 }), dirs);
		expect(scanPeers(dirs)[0]?.stale).toBe(true);
	});

	it("drops a record whose file name does not match its id", () => {
		writeFileSync(join(dirs.peers, `${"3".repeat(32)}.json`), JSON.stringify(record()));
		expect(scanPeers(dirs)).toEqual([]);
	});

	it("picks a free name and lets the earlier peer keep a shared name", () => {
		const other = record({ instanceId: "4".repeat(32), name: "peer", startedAt: 0 });
		expect(pickName("Peer", ID, [other])).toBe("peer-2");
		expect(pickName("peer", ID, [])).toBe("peer");
		expect(loserOfNameConflict(record({ startedAt: 5 }), [other])).toBe(true);
		expect(loserOfNameConflict(record({ startedAt: 0 }), [{ ...other, startedAt: 9 }])).toBe(false);
	});

	it("falls back to a short socket dir when the path is over 100 bytes", () => {
		const deep = busDirs(join(root, "x".repeat(80)));
		const path = socketPathFor(ID, deep);
		expect(path.startsWith(deep.socks)).toBe(false);
		expect(path.endsWith(`/${ID}.sock`)).toBe(true);
		expect(socketPathFor(ID, dirs)).toBe(join(dirs.socks, `${ID}.sock`));
	});

	it("accepts only a socket named by the full id with an optional short suffix", () => {
		expect(ownsSocketPath(ID, `/s/${ID}.sock`)).toBe(true);
		expect(ownsSocketPath(ID, `/s/${ID}-r2.sock`)).toBe(true);
		expect(ownsSocketPath(ID, `/s/${ID.slice(0, 12)}.sock`)).toBe(false);
		expect(ownsSocketPath(ID, `/s/${ID}-toolongsuffix.sock`)).toBe(false);
		expect(ownsSocketPath("not-an-id", "/s/not-an-id.sock")).toBe(false);
	});
});
