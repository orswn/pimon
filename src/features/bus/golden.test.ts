import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { BusNode } from "./node.ts";
import type { Envelope, PeerRecord } from "./protocol.ts";
import { type BusDirs, busDirs, ensureDirs, pidBirth, scanPeers, writePresence } from "./registry.ts";
import { BusStore, historyPath } from "./store.ts";

// Synthetic values in the exact key order that the standalone bus writes.
const OLD_REF = {
	instanceId: "0a1b2c3d-4e5f-4071-8293-a4b5c6d7e8f9",
	owner: "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a",
	name: "box-1a2b3c",
	pid: 0,
	cwd: "/work",
	sock: "",
	labels: { role: "reviewer", cwd: "/work" },
};
const OLD_RECORD_KEYS = [
	"instanceId",
	"owner",
	"name",
	"pid",
	"cwd",
	"sock",
	"labels",
	"protocol",
	"host",
	"topics",
	"state",
	"activity",
	"startedAt",
	"heartbeatAt",
	"pidBirth",
	"sessionFile",
	"session",
	"model",
];
const OLD_ENVELOPE_KEYS = [
	"v",
	"id",
	"threadId",
	"corrId",
	"replyExpected",
	"from",
	"to",
	"kind",
	"priority",
	"wake",
	"subject",
	"body",
	"data",
	"createdAt",
	"expiresAt",
];
const OLD_ENVELOPE = {
	v: 1,
	id: "c0ffee00-1111-4222-8333-444455556666",
	threadId: "7a7a7a7a-1111-4222-8333-444455556666",
	replyExpected: true,
	from: OLD_REF,
	to: "owner:aaaaaaaaaaaa",
	kind: "question",
	priority: "normal",
	wake: "now",
	subject: "Review",
	body: "Please review.",
	createdAt: 1_700_000_000_000,
};

let root: string;
let dirs: BusDirs;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bus-golden-"));
	dirs = ensureDirs(busDirs(root));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("standalone bus formats", () => {
	it("reads an old peer record", () => {
		const sock = join(dirs.socks, `${OLD_REF.instanceId}.sock`);
		const record = {
			...OLD_REF,
			pid: process.pid,
			sock,
			protocol: 1,
			host: "box",
			topics: ["build"],
			state: "idle",
			startedAt: 1,
			heartbeatAt: Date.now(),
			pidBirth: pidBirth(process.pid),
			session: "1a2b3c",
		};
		writeFileSync(join(dirs.peers, `${OLD_REF.instanceId}.json`), `${JSON.stringify(record)}\n`);
		expect(scanPeers(dirs)).toEqual([record]);
	});

	it("reads an old history line", () => {
		const path = historyPath("/sessions/a.jsonl", dirs);
		writeFileSync(path, `${JSON.stringify({ direction: "in", envelope: OLD_ENVELOPE })}\n`);
		const store = new BusStore("/sessions/a.jsonl", dirs);
		store.load();
		expect(store.inbox).toEqual([OLD_ENVELOPE]);
		expect(store.find("c0ffee00")?.id).toBe(OLD_ENVELOPE.id);
	});

	it("writes the same record, envelope, and history keys", () => {
		const node = new BusNode({
			owner: OLD_REF.owner,
			desiredName: "box",
			dirs,
			sessionFile: "/sessions/a.jsonl",
			session: "1a2b3c",
			model: "m",
			onEnvelope: () => {},
		});
		writePresence(node.record, dirs);
		const written = JSON.parse(readFileSync(join(dirs.peers, `${node.instanceId}.json`), "utf8")) as PeerRecord;
		const expected = OLD_RECORD_KEYS.filter((key) => key !== "activity");
		expect(Object.keys(written)).toEqual(expected);
		expect(Object.keys(node.record)).toEqual(OLD_RECORD_KEYS);
		const envelope = node.buildEnvelope("all", { body: "x" });
		expect(Object.keys(envelope)).toEqual(OLD_ENVELOPE_KEYS);
		const store = new BusStore("/sessions/a.jsonl", dirs);
		store.addOutbound(envelope);
		const line = JSON.parse(readFileSync(historyPath("/sessions/a.jsonl", dirs), "utf8").trim()) as {
			envelope: Envelope;
		};
		expect(Object.keys(line)).toEqual(["direction", "envelope"]);
		expect(Object.keys(line.envelope)).toEqual(Object.keys(JSON.parse(JSON.stringify(envelope)) as object));
	});
});
