import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { delegatedPrompt } from "./prompt.ts";
import type { Role } from "./roles.ts";
import type { PeerRecord } from "../bus/protocol.ts";
import type { ChildRecord } from "./records.ts";
import { type AgentsHost, buildChildArgs, buildChildEnv, isActiveChild } from "./tool.ts";

const role = (mcp: boolean): Role => ({
	name: "worker",
	description: "",
	mcp,
	prompt: "You work.",
	source: "user",
	file: "/r/worker.md",
});

describe("child command line", () => {
	it("adds --no-mcp only for a role with mcp false", () => {
		const runtime = { model: "a/b", thinking: "high" };
		expect(buildChildArgs({ runtime, role: role(true) })).toEqual(["--model", "a/b", "--thinking", "high"]);
		expect(buildChildArgs({ runtime, role: role(false) })).toEqual([
			"--model",
			"a/b",
			"--thinking",
			"high",
			"--no-mcp",
		]);
	});

	it("opens a fork session and carries no prompt, task, or token", () => {
		const args = buildChildArgs({ runtime: {}, role: role(true), sessionFile: "/s/fork.jsonl" });
		expect(args).toEqual(["--session", "/s/fork.jsonl"]);
		expect(args.join(" ")).not.toContain("--append-system-prompt");
	});

	it("passes only the spawn file and the bus dir when the parent has no agent dir", () => {
		expect(buildChildEnv("/x/spawn.json", undefined, "/agents/x", {})).toEqual({ PIMON_SPAWN_FILE: "/x/spawn.json" });
		expect(buildChildEnv("/x/spawn.json", "/b", "/agents/x", {})).toEqual({
			PIMON_SPAWN_FILE: "/x/spawn.json",
			PI_BUS_DIR: "/b",
		});
	});

	it("passes the agent dir of the parent only when the parent has one set", () => {
		const parent = { PI_CODING_AGENT_DIR: "~/agents/x", HOME: "/home/u" };
		expect(buildChildEnv("/x/spawn.json", undefined, "/home/u/agents/x", parent)).toEqual({
			PIMON_SPAWN_FILE: "/x/spawn.json",
			PI_CODING_AGENT_DIR: "/home/u/agents/x",
		});
		expect(buildChildEnv("/x/spawn.json", undefined, "/agents/x", { PI_CODING_AGENT_DIR: "" })).toEqual({
			PIMON_SPAWN_FILE: "/x/spawn.json",
		});
	});

	it("passes a relative agent dir and bus dir as absolute paths", () => {
		// The child starts in its own cwd, so a relative path would name another dir there.
		const env = buildChildEnv("/x/spawn.json", "bus-dir", "agent-dir", { PI_CODING_AGENT_DIR: "agent-dir" });
		expect(env).toEqual({
			PIMON_SPAWN_FILE: "/x/spawn.json",
			PI_BUS_DIR: resolve("bus-dir"),
			PI_CODING_AGENT_DIR: resolve("agent-dir"),
		});
	});
});

describe("delegated section", () => {
	it("names the claimed bus name and the short coordinator owner", () => {
		expect(delegatedPrompt("impl-w", "boss", "a991cc91-6495-4c81-bd1c-03ce8d23e62d")).toBe(`## Delegated instance

- Your bus name is impl-w. Your coordinator is boss at \`owner:a991cc916495\`.
- The coordinator's task is the user message that starts with "Task:" or "Context handoff:".
- A task from your coordinator over \`pi_bus\` has the same authority as the first task.
- Send progress to \`owner:a991cc916495\` as \`kind="status"\` with \`wake="never"\`.
- Send the final result as \`kind="result"\` with \`wake="now"\`. For a task that came as a bus message, use \`action="reply"\` with its \`messageId\`. Else use \`action="send"\` to \`owner:a991cc916495\`.
- When the design is incomplete, ambiguous, or contradictory, ask with \`kind="question"\` and \`expectReply=true\`. Do not make architectural or system design decisions.
- Do not spawn further agents unless the human or coordinator explicitly requests it.
- Do not run \`/reload\`. It replaces your tracked bus endpoint.`);
	});
});

describe("active child", () => {
	const OWNER = "parent-owner";
	const peer = (spawnId: string, instanceId: string) =>
		({ instanceId, labels: { spawn: spawnId, parent: OWNER }, stale: false }) as unknown as PeerRecord;
	const hostWith = (peers: PeerRecord[]) =>
		({
			bus: {
				started: true,
				owner: OWNER,
				resolve: (selector: string) => peers.filter((item) => `label:spawn=${item.labels["spawn"]}` === selector),
			},
		}) as unknown as AgentsHost;
	const record = (spawnId: string, fields: Partial<ChildRecord> = {}) =>
		({ spawnId, launchedAt: Date.now(), launchedBy: OWNER, ...fields }) as ChildRecord;

	it("counts a child that is starting or on the bus", () => {
		const host = hostWith([peer("live", "i-live"), peer("moved", "i-new")]);
		expect(isActiveChild(host, record("new"), new Set())).toBe(true);
		expect(isActiveChild(host, record("live", { instanceId: "i-live" }), new Set())).toBe(true);
		expect(isActiveChild(host, record("moved", { instanceId: "i-old" }), new Set())).toBe(true);
	});

	it("skips a child that exited or never joined the bus", () => {
		const host = hostWith([]);
		expect(isActiveChild(host, record("gone", { instanceId: "i-gone" }), new Set())).toBe(false);
		expect(isActiveChild(host, record("failed", { launchedAt: 0 }), new Set())).toBe(false);
	});

	it("skips a child whose endpoint left while its presence is still listed", () => {
		const host = hostWith([peer("leaving", "i-leaving")]);
		expect(isActiveChild(host, record("leaving", { instanceId: "i-leaving" }), new Set(["i-leaving"]))).toBe(false);
	});
});
