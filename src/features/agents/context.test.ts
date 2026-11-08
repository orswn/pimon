import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	buildInitialPrompt,
	CONTEXT_MODES,
	createForkSession,
	MAX_HANDOFF_BYTES,
	resolveContextMode,
	safeForkLeaf,
} from "./context.ts";

const errorOf = (result: object) => ("error" in result ? String(result.error) : "");

describe("context mode", () => {
	it("defaults to isolated and declares all modes", () => {
		expect(resolveContextMode(undefined, undefined)).toEqual({ mode: "isolated" });
		expect(CONTEXT_MODES).toEqual(["isolated", "handoff", "fork"]);
	});

	it("needs a non-empty brief for handoff and no brief otherwise", () => {
		expect(errorOf(resolveContextMode("handoff", undefined))).toContain("requires");
		expect(errorOf(resolveContextMode("handoff", " \n "))).toContain("requires");
		expect(errorOf(resolveContextMode("isolated", "context"))).toContain("only valid");
		expect(errorOf(resolveContextMode("fork", "context"))).toContain("only valid");
		expect(errorOf(resolveContextMode("future", undefined))).toContain("Valid values");
	});

	it("limits the brief in UTF-8 bytes and trims it", () => {
		expect(errorOf(resolveContextMode("handoff", "x".repeat(MAX_HANDOFF_BYTES + 1)))).toContain("byte limit");
		const emoji = "\u{1F642}".repeat(Math.floor(MAX_HANDOFF_BYTES / 4) + 1);
		expect(errorOf(resolveContextMode("handoff", emoji))).toContain("byte limit");
		expect(resolveContextMode("handoff", "  decision: keep this  ")).toEqual({
			mode: "handoff",
			brief: "decision: keep this",
		});
	});
});

describe("initial child prompt", () => {
	const task = "Inspect the task once.";

	it("holds the task once and the brief for handoff", () => {
		expect(buildInitialPrompt(task, { mode: "isolated" })).toBe(`Task: ${task}`);
		const handoff = buildInitialPrompt(task, { mode: "handoff", brief: "Decision: use the existing parser." });
		expect(handoff).toContain("Decision: use the existing parser.");
		expect(handoff.split(task)).toHaveLength(2);
		expect(handoff.startsWith("Context handoff:\n")).toBe(true);
		expect(handoff).toContain("\n\nTask:\n");
	});

	it("keeps leading flag and file text literal", () => {
		expect(buildInitialPrompt("-do not parse me", { mode: "isolated" })).toBe("Task: -do not parse me");
		expect(buildInitialPrompt("@do not load me", { mode: "isolated" })).toBe("Task: @do not load me");
	});
});

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	} as AssistantMessage;
}

describe("fork session", () => {
	let root: string;
	let cwd: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fork-"));
		cwd = join(root, "project");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("stops before the active spawn tool call and leaves the parent unchanged", () => {
		const parent = SessionManager.create(cwd, root);
		parent.appendModelChange("openai-codex", "gpt-5.6-luna");
		const priorUser = parent.appendMessage({ role: "user", content: "Prior requirement", timestamp: Date.now() });
		const priorAssistant = parent.appendMessage(assistant([{ type: "text", text: "Prior work completed." }]));
		const compaction = parent.appendCompaction("Earlier work summary", priorUser, 123);
		const currentUser = parent.appendMessage({ role: "user", content: "Spawn a reviewer", timestamp: Date.now() });
		const toolCallId = "call-current-pi-agents";
		const currentAssistant = parent.appendMessage(
			assistant([{ type: "toolCall", id: toolCallId, name: "pi_agents", arguments: { action: "spawn" } }], "toolUse"),
		);
		const parentFile = parent.getSessionFile() as string;
		const before = parent.getEntries().map((entry) => entry.id);

		expect(safeForkLeaf(parent, toolCallId)).toBe(currentUser);
		const childFile = createForkSession(parentFile, cwd, toolCallId);
		const child = SessionManager.open(childFile);
		const ids = child.getEntries().map((entry) => entry.id);
		expect(childFile).not.toBe(parentFile);
		expect(child.getSessionId()).not.toBe(parent.getSessionId());
		expect(ids).toEqual(expect.arrayContaining([priorUser, priorAssistant, currentUser]));
		expect(child.getEntries().some((entry) => entry.type === "compaction" && entry.id === compaction)).toBe(true);
		expect(ids).not.toContain(currentAssistant);
		expect(child.getHeader()?.parentSession).toBe(parentFile);
		expect(parent.getEntries().map((entry) => entry.id)).toEqual(before);
	});

	it("writes a session file for a fork on the first turn", () => {
		const first = SessionManager.create(cwd, root);
		first.appendModelChange("openai-codex", "gpt-5.6-luna");
		first.appendMessage({ role: "user", content: "First delegation", timestamp: Date.now() });
		first.appendMessage(
			assistant([{ type: "toolCall", id: "call-first", name: "pi_agents", arguments: { action: "spawn" } }], "toolUse"),
		);
		const childFile = createForkSession(first.getSessionFile(), cwd, "call-first");
		expect(existsSync(childFile)).toBe(true);
	});

	it("refuses a missing tool call, another cwd, and an in-memory parent", () => {
		const parent = SessionManager.create(cwd, root);
		parent.appendMessage({ role: "user", content: "Spawn", timestamp: Date.now() });
		parent.appendMessage(
			assistant([{ type: "toolCall", id: "call-x", name: "pi_agents", arguments: { action: "spawn" } }], "toolUse"),
		);
		const parentFile = parent.getSessionFile();
		expect(() => createForkSession(parentFile, cwd, "missing-tool-call")).toThrow("not persisted");
		expect(() => createForkSession(parentFile, join(root, "other"), "call-x")).toThrow(
			"matching the parent session cwd",
		);
		expect(() => createForkSession(SessionManager.inMemory(cwd).getSessionFile(), cwd, "call-x")).toThrow(
			"persistent parent session",
		);
	});
});
