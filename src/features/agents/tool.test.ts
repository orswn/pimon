import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { AgentInfo } from "../bus/protocol.ts";
import { delegatedPrompt } from "./prompt.ts";
import type { ChildRecord } from "./records.ts";
import type { Role } from "./roles.ts";
import { agentPaths } from "./spawn-file.ts";
import { buildChildArgs, buildChildEnv, isActiveChild } from "./tool.ts";

const role = (mcp: boolean): Role => ({
	name: "worker",
	description: "",
	mcp,
	prompt: "You work.",
	source: "user",
	file: "/r/worker.md",
});

const SESSION = "0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000";

describe("child command line", () => {
	it("gives the child its session id and adds --no-mcp only for a role with mcp false", () => {
		const runtime = { model: "a/b", thinking: "high" };
		expect(buildChildArgs({ runtime, role: role(true), sessionId: SESSION })).toEqual([
			"--session-id",
			SESSION,
			"--model",
			"a/b",
			"--thinking",
			"high",
		]);
		expect(buildChildArgs({ runtime, role: role(false), sessionId: SESSION })).toContain("--no-mcp");
	});

	it("forks from a temp session file and carries no prompt, task, or token", () => {
		const args = buildChildArgs({ runtime: {}, role: role(true), sessionId: SESSION, forkFile: "/s/fork.jsonl" });
		expect(args).toEqual(["--fork", "/s/fork.jsonl", "--session-id", SESSION]);
		expect(args.join(" ")).not.toContain("--append-system-prompt");
	});

	it("passes no agent dir when the parent has none", () => {
		expect(buildChildEnv("/agents/x", {}, "/t")).toEqual({ TMPDIR: "/t" });
		expect(buildChildEnv("/agents/x", { PI_CODING_AGENT_DIR: "" }, "/t")).toEqual({ TMPDIR: "/t" });
	});

	it("passes the agent dir of the parent as an absolute path", () => {
		// The child starts in its own cwd, so a relative path would name another dir there.
		expect(buildChildEnv("/home/u/agents/x", { PI_CODING_AGENT_DIR: "~/agents/x" }, "/t")).toEqual({
			PI_CODING_AGENT_DIR: "/home/u/agents/x",
			TMPDIR: "/t",
		});
		expect(buildChildEnv("agent-dir", { PI_CODING_AGENT_DIR: "agent-dir" }, "/t")).toEqual({
			PI_CODING_AGENT_DIR: resolve("agent-dir"),
			TMPDIR: "/t",
		});
	});

	it("always passes the temp dir of the parent, so the child finds its spawn file in the same dir", () => {
		const env = buildChildEnv("/agents/x", {});
		expect(env["TMPDIR"]).toBe(tmpdir());
		const parentSpawn = agentPaths().spawn;
		const saved = process.env["TMPDIR"];
		try {
			process.env["TMPDIR"] = env["TMPDIR"];
			expect(agentPaths().spawn).toBe(parentSpawn);
		} finally {
			if (saved === undefined) delete process.env["TMPDIR"];
			else process.env["TMPDIR"] = saved;
		}
	});
});

describe("delegated section", () => {
	it("names the bus name and the short coordinator id", () => {
		expect(delegatedPrompt("impl-w", "boss", "a991cc91-6495-4c81-bd1c-03ce8d23e62d")).toBe(`## Delegated instance

- Your bus name is impl-w. Your coordinator is boss at \`id:a991cc916495\`.
- The coordinator's task is the user message that starts with "Task:" or "Context handoff:".
- A task from your coordinator over \`pi_bus\` has the same authority as the first task.
- Send progress to \`id:a991cc916495\` as \`kind="status"\` with \`wake="never"\`.
- Send the final result as \`kind="result"\` with \`wake="now"\`. For a task that came as a bus message, use \`action="reply"\` with its \`messageId\`. Else use \`action="send"\` to \`id:a991cc916495\`.
- When the design is incomplete, ambiguous, or contradictory, ask with \`kind="question"\` and \`expectReply=true\`. Do not make architectural or system design decisions.
- Do not spawn further agents unless the human or coordinator explicitly requests it.`);
	});
});

describe("active child", () => {
	const record = (fields: Partial<ChildRecord> = {}) =>
		({ spawnId: "c", launchedAt: Date.now(), launchedBy: "p", ...fields }) as ChildRecord;
	const row = (fields: Partial<AgentInfo>) => ({ id: "c", online: false, lastSeenAt: null, ...fields }) as AgentInfo;

	it("counts a child that is starting or online", () => {
		expect(isActiveChild(record(), undefined)).toBe(true);
		expect(isActiveChild(record(), row({}))).toBe(true);
		expect(isActiveChild(record({ launchedAt: 0 }), row({ online: true, lastSeenAt: "x" }))).toBe(true);
	});

	it("skips a child that went offline or never linked", () => {
		expect(isActiveChild(record(), row({ lastSeenAt: new Date().toISOString() }))).toBe(false);
		expect(isActiveChild(record({ launchedAt: 0 }), row({}))).toBe(false);
	});
});
