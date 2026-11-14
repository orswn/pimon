import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { closeHookPath, writeCloseHook } from "./placement.ts";
import { type ChildRecord, ChildRecords } from "./records.ts";
import {
	type AgentPaths,
	agentPaths,
	parseSpawnEntry,
	pidFilePath,
	readPidFile,
	type SpawnFile,
	spawnEntry,
	spawnFilePath,
	takeSpawnFile,
	writePidFile,
	writeSpawnFile,
} from "./spawn-file.ts";

const DATA: SpawnFile = {
	version: 2,
	spawnId: "spawn-1",
	role: { name: "worker", prompt: "You work." },
	parent: { name: "boss", id: "a".repeat(32) },
	child: { name: "w1", labels: { depth: "1" }, tools: ["read", "pi_bus"] },
	firstTask: { messageId: "m-1" },
	createdAt: 1,
};

const record = (spawnId: string, kind: ChildRecord["placement"]["kind"] = "herdr"): ChildRecord => ({
	spawnId,
	name: spawnId,
	role: "worker",
	task: "t",
	cwd: "/tmp",
	placement: { kind, handle: "h", layout: "tab", detail: "" },
	launchedAt: 1,
	launchedBy: "me",
});

describe("spawn file", () => {
	let root: string;
	let paths: AgentPaths;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "spawn-"));
		paths = agentPaths(join(root, "agents"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("lives in private dirs with a private mode", () => {
		const path = writeSpawnFile(paths, DATA);
		expect(path).toBe(spawnFilePath(paths, "spawn-1"));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(paths.spawn).mode & 0o777).toBe(0o700);
		expect(statSync(paths.root).mode & 0o777).toBe(0o700);
	});

	it("is deleted when the child reads it, and is absent for a session that was not spawned", () => {
		const path = writeSpawnFile(paths, DATA);
		expect(takeSpawnFile(path)).toEqual({ data: DATA });
		expect(existsSync(path)).toBe(false);
		expect(takeSpawnFile(path)).toBeUndefined();
	});

	it("is deleted even when it is bad", () => {
		mkdirSync(paths.spawn, { recursive: true });
		const bad = join(paths.spawn, "bad.json");
		writeFileSync(bad, JSON.stringify({ ...DATA, firstTask: undefined }), { mode: 0o600 });
		expect(takeSpawnFile(bad)).toEqual({ error: `spawn file ${bad}: firstTask is missing` });
		expect(existsSync(bad)).toBe(false);
		writeFileSync(bad, "{", { mode: 0o600 });
		expect(takeSpawnFile(bad)).toEqual({ error: `spawn file ${bad} is not valid JSON` });
		expect(takeSpawnFile(bad)).toBeUndefined();
	});

	it("refuses a root that other users can enter", () => {
		mkdirSync(paths.root, { mode: 0o755 });
		chmodSync(paths.root, 0o755);
		expect(() => writeSpawnFile(paths, DATA)).toThrow("is not private");
		expect(() => writeCloseHook(paths, "spawn-1")).toThrow("is not private");
		expect(() => new ChildRecords(paths).save(record("spawn-1"))).toThrow("is not private");
		expect(existsSync(spawnFilePath(paths, "spawn-1"))).toBe(false);
	});

	it("refuses a root or a sub dir that is a symlink", () => {
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		symlinkSync(elsewhere, paths.root);
		expect(() => writeSpawnFile(paths, DATA)).toThrow("is not private");
		rmSync(paths.root);
		mkdirSync(paths.root, { mode: 0o700 });
		symlinkSync(elsewhere, paths.spawn);
		expect(() => writeSpawnFile(paths, DATA)).toThrow("is not private");
	});

	it("refuses to read a spawn file that others can read or that is a symlink", () => {
		const path = writeSpawnFile(paths, DATA);
		chmodSync(path, 0o644);
		expect(takeSpawnFile(path)).toMatchObject({ error: expect.stringContaining("is not private") });
		const target = join(root, "target.json");
		writeFileSync(target, JSON.stringify(DATA), { mode: 0o600 });
		const link = spawnFilePath(paths, "linked");
		symlinkSync(target, link);
		expect(takeSpawnFile(link)).toMatchObject({ error: expect.stringContaining("cannot read spawn file") });
		expect(existsSync(target)).toBe(true);
	});

	it("leaves the first task out of the session entry and reads an old entry", () => {
		const entry = spawnEntry(DATA);
		expect(JSON.stringify(entry)).not.toContain("m-1");
		expect(parseSpawnEntry(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
		expect(parseSpawnEntry({ version: 3 })).toBeUndefined();
		const old = { ...entry, version: 1, parent: { name: "boss", owner: "b".repeat(32) } };
		expect(parseSpawnEntry(old)).toEqual({ ...entry, parent: { name: "boss", id: "b".repeat(32) } });
	});

	it("keeps the child pid in a private file", () => {
		writePidFile(paths, "spawn-1", { pid: 42, birth: "7" });
		expect(statSync(pidFilePath(paths, "spawn-1")).mode & 0o777).toBe(0o600);
		expect(readPidFile(paths, "spawn-1")).toEqual({ pid: 42, birth: "7" });
		expect(readPidFile(paths, "spawn-2")).toBeUndefined();
	});
});

describe("child records", () => {
	let root: string;
	let paths: AgentPaths;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "records-"));
		paths = agentPaths(join(root, "agents"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("loads a record and skips a torn file", () => {
		mkdirSync(paths.state, { recursive: true });
		writeFileSync(join(paths.state, "old.json"), JSON.stringify(record("old")));
		writeFileSync(join(paths.state, "torn.json"), "{");
		const records = new ChildRecords(paths);
		expect(records.mine("me").map((entry) => entry.spawnId)).toEqual(["old"]);
	});

	it("deletes every per-spawn file on forget", () => {
		const records = new ChildRecords(paths);
		records.save(record("spawn-1"));
		writeSpawnFile(paths, DATA);
		writePidFile(paths, "spawn-1", { pid: 42 });
		writeCloseHook(paths, "spawn-1");
		expect(statSync(join(paths.state, "spawn-1.json")).mode & 0o777).toBe(0o600);
		records.forget("spawn-1");
		expect(records.all()).toEqual([]);
		expect(existsSync(spawnFilePath(paths, "spawn-1"))).toBe(false);
		expect(existsSync(pidFilePath(paths, "spawn-1"))).toBe(false);
		expect(existsSync(closeHookPath(paths, "spawn-1"))).toBe(false);
	});
});
