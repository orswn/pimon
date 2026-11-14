import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createProcessRunner } from "../../src/core/exec.ts";

const { run: runProcess } = createProcessRunner();

const marker = join(tmpdir(), `pimon-exec-orphan-${process.pid}`);
const grandchild = `( sleep 2; echo alive > ${marker} ) & echo SHELL=$$; sleep 30`;
const shellPid = (stdout: string) => Number(/SHELL=(\d+)/.exec(stdout)?.[1]);

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await sleep(20);
	}
}

describe("runProcess result normalization", () => {
	it("reports a clean exit with code 0 and no failure", async () => {
		const result = await runProcess("bash", ["-c", "echo hi"]);
		expect(result).toEqual({ code: 0, stdout: "hi\n", stderr: "" });
	});

	it("keeps a nonzero exit as a completed run", async () => {
		const result = await runProcess("bash", ["-c", "echo boom >&2; exit 3"]);
		expect(result).toMatchObject({ code: 3, stderr: "boom\n" });
		expect(result.failed).toBeUndefined();
	});

	it("marks timeout, spawn failure, abort, signal, and output overflow", async () => {
		expect((await runProcess("bash", ["-c", "sleep 5"], { timeoutMs: 300 })).failed).toBe("timeout");
		expect((await runProcess("definitely-not-a-real-binary-xyz", [])).failed).toBe("spawn");
		const controller = new AbortController();
		const pending = runProcess("bash", ["-c", "sleep 5"], { signal: controller.signal });
		controller.abort();
		expect((await pending).failed).toBe("aborted");
		const killed = await runProcess("bash", ["-c", "kill -9 $$"]);
		expect(killed.failed).toBe("signal");
		expect(killed.stderr).toContain("SIGKILL");
		expect((await runProcess("bash", ["-c", "kill -TERM $$"])).failed).toBe("signal");
		const flood = await runProcess("bash", ["-c", "yes abcdefghij | head -c 20000000"], { killGraceMs: 200 });
		expect(flood.failed).toBe("output-limit");
		expect(flood.stdout.length).toBeLessThanOrEqual(4 * 1024 * 1024);
	});

	it("caps multibyte output by bytes without a broken character", async () => {
		const result = await runProcess("bash", ["-c", "printf '\\360\\237\\231\\202%.0s' $(seq 1 2000)"], {
			maxOutputBytes: 64,
			killGraceMs: 200,
		});
		expect(result.failed).toBe("output-limit");
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64);
		expect(result.stdout).not.toContain("\uFFFD");
	});
});

describe("runProcess cancellation reaches the process tree", () => {
	afterEach(() => rmSync(marker, { force: true }));

	it("kills the shell and its grandchild on abort", async () => {
		const controller = new AbortController();
		const pending = runProcess("bash", ["-c", grandchild], { signal: controller.signal, killGraceMs: 200 });
		await sleep(600);
		controller.abort();
		const result = await pending;
		expect(result.failed).toBe("aborted");
		const pid = shellPid(result.stdout);
		expect(Number.isFinite(pid) && existsSync(`/proc/${pid}`)).toBe(false);
		await sleep(2_600);
		expect(existsSync(marker)).toBe(false);
	});

	it("kills descendants on timeout", async () => {
		expect((await runProcess("bash", ["-c", grandchild], { timeoutMs: 400, killGraceMs: 200 })).failed).toBe("timeout");
		await sleep(2_600);
		expect(existsSync(marker)).toBe(false);
	});

	it("escalates to SIGKILL for a descendant that ignores SIGTERM", async () => {
		const stubborn = `python3 -c 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(3);open("${marker}","w").write("alive")' >/dev/null 2>&1 &`;
		const controller = new AbortController();
		const pending = runProcess("bash", ["-c", `${stubborn} echo SHELL=$$; sleep 30`], {
			signal: controller.signal,
			killGraceMs: 300,
		});
		await sleep(500);
		controller.abort();
		await pending;
		await sleep(3_600);
		expect(existsSync(marker)).toBe(false);
	});

	it("terminateAll kills a running group", async () => {
		const runner = createProcessRunner();
		void runner.run("bash", ["-c", grandchild], { killGraceMs: 200 });
		await sleep(400);
		runner.terminateAll();
		await sleep(2_600);
		expect(existsSync(marker)).toBe(false);
	});

	it("terminateAll of one runner does not kill a group started by another runner", async () => {
		const owner = createProcessRunner();
		const other = createProcessRunner();
		const controller = new AbortController();
		const pending = owner.run("bash", ["-c", grandchild], { signal: controller.signal, killGraceMs: 200 });
		await sleep(400);
		other.terminateAll();
		await until(() => existsSync(marker));
		expect(existsSync(marker)).toBe(true);
		controller.abort();
		expect((await pending).failed).toBe("aborted");
	});
});
