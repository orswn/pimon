import { describe, expect, it } from "vite-plus/test";
import { delegatedPrompt } from "./prompt.ts";
import type { Role } from "./roles.ts";
import { buildChildArgs, buildChildEnv } from "./tool.ts";

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

	it("passes only the spawn file and the bus dir in the env", () => {
		expect(buildChildEnv("/x/spawn.json", undefined)).toEqual({ PIMON_SPAWN_FILE: "/x/spawn.json" });
		expect(buildChildEnv("/x/spawn.json", "/b")).toEqual({ PIMON_SPAWN_FILE: "/x/spawn.json", PI_BUS_DIR: "/b" });
	});
});

describe("delegated section", () => {
	it("names the claimed bus name and the coordinator owner", () => {
		expect(delegatedPrompt("impl-w", "boss", "abc")).toBe(`## Delegated instance

- Your bus name is impl-w. Your coordinator is boss at \`owner:abc\`.
- The coordinator's task is the user message that starts with "Task:" or "Context handoff:".
- Send progress to \`owner:abc\` as \`kind="status"\` with \`wake="never"\`.
- Send the final result to \`owner:abc\` as \`kind="result"\` with \`wake="now"\`.
- When the design is incomplete, ambiguous, or contradictory, ask with \`kind="question"\` and \`expectReply=true\`. Do not make architectural or system design decisions.
- Do not spawn further agents unless the human or coordinator explicitly requests it.
- Do not run \`/reload\`. It replaces your tracked bus endpoint.`);
	});
});
