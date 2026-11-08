import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { runAction } from "../../src/features/background/index.ts";
import { createRegistry, findJob, type Registry } from "../../src/features/background/registry.ts";
import { shutdownJobs } from "../../src/features/background/runner.ts";

const root = mkdtempSync(join(tmpdir(), "pimon-bg-inline-"));
const savedDir = process.env["PI_BACKGROUND_DIR"];
let reg: Registry;
let emitted: string[] = [];
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
	emitted = [];
	reg.emit = (_state, text) => emitted.push(text);
	return reg;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await sleep(25);
	}
}

async function start(
	kind: "background" | "monitor",
	params: Record<string, unknown>,
	options: { inlineWaitMs?: number; signal?: AbortSignal } = {},
	cwd = root,
): Promise<string> {
	const result = await runAction(reg, kind, { action: "start", timeoutMs: 0, ...params }, cwd, options);
	if (typeof result !== "string") throw new Error(`expected text, got ${JSON.stringify(result)}`);
	return result;
}

const leaseFiles = () => {
	try {
		return readdirSync(join(root, `state-${seq}`, "leases")).filter((file) => file.endsWith(".json"));
	} catch {
		return [];
	}
};

describe("background start result", () => {
	it("names the job, pid, log, and wake without the command, cwd, or lifetime note", async () => {
		freshRegistry();
		const text = await start("background", { name: "quiet", command: "sleep 30" });
		const state = findJob(reg, "quiet");
		expect(text).toBe(
			[
				`Started background "quiet" (pid ${state?.pid}).`,
				`Log: ${state?.options.logFile}`,
				"You will be woken once when it exits.",
			].join("\n"),
		);
	});

	it("shows the cwd only when it differs from the session cwd", async () => {
		freshRegistry();
		const text = await start("background", { name: "elsewhere", command: "sleep 30", cwd: "/tmp" });
		expect(text.split("\n")[1]).toBe("Cwd: /tmp");
	});

	it("keeps the timeout in the wake line and marks a silent job", async () => {
		freshRegistry();
		const timed = await start("background", { name: "timed", command: "sleep 30", timeoutMs: 120_000 });
		expect(timed.split("\n").at(-1)).toBe("You will be woken once when it exits, or after 2m.");
		const silent = await start("background", { name: "silent", command: "sleep 30", notifyExit: false });
		expect(silent.split("\n").at(-1)).toBe("Silent job: no wake on exit.");
	});

	it("starts a monitor with its watch line and no command echo", async () => {
		freshRegistry();
		const text = await start("monitor", { name: "watch", command: "sleep 30", match: "READY" });
		const state = findJob(reg, "watch");
		expect(text).toBe(
			[
				`Started monitor "watch" (pid ${state?.pid}).`,
				`Log: ${state?.options.logFile}`,
				'Watching stdout for "READY" as a literal.',
			].join("\n"),
		);
	});
});

describe("background inline wait", () => {
	it("returns the exit digest of a job that ends in time and sends no wake", async () => {
		freshRegistry();
		const text = await start("background", { name: "fast", command: "echo FAST-OUT; exit 2" }, { inlineWaitMs: 5_000 });
		const state = findJob(reg, "fast");
		expect(text.split("\n")[0]).toMatch(/^Background job "fast" ended: exit code 2 after \d+ms\.$/);
		expect(text).toContain("FAST-OUT");
		expect(text.split("\n").at(-1)).toBe(`Full log: ${state?.sink.path}`);
		expect(state?.exitStatus).toBe("exit code 2");
		expect(leaseFiles()).toEqual([]);
		await sleep(200);
		expect(emitted).toEqual([]);
	});

	it("returns the start text for a job that runs longer and wakes once on exit", async () => {
		freshRegistry();
		const text = await start(
			"background",
			{ name: "slow", command: "sleep 0.8; echo SLOW-OUT" },
			{ inlineWaitMs: 200 },
		);
		expect(text.split("\n")[0]).toMatch(/^Started background "slow" \(pid \d+\)\.$/);
		await waitFor(() => emitted.length > 0);
		await sleep(200);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toContain('Background job "slow" ended: exit code 0');
		expect(emitted[0]).toContain("SLOW-OUT");
	});

	it("stops waiting at once when the tool call is aborted, and wakes on the later exit", async () => {
		freshRegistry();
		const abort = new AbortController();
		setTimeout(() => abort.abort(), 150);
		const began = Date.now();
		const text = await start(
			"background",
			{ name: "aborted", command: "sleep 1; echo LATE" },
			{ inlineWaitMs: 30_000, signal: abort.signal },
		);
		expect(Date.now() - began).toBeLessThan(900);
		expect(text.split("\n")[0]).toMatch(/^Started background "aborted"/);
		expect(findJob(reg, "aborted")?.exitedAt).toBeUndefined();
		await waitFor(() => emitted.length > 0);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toContain("LATE");
	});

	it("does not wait when inlineWaitMs is 0", async () => {
		freshRegistry();
		const text = await start("background", { name: "nowait", command: "true" }, { inlineWaitMs: 0 });
		expect(text.split("\n")[0]).toMatch(/^Started background "nowait"/);
		await waitFor(() => emitted.length > 0);
		expect(emitted).toHaveLength(1);
	});

	it("returns the start text for a silent job that ends in time", async () => {
		freshRegistry();
		const text = await start(
			"background",
			{ name: "hush", command: "true", notifyExit: false },
			{ inlineWaitMs: 5_000 },
		);
		expect(text.split("\n")[0]).toMatch(/^Started background "hush"/);
		expect(findJob(reg, "hush")?.exitedAt).toBeDefined();
		expect(emitted).toEqual([]);
	});

	it("names the command in the wake digest of a job with a generated name", async () => {
		freshRegistry();
		await start("background", { command: "sleep 0.3; echo ANON" }, { inlineWaitMs: 0 });
		await start("background", { name: "given", command: "sleep 0.3; echo GIVEN" }, { inlineWaitMs: 0 });
		await waitFor(() => emitted.length === 2);
		const anon = emitted.find((text) => text.includes("ANON")) ?? "";
		const given = emitted.find((text) => text.includes("GIVEN")) ?? "";
		expect(anon.split("\n")[1]).toBe("Command: sleep 0.3; echo ANON");
		expect(given).not.toContain("Command:");
	});

	it("leaves the command out of an inline digest, because the start call holds it", async () => {
		freshRegistry();
		const text = await start("background", { command: "echo INLINE" }, { inlineWaitMs: 5_000 });
		expect(text.split("\n")[0]).toMatch(/^Background job "background-\d+" ended/);
		expect(text).not.toContain("Command:");
	});

	it("does not wait for a monitor", async () => {
		freshRegistry();
		const text = await start(
			"monitor",
			{ name: "brief", command: "echo READY", match: "NEVER" },
			{ inlineWaitMs: 5_000 },
		);
		expect(text.split("\n")[0]).toMatch(/^Started monitor "brief"/);
		await waitFor(() => emitted.length > 0);
		expect(emitted[0]).toContain('Monitor "brief" ended');
	});
});
