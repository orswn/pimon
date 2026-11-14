import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { captureIdentity } from "./identity.ts";
import { deleteLease, type Lease, leaseDir, pruneTempLeases, readLeases, validateLease, writeLease } from "./leases.ts";

const root = mkdtempSync(join(tmpdir(), "pimon-leases-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const complete = {
	version: 1,
	name: "v",
	kind: "background",
	command: "x",
	cwd: "/tmp",
	logFile: "/tmp/v.log",
	createdAt: Date.now(),
	identity: { bootId: "b", pid: 5, pgid: 5, startTicks: 9 },
};

describe("lease files", () => {
	// Each test gets its own lease dir path. The dir does not exist yet.
	const newDir = () => join(mkdtempSync(join(root, "case-")), "leases");
	const identity = captureIdentity(process.pid);
	if (!identity) throw new Error("no /proc identity");
	const lease: Lease = {
		version: 1,
		name: "leasetest",
		kind: "background",
		command: "sleep 1",
		cwd: "/tmp",
		logFile: join(root, "leasetest.log"),
		createdAt: Date.now(),
		identity,
	};

	it("writes a lease, leaves no temp file, and reads it back", () => {
		const dir = newDir();
		const file = writeLease(lease, dir);
		expect(file !== undefined && existsSync(file)).toBe(true);
		expect(readdirSync(dir).every((entry) => !entry.endsWith(".tmp"))).toBe(true);
		const read = readLeases(dir);
		expect(read).toHaveLength(1);
		expect(read[0]?.lease?.name).toBe("leasetest");
		expect(read[0]?.lease?.identity.startTicks).toBe(identity.startTicks);
		deleteLease(file);
		expect(file !== undefined && existsSync(file)).toBe(false);
		expect(() => deleteLease(file)).not.toThrow();
	});

	it("reports malformed and partial leases and never deletes them", () => {
		const dir = newDir();
		mkdirSync(dir);
		writeFileSync(join(dir, "broken.json"), "{ not json");
		writeFileSync(join(dir, "halfwritten.json"), JSON.stringify({ version: 1, name: "x" }));
		writeFileSync(join(dir, "nopgid.json"), JSON.stringify({ ...complete, identity: { pid: 5, startTicks: 9 } }));
		const mixed = readLeases(dir);
		expect(mixed.find((entry) => entry.file.endsWith("broken.json"))?.error).toBeDefined();
		expect(mixed.find((entry) => entry.file.endsWith("halfwritten.json"))?.error).toContain("command");
		const nopgid = mixed.find((entry) => entry.file.endsWith("nopgid.json"));
		expect(nopgid?.lease).toBeUndefined();
		expect(nopgid?.error).toContain("pgid");
		expect(existsSync(join(dir, "broken.json"))).toBe(true);
		expect(existsSync(join(dir, "nopgid.json"))).toBe(true);
	});

	it("prunes only stale temp files", () => {
		const dir = newDir();
		mkdirSync(dir);
		writeFileSync(join(dir, "stale.tmp"), "x");
		expect(pruneTempLeases(dir, 60_000)).toBe(0);
		expect(pruneTempLeases(dir, -1)).toBeGreaterThanOrEqual(1);
	});

	it("a missing lease dir reads as empty", () => {
		expect(readLeases(join(root, "nowhere"))).toHaveLength(0);
	});

	it("lives under the agent dir unless PI_BACKGROUND_DIR overrides it", () => {
		const saved = process.env["PI_BACKGROUND_DIR"];
		delete process.env["PI_BACKGROUND_DIR"];
		expect(leaseDir("/agent")).toBe("/agent/background/leases");
		process.env["PI_BACKGROUND_DIR"] = "/state";
		expect(leaseDir("/agent")).toBe("/state/leases");
		if (saved === undefined) delete process.env["PI_BACKGROUND_DIR"];
		else process.env["PI_BACKGROUND_DIR"] = saved;
	});
});

describe("validateLease", () => {
	it("accepts a complete lease with or without an owner", () => {
		expect(validateLease(complete)).toBeUndefined();
		expect(validateLease({ ...complete, owner: { pid: 7, startTicks: 3, bootId: "b" } })).toBeUndefined();
		expect(validateLease({ ...complete, owner: { pid: 7, startTicks: 3 } })).toBeUndefined();
	});

	it.each([
		["version", { ...complete, version: 2 }],
		["name", { ...complete, name: "" }],
		["kind", { ...complete, kind: "other" }],
		["command", { ...complete, command: 42 }],
		["cwd", { ...complete, cwd: undefined }],
		["logFile", { ...complete, logFile: "" }],
		["createdAt", { ...complete, createdAt: -1 }],
		["identity", { ...complete, identity: undefined }],
		["identity.pid", { ...complete, identity: { ...complete.identity, pid: 0 } }],
		["identity.pid non-integer", { ...complete, identity: { ...complete.identity, pid: 1.5 } }],
		["identity.pgid", { ...complete, identity: { pid: 5, startTicks: 9 } }],
		["identity.startTicks", { ...complete, identity: { ...complete.identity, startTicks: undefined } }],
		["identity.bootId", { ...complete, identity: { ...complete.identity, bootId: 7 } }],
		["owner", { ...complete, owner: "me" }],
		["owner.pid", { ...complete, owner: { pid: 0, startTicks: 3 } }],
		["owner.startTicks", { ...complete, owner: { pid: 7 } }],
		["owner.bootId", { ...complete, owner: { pid: 7, startTicks: 3, bootId: "" } }],
	])("rejects a lease with a bad %s", (_label, candidate) => {
		expect(typeof validateLease(candidate)).toBe("string");
	});

	it("rejects a non-object lease", () => {
		expect(typeof validateLease("nope")).toBe("string");
	});
});
