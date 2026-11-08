import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { runAction } from "../../src/features/background/index.ts";
import { captureIdentity, captureOwner } from "../../src/features/background/identity.ts";
import { type Lease, leaseDir, writeLease } from "../../src/features/background/leases.ts";
import { sweepLeases } from "../../src/features/background/recovery.ts";
import { createRegistry, findJob, type Registry } from "../../src/features/background/registry.ts";
import { shutdownJobs } from "../../src/features/background/runner.ts";

type Kind = "background" | "monitor";

const root = mkdtempSync(join(tmpdir(), "pimon-bg-status-"));
const savedDir = process.env["PI_BACKGROUND_DIR"];
let reg: Registry;
let seq = 0;

beforeAll(() => {
	process.env["PI_BACKGROUND_DIR"] = join(root, "state");
});

afterAll(() => {
	if (savedDir === undefined) delete process.env["PI_BACKGROUND_DIR"];
	else process.env["PI_BACKGROUND_DIR"] = savedDir;
	rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
	await shutdownJobs(reg);
});

function freshRegistry(): Registry {
	seq += 1;
	process.env["PI_BACKGROUND_DIR"] = join(root, `state-${seq}`);
	reg = createRegistry(join(root, `agent-${seq}`));
	reg.emit = () => undefined;
	return reg;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await sleep(25);
	}
}

async function textOf(result: ReturnType<typeof runAction>): Promise<string> {
	const value = await result;
	if (typeof value !== "string") throw new Error(`expected text, got ${JSON.stringify(value)}`);
	return value;
}

const status = (kind: Kind, name: string) => textOf(runAction(reg, kind, { action: "status", name }, root));

async function startJob(kind: Kind, name: string, command: string): Promise<void> {
	const params = { action: "start", name, command, timeoutMs: 0, ...(kind === "monitor" ? { match: "NEVER" } : {}) };
	const started = await textOf(runAction(reg, kind, params, root));
	expect(started).toContain(`"${name}"`);
}

const optionsLine: Record<Kind, string> = {
	background: "timeoutMs=0; notifyExit=true",
	monitor: 'match="NEVER" (literal); streams=stdout; once=false; debounceMs=250; maxPerMinute=20; timeoutMs=0',
};

describe.each(["background", "monitor"] as const)("%s status", (kind) => {
	it("describes a running job with its pid, identity, and output", async () => {
		freshRegistry();
		await startJob(kind, "live", "echo LIVE-OUT; sleep 30");
		const state = findJob(reg, "live");
		await waitFor(() => (state?.totalLines ?? 0) >= 1);
		const lines = (await status(kind, "live")).split("\n");
		expect(lines[0]).toBe(`live [${kind}] running`);
		expect(lines[1]).toMatch(/^Runtime: \S+$/);
		expect(lines.slice(2)).toEqual([
			`Pid: ${state?.pid}`,
			"Command: echo LIVE-OUT; sleep 30",
			`Cwd: ${root}`,
			optionsLine[kind],
			"Lines captured: 1",
			`Log: ${state?.sink.path} (${state?.sink.written} bytes this file)`,
			"Identity: alive, identity verified",
			"Output (1 line(s)):",
			"```text",
			"LIVE-OUT",
			"```",
		]);
	});

	it("describes an exited job with its exit status and no identity", async () => {
		freshRegistry();
		await startJob(kind, "done", "echo DONE-OUT; exit 3");
		const state = findJob(reg, "done");
		await waitFor(() => state?.exitedAt !== undefined);
		const lines = (await status(kind, "done")).split("\n");
		expect(lines[0]).toBe(`done [${kind}] exit code 3`);
		expect(lines[1]).toMatch(/^Runtime: \S+ \(finished\)$/);
		expect(lines.slice(2)).toEqual([
			`Pid: ${state?.pid}`,
			"Command: echo DONE-OUT; exit 3",
			`Cwd: ${root}`,
			optionsLine[kind],
			"Lines captured: 1",
			`Log: ${state?.sink.path} (${state?.sink.written} bytes this file)`,
			"Output (1 line(s)):",
			"```text",
			"DONE-OUT",
			"```",
		]);
	});

	it("describes an orphan from its lease", async () => {
		const registry = freshRegistry();
		const identity = captureIdentity(process.pid);
		const owner = captureOwner();
		if (!identity || !owner) throw new Error("no /proc identity");
		// A lease that points at this test process is a live job whose identity verifies.
		const lease: Lease = {
			version: 1,
			name: "left",
			kind,
			command: "sleep 1",
			cwd: "/tmp",
			logFile: join(root, `left-${seq}.log`),
			createdAt: Date.parse("2026-01-02T03:04:05.000Z"),
			identity,
			owner,
		};
		writeLease(lease, leaseDir(registry.agentDir));
		expect(sweepLeases(registry)).toContain("left");
		expect((await status(kind, "left")).split("\n")).toEqual([
			`left [${kind}] orphaned; capture unavailable`,
			"Liveness: alive, identity verified",
			`Pid: ${identity.pid} (pgid ${identity.pgid})`,
			"Command: sleep 1",
			"Cwd: /tmp",
			"Started: 2026-01-02T03:04:05.000Z",
			`Log: ${lease.logFile}`,
			"An earlier pi started this. Its stdout and stderr cannot be reattached, so there will be no exit digest.",
		]);
	});

	it("names the known jobs for an unknown name", async () => {
		freshRegistry();
		expect(await status(kind, "ghost")).toBe(
			'No job or monitor named "ghost". Nothing is running and no earlier job left a log.',
		);
		await startJob(kind, "real", "sleep 30");
		expect(await status(kind, "ghost")).toBe('No job or monitor named "ghost". Known names: real.');
		expect(await status(kind, "")).toBe("status requires name");
	});
});
