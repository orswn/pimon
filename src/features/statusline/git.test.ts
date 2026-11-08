import { describe, expect, it } from "vite-plus/test";
import type { ExecOptions, ExecResult } from "../../core/exec.ts";
import { createGitWatch, parseGitStatus } from "./git.ts";

const CWD = "/work/repo";
const CLEAN = "## main...origin/main [ahead 2, behind 1]\n M a.ts\n?? b.ts\n";

function setup() {
	let now = 1_000_000;
	const calls: { args: string[]; options?: ExecOptions | undefined; resolve: (result: ExecResult) => void }[] = [];
	let changes = 0;
	const watch = createGitWatch({
		run: (_command, args, options) =>
			new Promise<ExecResult>((resolve) => {
				calls.push({ args, options, resolve });
			}),
		now: () => now,
		onChange: () => changes++,
	});
	const settle = async (index: number, result: ExecResult) => {
		calls[index]?.resolve(result);
		await new Promise((resolve) => setImmediate(resolve));
	};
	return {
		watch,
		calls,
		settle,
		advance: (ms: number) => {
			now += ms;
		},
		changes: () => changes,
	};
}

describe("git status parse", () => {
	it("reads branch, dirty count, ahead, and behind", () => {
		expect(parseGitStatus(CLEAN)).toEqual({ branch: "main", dirty: 2, ahead: 2, behind: 1 });
		expect(parseGitStatus("## HEAD (no branch)\n")).toEqual({ branch: "detached", dirty: 0, ahead: 0, behind: 0 });
		expect(parseGitStatus("fatal")).toBeUndefined();
	});
});

describe("git watch", () => {
	it("runs git status with optional locks off, a timeout, and no gc", async () => {
		const t = setup();
		t.watch.request(CWD);
		expect(t.calls).toHaveLength(1);
		expect(t.calls[0]?.args).toEqual([
			"--no-optional-locks",
			"-C",
			CWD,
			"-c",
			"gc.auto=0",
			"status",
			"--porcelain=v1",
			"--branch",
		]);
		expect(t.calls[0]?.options?.timeoutMs).toBe(800);
		await t.settle(0, { code: 0, stdout: CLEAN, stderr: "" });
		expect(t.watch.status(CWD)).toEqual({ branch: "main", dirty: 2, ahead: 2, behind: 1 });
		expect(t.changes()).toBe(1);
	});

	it("keeps one run in flight and starts the pending trigger from a render after the spacing", async () => {
		const t = setup();
		t.watch.request(CWD);
		t.watch.request(CWD);
		t.watch.onRender(CWD);
		expect(t.calls).toHaveLength(1);
		await t.settle(0, { code: 0, stdout: CLEAN, stderr: "" });
		t.advance(1_999);
		t.watch.onRender(CWD);
		expect(t.calls).toHaveLength(1);
		t.advance(1);
		t.watch.onRender(CWD);
		expect(t.calls).toHaveLength(2);
	});

	it("starts at most once per 2 s", async () => {
		const t = setup();
		t.watch.request(CWD);
		await t.settle(0, { code: 0, stdout: CLEAN, stderr: "" });
		t.advance(500);
		t.watch.request(CWD);
		expect(t.calls).toHaveLength(1);
		t.advance(1_500);
		t.watch.request(CWD);
		expect(t.calls).toHaveLength(2);
	});

	it("checks again from a render only after 30 s", async () => {
		const t = setup();
		t.watch.request(CWD);
		await t.settle(0, { code: 0, stdout: CLEAN, stderr: "" });
		t.advance(29_999);
		t.watch.onRender(CWD);
		expect(t.calls).toHaveLength(1);
		t.advance(1);
		t.watch.onRender(CWD);
		expect(t.calls).toHaveLength(2);
	});

	it("drops to the branch only after a timeout and pauses that cwd for 60 s", async () => {
		const t = setup();
		t.watch.request(CWD);
		await t.settle(0, { code: 0, stdout: CLEAN, stderr: "" });
		t.advance(30_000);
		t.watch.request(CWD);
		await t.settle(1, { code: -1, stdout: "", stderr: "timed out", failed: "timeout" });
		expect(t.watch.status(CWD)).toBeUndefined();
		t.advance(59_999);
		t.watch.request(CWD);
		t.watch.onRender(CWD);
		expect(t.calls).toHaveLength(2);
		t.advance(1);
		t.watch.request(CWD);
		expect(t.calls).toHaveLength(3);
		t.watch.request("/other");
		expect(t.calls).toHaveLength(3);
	});

	it("pauses after a failed exit too", async () => {
		const t = setup();
		t.watch.request(CWD);
		await t.settle(0, { code: 128, stdout: "", stderr: "not a git repository" });
		t.advance(30_000);
		t.watch.onRender(CWD);
		expect(t.calls).toHaveLength(1);
	});

	it("shows no status for another cwd", async () => {
		const t = setup();
		t.watch.request(CWD);
		await t.settle(0, { code: 0, stdout: CLEAN, stderr: "" });
		expect(t.watch.status("/elsewhere")).toBeUndefined();
	});
});
