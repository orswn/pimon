import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { runAction } from "../../src/features/background/index.ts";
import { captureIdentity, captureOwner } from "../../src/features/background/identity.ts";
import { type Lease, leaseDir, readLeases, writeLease } from "../../src/features/background/leases.ts";
import { buildOptions, LIMITS } from "../../src/features/background/options.ts";
import { sweepLeases } from "../../src/features/background/recovery.ts";
import {
	createRegistry,
	logFileTaken,
	nameTaken,
	orphans,
	type Registry,
} from "../../src/features/background/registry.ts";
import { startJob } from "../../src/features/background/runner.ts";

const root = mkdtempSync(join(tmpdir(), "pimon-bg-recovery-"));
const savedDir = process.env["PI_BACKGROUND_DIR"];
const killList: number[] = [];

afterAll(() => {
	for (const pid of killList) killGroup(pid);
	if (savedDir === undefined) delete process.env["PI_BACKGROUND_DIR"];
	else process.env["PI_BACKGROUND_DIR"] = savedDir;
	rmSync(root, { recursive: true, force: true });
});

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(50);
	}
	return false;
}

function useStateDir(name: string): string {
	const dir = join(root, name);
	process.env["PI_BACKGROUND_DIR"] = dir;
	return dir;
}

const moduleUrl = (file: string) =>
	pathToFileURL(join(import.meta.dirname, "../../src/features/background", file)).href;

function startHolder(stateDir: string, logFile: string): { child: ChildProcess; ready: Promise<number> } {
	const holder = join(root, `holder-${Date.now()}.mjs`);
	writeFileSync(
		holder,
		`const { startJob } = await import(${JSON.stringify(moduleUrl("runner.ts"))});
const { createRegistry } = await import(${JSON.stringify(moduleUrl("registry.ts"))});
const { LIMITS } = await import(${JSON.stringify(moduleUrl("options.ts"))});
const reg = createRegistry(${JSON.stringify(join(root, "holder-agent"))});
const started = startJob(reg, { kind: "background", name: "crashed", command: "echo HOLDING; sleep 120", cwd: "/tmp", timeoutMs: 0, notifyExit: true, logFile: ${JSON.stringify(logFile)}, logMaxBytes: LIMITS.logMaxBytes }, "holder-session");
console.log(JSON.stringify(started.ok ? { pid: started.state.pid } : { error: started.error }));
setInterval(() => {}, 1000);
`,
	);
	const child = spawn(process.execPath, [holder], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PI_BACKGROUND_DIR: stateDir },
	});
	let out = "";
	let err = "";
	child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
	child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()));
	const ready = (async () => {
		await waitFor(() => out.includes("\n"));
		const parsed = JSON.parse(out.trim() || "{}") as { pid?: number; error?: string };
		if (parsed.pid === undefined) throw new Error(`holder failed: ${parsed.error ?? err}`);
		return parsed.pid;
	})();
	return { child, ready };
}

describe("a job owned by another pi", () => {
	let reg: Registry;
	beforeEach(() => {
		reg = createRegistry(join(root, "agent"));
	});

	it("is skipped while that pi lives and becomes a reported orphan once it is SIGKILLed", async () => {
		const stateDir = useStateDir("crash");
		const logFile = join(root, "crashed.log");
		const { child, ready } = startHolder(stateDir, logFile);
		const jobPid = await ready;
		killList.push(jobPid);
		const hostPid = child.pid ?? 0;

		expect(sweepLeases(reg)).toBeUndefined();
		expect(orphans(reg)).toHaveLength(0);
		expect(nameTaken(reg, "crashed")).toBeUndefined();
		const refused = await runAction(reg, "background", { action: "stop", name: "crashed" }, "/tmp");
		expect(refused).toBe(`"crashed" belongs to a running pi (pid ${hostPid}). Stop it from that session.`);
		expect(pidAlive(jobPid)).toBe(true);

		child.kill("SIGKILL");
		expect(await waitFor(() => !pidAlive(hostPid))).toBe(true);
		expect(pidAlive(jobPid)).toBe(true);

		const report = sweepLeases(reg);
		expect(report).toContain("crashed");
		expect(report).toContain("Nothing was killed");
		expect(pidAlive(jobPid)).toBe(true);

		const record = orphans(reg).find((entry) => entry.lease.name === "crashed");
		expect(record?.liveness).toBe("alive");
		expect(nameTaken(reg, "crashed")).toBe("orphaned");
		expect(logFileTaken(reg, logFile)).toContain("orphaned");

		const deps = {
			defaultCwd: "/tmp",
			nextId: () => 1,
			isNameTaken: (name: string) => nameTaken(reg, name),
			isLogFileTaken: (file: string) => logFileTaken(reg, file),
			activeCount: () => 0,
			dirExists: () => true,
		};
		expect(buildOptions("background", { command: "x", name: "crashed" }, deps)).toEqual(
			expect.stringContaining("orphaned"),
		);
		expect(buildOptions("background", { command: "x", logFile }, deps)).toEqual(expect.stringContaining("orphaned"));

		expect(sweepLeases(reg)).toBeUndefined();

		killGroup(jobPid);
		expect(await waitFor(() => !pidAlive(jobPid))).toBe(true);
		await sleep(200);
		expect(sweepLeases(reg)).toBeUndefined();
		expect(readdirSync(join(stateDir, "leases")).filter((file) => file.endsWith(".json"))).toHaveLength(0);
		expect(nameTaken(reg, "crashed")).toBeUndefined();
		expect(orphans(reg)).toHaveLength(0);
		expect(logFileTaken(reg, logFile)).toBeUndefined();
	});
});

describe("leases from this process and from the old extension", () => {
	function liveLease(name: string, withOwner: boolean): Lease {
		const identity = captureIdentity(process.pid);
		const owner = captureOwner();
		if (!identity || !owner) throw new Error("no /proc identity");
		return {
			version: 1,
			name,
			kind: "background",
			command: "sleep 1",
			cwd: "/tmp",
			logFile: join(root, `${name}.log`),
			createdAt: Date.now(),
			// A lease pointing at this test process is a live job whose identity verifies.
			identity,
			...(withOwner ? { owner } : {}),
		};
	}

	it("a lease owned by this process that the registry does not track is an orphan, reported once", () => {
		const stateDir = useStateDir("self-owned");
		const reg = createRegistry(join(root, "agent"));
		writeLease(liveLease("selfowned", true), leaseDir(reg.agentDir));
		const first = sweepLeases(reg);
		expect(first).toContain("selfowned");
		expect(nameTaken(reg, "selfowned")).toBe("orphaned");
		reg.orphans.clear();
		expect(sweepLeases(reg)).toBeUndefined();
		expect(readLeases(join(stateDir, "leases"))).toHaveLength(1);
	});

	it("an old-extension lease without owner is skipped while alive and deleted once dead", () => {
		const stateDir = useStateDir("no-owner");
		const reg = createRegistry(join(root, "agent"));
		const live = liveLease("legacy", false);
		const alive = writeLease(live, leaseDir(reg.agentDir));
		expect(sweepLeases(reg)).toBeUndefined();
		expect(nameTaken(reg, "legacy")).toBeUndefined();
		expect(alive && readFileSync(alive, "utf8")).toContain("legacy");

		const dead = writeLease(
			{ ...liveLease("legacydead", false), identity: { ...live.identity, pid: 999_999_997, pgid: 999_999_997 } },
			leaseDir(reg.agentDir),
		);
		expect(sweepLeases(reg)).toBeUndefined();
		const left = readdirSync(join(stateDir, "leases"));
		expect(left.some((file) => dead?.endsWith(file))).toBe(false);
		expect(left.some((file) => alive?.endsWith(file))).toBe(true);
	});
});

describe("lease write failure", () => {
	it("fails the job closed: no registration, and the child is killed with a reason in the log", async () => {
		const blockedState = useStateDir("blocked-state");
		mkdirSync(blockedState, { recursive: true });
		chmodSync(blockedState, 0o500);
		const reg = createRegistry(join(root, "agent"));
		const logFile = join(root, "unleasable.log");
		const started = startJob(reg, {
			kind: "background",
			name: "unleasable",
			command: "sleep 60",
			cwd: "/tmp",
			timeoutMs: 0,
			notifyExit: true,
			logFile,
			logMaxBytes: LIMITS.logMaxBytes,
		});
		chmodSync(blockedState, 0o700);
		expect(started.ok).toBe(false);
		const error = started.ok ? "" : started.error;
		expect(error).toContain("lease");
		expect(error).toContain("killed");
		expect(reg.active.has("unleasable")).toBe(false);
		await sleep(300);
		expect(readFileSync(logFile, "utf8")).toContain("lease could not be written");
	});
});
