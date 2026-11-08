import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { writeCloseHook } from "../../src/features/agents/placement.ts";
import { agentPaths } from "../../src/features/agents/spawn-file.ts";

const stubLog = () => process.env["PIMON_TEST_STUB_LOG"] ?? "";

function closeCalls(pane: string): number {
	if (!existsSync(stubLog())) return 0;
	return readFileSync(stubLog(), "utf8")
		.split("\n")
		.filter((line) => line === `herdr\tpane close ${pane}`).length;
}

/** Loads the hook like pi does, fires one shutdown event, then exits with `code`. */
function runHook(hook: string, pane: string, reason: string | undefined, code: number) {
	const script = `
const hook = await import(${JSON.stringify(hook)});
const handlers = [];
hook.default({ on: (event, handler) => handlers.push([event, handler]) });
for (const [event, handler] of handlers) if (event === "session_shutdown" && ${JSON.stringify(reason ?? null)}) handler({ reason: ${JSON.stringify(reason)} });
process.exit(${code});
`;
	return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		env: { ...process.env, HERDR_PANE_ID: pane },
		encoding: "utf8",
	});
}

describe("herdr close hook", () => {
	let root: string;
	let hook: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "close-hook-"));
		hook = writeCloseHook(agentPaths(join(root, "agents")), "spawn-1");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("closes the pane once after pi quits with exit code 0", () => {
		expect(runHook(hook, "w1:p2", "quit", 0).status).toBe(0);
		expect(closeCalls("w1:p2")).toBe(1);
	});

	it("keeps the pane after pi quits with a failure code", () => {
		expect(runHook(hook, "w1:p6", "quit", 1).status).toBe(1);
		expect(closeCalls("w1:p6")).toBe(0);
	});

	it("closes the pane on a clean forced exit", () => {
		expect(runHook(hook, "w1:p3", undefined, 0).status).toBe(0);
		expect(closeCalls("w1:p3")).toBe(1);
	});

	it("keeps the pane after a failed exit", () => {
		expect(runHook(hook, "w1:p4", undefined, 1).status).toBe(1);
		expect(closeCalls("w1:p4")).toBe(0);
	});

	it("does nothing on a reload or a session replacement", () => {
		expect(runHook(hook, "w1:p5", "reload", 1).status).toBe(1);
		expect(runHook(hook, "w1:p5", "new", 1).status).toBe(1);
		expect(closeCalls("w1:p5")).toBe(0);
	});
});
