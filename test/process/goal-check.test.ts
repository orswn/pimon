import { tmpdir } from "node:os";
import { describe, expect, it } from "vite-plus/test";
import { createProcessRunner } from "../../src/core/exec.ts";
import { adjudicateWithCheck } from "../../src/features/goal/adjudicate.ts";

const { run } = createProcessRunner();
const check = (command: string, options: { timeoutMs?: number; signal?: AbortSignal; cwd?: string } = {}) =>
	adjudicateWithCheck({
		check: command,
		exec: run,
		cwd: options.cwd ?? tmpdir(),
		timeoutMs: options.timeoutMs ?? 5_000,
		signal: options.signal,
	});

describe("check adjudication against the real exec is fail-closed", () => {
	it("accepts exit 0 and rejects exit 1", async () => {
		expect((await check("exit 0")).verdict).toBe("accepted");
		expect((await check("echo nope >&2; exit 1")).verdict).toBe("rejected");
	});

	it("treats a timeout as unverified and names it", async () => {
		const timeout = await check("sleep 5", { timeoutMs: 300 });
		expect(timeout.verdict).toBe("unverified");
		expect(timeout.reason).toContain("timeout");
	});

	it("treats an abort as unverified", async () => {
		const controller = new AbortController();
		const pending = check("sleep 5", { signal: controller.signal });
		controller.abort();
		expect((await pending).verdict).toBe("unverified");
	});

	it("rejects a command that bash cannot find, with exit 127", async () => {
		const gone = await check("definitely-not-a-real-binary-xyz");
		expect(gone.verdict).toBe("rejected");
		expect(gone.reason).toContain("127");
	});

	it("treats a signalled check as unverified and names the signal", async () => {
		const killed = await check("kill -9 $$");
		expect(killed.verdict).toBe("unverified");
		expect(killed.reason).toContain("signal");
	});

	it("still rejects a plain nonzero exit with its code", async () => {
		const result = await check("exit 7");
		expect(result.verdict).toBe("rejected");
		expect(result.reason).toContain("7");
	});

	it("runs in the given cwd without a login shell", async () => {
		const cwd = tmpdir();
		expect((await check(`test "$PWD" = "${cwd}" && ! shopt -q login_shell`, { cwd })).verdict).toBe("accepted");
	});
});
