import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExecFn, ExecResult } from "../../core/exec.ts";
import {
	closeHookSource,
	createHerdrPlacer,
	herdrAgentName,
	OUTSIDE_HERDR,
	type Placement,
	type PlacementRequest,
	writeCloseHook,
} from "./placement.ts";
import { agentPaths } from "./spawn-file.ts";

interface FakeHerdr {
	exec: ExecFn;
	calls: string[][];
	panes: Map<string, { tab: string }>;
	tabs: Set<string>;
}

/** In-memory herdr CLI. Each call takes `delayMs`, so overlapping placements interleave. */
function fakeHerdr(
	options: { delayMs?: number; failAgentStart?: boolean; current?: { workspace: string; pane: string } | "fail" } = {},
): FakeHerdr {
	const calls: string[][] = [];
	const panes = new Map<string, { tab: string }>([["w1:p1", { tab: "w1:t1" }]]);
	const tabs = new Set(["w1:t1"]);
	let next = 2;
	const ok = (value: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
	const fail: ExecResult = { code: 1, stdout: "", stderr: "no such pane" };
	const exec: ExecFn = async (command, args) => {
		expect(command).toBe("herdr");
		calls.push(args);
		if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
		const [group, verb] = args;
		if (group === "status") return ok({ status: "ok" });
		if (group === "pane" && verb === "current") {
			const current = options.current ?? { workspace: "w1", pane: "w1:p1" };
			if (current === "fail") return fail;
			return ok({ result: { pane: { pane_id: current.pane, workspace_id: current.workspace } } });
		}
		if (group === "tab" && verb === "create") {
			const id = next++;
			const tab = `w1:t${id}`;
			const pane = `w1:p${id}`;
			tabs.add(tab);
			panes.set(pane, { tab });
			return ok({ result: { tab: { tab_id: tab }, root_pane: { pane_id: pane, tab_id: tab } } });
		}
		if (group === "pane" && verb === "process-info") {
			return ok({ result: { process_info: { foreground_processes: [{ argv: ["/bin/bash"] }] } } });
		}
		if (group === "agent" && verb === "start") {
			return options.failAgentStart ? { code: 2, stdout: "", stderr: "agent failed" } : ok({ result: {} });
		}
		if (group === "pane" && verb === "get") {
			const pane = panes.get(args[2] ?? "");
			return pane ? ok({ result: { pane: { pane_id: args[2] } } }) : fail;
		}
		if (group === "pane" && verb === "focus") return panes.has(args[3] ?? "") ? ok({}) : fail;
		if (group === "pane" && verb === "close") {
			const pane = panes.get(args[2] ?? "");
			if (!pane) return fail;
			panes.delete(args[2] ?? "");
			if (![...panes.values()].some((entry) => entry.tab === pane.tab)) tabs.delete(pane.tab);
			return ok({});
		}
		return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
	};
	return { exec, calls, panes, tabs };
}

const HERDR_ENV = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" };
const request = (title: string): PlacementRequest => ({
	title,
	cwd: "/tmp",
	args: ["--model", "a/b"],
	env: { PIMON_SPAWN_FILE: "/x/spawn.json" },
	closeHook: "/x/hook-herdr-close.ts",
});

describe("herdr placement", () => {
	it("refuses to place outside Herdr", async () => {
		const herdr = fakeHerdr();
		const placer = createHerdrPlacer({ exec: herdr.exec, env: {} });
		expect(placer.inside()).toBe(false);
		await expect(placer.place(request("reviewer"), "12345678-aaaa")).rejects.toThrow(OUTSIDE_HERDR);
		expect(herdr.calls).toEqual([]);
		expect(await placer.describe()).toContain("not available");
	});

	it("starts each child in its own labeled tab without focus and without the executable", async () => {
		const herdr = fakeHerdr();
		const placer = createHerdrPlacer({ exec: herdr.exec, env: HERDR_ENV, shellDelayMs: 0, pollMs: 1 });
		const first = await placer.place(request("reviewer"), "12345678-1234-1234-1234-123456789abc");
		const second = await placer.place(request("reviewer"), "abcdef12-1234-1234-1234-123456789abc");
		expect(first).toMatchObject({ kind: "herdr", layout: "tab", tabId: "w1:t2" });
		expect(second).toMatchObject({ kind: "herdr", layout: "tab", tabId: "w1:t3" });
		expect(second.detail).toContain("full-size");
		expect(await placer.alive(first)).toBe(true);
		expect(await placer.focus(first)).toBe(true);

		const creates = herdr.calls.filter((args) => args[0] === "tab" && args[1] === "create");
		expect(creates).toHaveLength(2);
		expect(creates[0]).toEqual([
			"tab",
			"create",
			"--workspace",
			"w1",
			"--cwd",
			"/tmp",
			"--label",
			"reviewer",
			"--no-focus",
			"--env",
			"PIMON_SPAWN_FILE=/x/spawn.json",
		]);
		const starts = herdr.calls.filter((args) => args[0] === "agent" && args[1] === "start");
		expect(starts.map((args) => args[2])).toEqual(["reviewer-12345678", "reviewer-abcdef12"]);
		expect(starts.every((args) => /^[a-z][a-z0-9_-]{0,31}$/.test(args[2] ?? ""))).toBe(true);
		expect(starts[0]?.slice(starts[0].indexOf("--"))).toEqual(["--", "-e", "/x/hook-herdr-close.ts", "--model", "a/b"]);
		expect(herdr.calls.some((args) => args[1] === "split")).toBe(false);
		expect(await placer.describe()).toContain("workspace w1, pane w1:p1");
	});

	it("places the child in the workspace the parent pane is in now, not the one in its env", async () => {
		const herdr = fakeHerdr({ current: { workspace: "w2", pane: "w2:p5" } });
		const placer = createHerdrPlacer({ exec: herdr.exec, env: HERDR_ENV, shellDelayMs: 0, pollMs: 1 });
		await placer.place(request("reviewer"), "12345678");
		const create = herdr.calls.find((args) => args[0] === "tab" && args[1] === "create");
		expect(create?.slice(2, 4)).toEqual(["--workspace", "w2"]);
		expect(await placer.describe()).toContain("workspace w2, pane w2:p5");
	});

	it("falls back to the env workspace when Herdr cannot name the current pane", async () => {
		const herdr = fakeHerdr({ current: "fail" });
		const placer = createHerdrPlacer({ exec: herdr.exec, env: HERDR_ENV, shellDelayMs: 0, pollMs: 1 });
		await placer.place(request("reviewer"), "12345678");
		const create = herdr.calls.find((args) => args[0] === "tab" && args[1] === "create");
		expect(create?.slice(2, 4)).toEqual(["--workspace", "w1"]);
		expect(await placer.describe()).toContain("workspace w1, pane w1:p1");
	});

	it("does not ask Herdr for the current pane without a caller pane", async () => {
		const herdr = fakeHerdr({ current: { workspace: "w9", pane: "w9:p1" } });
		const env = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" };
		const placer = createHerdrPlacer({ exec: herdr.exec, env, shellDelayMs: 0, pollMs: 1 });
		await placer.place(request("reviewer"), "12345678");
		expect(herdr.calls.some((args) => args[0] === "pane" && args[1] === "current")).toBe(false);
		const create = herdr.calls.find((args) => args[0] === "tab" && args[1] === "create");
		expect(create?.slice(2, 4)).toEqual(["--workspace", "w1"]);
	});

	it("closes child tabs and leaves the parent tab", async () => {
		const herdr = fakeHerdr();
		const placer = createHerdrPlacer({ exec: herdr.exec, env: HERDR_ENV, shellDelayMs: 0, pollMs: 1 });
		const first = await placer.place(request("a"), "11111111");
		const second = await placer.place(request("b"), "22222222");
		expect(await placer.close(first)).toBe(true);
		expect(await placer.alive(first)).toBe(false);
		expect(await placer.close(second)).toBe(true);
		expect([...herdr.tabs]).toEqual(["w1:t1"]);
		expect(herdr.panes.has("w1:p1")).toBe(true);
	});

	it("closes the pane when the agent does not start", async () => {
		const herdr = fakeHerdr({ failAgentStart: true });
		const placer = createHerdrPlacer({ exec: herdr.exec, env: HERDR_ENV, shellDelayMs: 0, pollMs: 1 });
		await expect(placer.place(request("a"), "11111111")).rejects.toThrow("agent failed");
		expect(herdr.calls.at(-1)).toEqual(["pane", "close", "w1:p2"]);
		expect([...herdr.tabs]).toEqual(["w1:t1"]);
	});

	it("keeps the event loop free while seven placements overlap", async () => {
		const herdr = fakeHerdr({ delayMs: 20 });
		const placer = createHerdrPlacer({ exec: herdr.exec, env: HERDR_ENV, shellDelayMs: 0, pollMs: 5 });
		let ticks = 0;
		const timer = setInterval(() => ticks++, 5);
		try {
			const placements = await Promise.all(
				Array.from({ length: 7 }, (_, index) => placer.place(request(`w${index}`), `${index}0000000`)),
			);
			expect(new Set(placements.map((placement) => placement.handle)).size).toBe(7);
		} finally {
			clearInterval(timer);
		}
		expect(ticks).toBeGreaterThan(3);
	});

	it("does not manage panes of other multiplexers", async () => {
		const herdr = fakeHerdr();
		const placer = createHerdrPlacer({ exec: herdr.exec, env: HERDR_ENV });
		const tmux: Placement = { kind: "tmux", handle: "%3", layout: "split", detail: "" };
		expect(await placer.alive(tmux)).toBeUndefined();
		expect(await placer.focus(tmux)).toBe(false);
		expect(await placer.close(tmux)).toBe(false);
		expect(herdr.calls).toEqual([]);
	});

	it("builds valid agent names from any title", () => {
		expect(herdrAgentName("Code Reviewer!", "abcdef12-0000")).toBe("code-reviewer-abcdef12");
		expect(herdrAgentName("123", "abcdef12")).toBe("pi-agent-abcdef12");
	});
});

describe("close hook", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "hook-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("acts only at process exit, after every shutdown handler ran", () => {
		const source = closeHookSource();
		expect(source).not.toContain("session_shutdown");
		expect(source).toContain("code !== 0");
		expect(source).toContain('process.on("exit"');
	});

	it("is a private file that holds no task and no token", () => {
		const paths = agentPaths(join(root, "agents"));
		const path = writeCloseHook(paths, "spawn-1");
		expect(path).toBe(join(paths.prompts, "spawn-1-herdr-close.ts"));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(paths.prompts).mode & 0o777).toBe(0o700);
		expect(statSync(paths.root).mode & 0o777).toBe(0o700);
	});
});
