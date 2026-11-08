import { describe, expect, it } from "vite-plus/test";
import type { ExecFn, ExecOptions } from "../../core/exec.ts";
import { adjudicateWithCheck } from "./adjudicate.ts";

describe("check-command adjudication", () => {
	const exec =
		(code: number, stdout = "", stderr = ""): ExecFn =>
		async () => ({ code, stdout, stderr });
	const base = { check: "true", cwd: "/work", timeoutMs: 1000 };

	it("accepts exit 0", async () => {
		expect((await adjudicateWithCheck({ ...base, exec: exec(0) })).verdict).toBe("accepted");
	});
	it("rejects a completed nonzero exit with the output tail", async () => {
		const rejected = await adjudicateWithCheck({ ...base, check: "false", exec: exec(1, "", "1 test failed") });
		expect(rejected.verdict).toBe("rejected");
		expect(rejected.reason).toContain("1 test failed");
		expect(rejected).toMatchObject({ code: 1, tail: "1 test failed" });
	});
	it("treats a thrown spawn error as unverified, never rejected", async () => {
		const crashed = await adjudicateWithCheck({
			...base,
			exec: async () => {
				throw new Error("spawn ENOENT");
			},
		});
		expect(crashed.verdict).toBe("unverified");
	});
	it("treats a missing exit code as unverified", async () => {
		const noCode = await adjudicateWithCheck({
			...base,
			exec: async () => ({ code: null as unknown as number, stdout: "", stderr: "" }),
		});
		expect(noCode.verdict).toBe("unverified");
	});
	it("treats a failed run as unverified and names the failure kind", async () => {
		const timedOut = await adjudicateWithCheck({
			...base,
			exec: async () => ({ code: -1, stdout: "", stderr: "timed out", failed: "timeout" }),
		});
		expect(timedOut.verdict).toBe("unverified");
		expect(timedOut.reason).toContain("timeout");
	});
	it("runs bash -c in the session cwd with the timeout and signal", async () => {
		const calls: { command: string; args: string[]; options?: ExecOptions | undefined }[] = [];
		const signal = new AbortController().signal;
		await adjudicateWithCheck({
			check: "npm test",
			cwd: "/project",
			timeoutMs: 1234,
			signal,
			exec: async (command, args, options) => {
				calls.push({ command, args, options });
				return { code: 0, stdout: "", stderr: "" };
			},
		});
		expect(calls).toEqual([
			{ command: "bash", args: ["-c", "npm test"], options: { cwd: "/project", timeoutMs: 1234, signal } },
		]);
	});
});
