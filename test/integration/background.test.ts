import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import { clearReloadState, reloadSlot } from "../../src/core/reload-state.ts";
import { background } from "../../src/features/background/index.ts";
import { createRegistry } from "../../src/features/background/registry.ts";
import { shutdownJobs } from "../../src/features/background/runner.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const stateRoot = mkdtempSync(join(tmpdir(), "pimon-bg-integration-"));
const savedDir = process.env["PI_BACKGROUND_DIR"];
beforeAll(() => {
	process.env["PI_BACKGROUND_DIR"] = stateRoot;
});
afterAll(() => {
	if (savedDir === undefined) delete process.env["PI_BACKGROUND_DIR"];
	else process.env["PI_BACKGROUND_DIR"] = savedDir;
	rmSync(stateRoot, { recursive: true, force: true });
});

const call = (tool: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));

const toolTexts = (messages: Message[] | undefined) =>
	(messages ?? [])
		.filter((message) => message.role === "toolResult")
		.map((message) => message.content.map((block) => (block.type === "text" ? block.text : "")).join(""));

const findRequest = (harness: Harness, needle: string) =>
	harness.requests.find((messages) => JSON.stringify(messages).includes(needle));

async function waitForRequestWith(harness: Harness, needle: string, timeoutMs = 8_000): Promise<Message[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const found = findRequest(harness, needle);
		if (found) {
			await harness.session.waitForIdle();
			return found;
		}
		if (Date.now() > deadline) throw new Error(`no model request contained ${JSON.stringify(needle)}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("background in a session", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await shutdownJobs(reloadSlot("background", "registry", 1, () => createRegistry("")));
		harness?.dispose();
		harness = undefined;
		clearReloadState();
	});

	it("returns the exit digest of a fast job as the tool result and starts no extra turn", async () => {
		harness = await createHarness({ features: [background] });
		harness.respond([
			call("background", { action: "start", name: "lint", command: "echo LINT-OK; exit 1" }),
			say("saw the digest"),
		]);
		await harness.session.prompt("run the lint");
		const result = toolTexts(harness.requests[1]).join("\n");
		expect(result).toMatch(/^Background job "lint" ended: exit code 1 after \d+ms\.$/m);
		expect(result).toContain("LINT-OK");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(harness.requests).toHaveLength(2);
		const custom = harness.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "background");
		expect(custom).toEqual([]);
		expect(harness.extensionErrors).toEqual([]);
	});

	it("starts a job through a tool call and its exit digest arrives as a custom message that triggers a turn", async () => {
		harness = await createHarness({
			features: [background],
			setupAgentDir: (dir) =>
				writeFileSync(join(dir, "pimon.json"), JSON.stringify({ features: { background: { inlineWaitMs: 100 } } })),
		});
		harness.respond([
			call("background", { action: "start", name: "build", command: "echo BUILD-OK; sleep 0.3; exit 2" }),
			say("started"),
			say("saw the digest"),
		]);
		await harness.session.prompt("run the build");
		const started = toolTexts(harness.requests[1]).join("\n");
		expect(started).toContain('Started background "build"');
		expect(started).toContain("You will be woken once when it exits");

		await harness.waitForRequests(3);
		const woken = JSON.stringify(harness.requests[2]);
		expect(woken).toContain('Background job \\"build\\" ended: exit code 2');
		expect(woken).toContain("BUILD-OK");
		const custom = harness.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "background");
		expect(custom).toHaveLength(1);
		expect(harness.extensionErrors).toEqual([]);
	});

	it("an edited monitor delivers only the new pattern", async () => {
		harness = await createHarness({ features: [background] });
		harness.respond([
			call("monitor", {
				action: "start",
				name: "watch",
				command: "sleep 0.8; printf '%s-line\\n' AAA BBB; sleep 0.4",
				match: "AAA",
			}),
			call("monitor", { action: "edit", name: "watch", match: "BBB" }),
			say("armed"),
			say("matched"),
			say("ended"),
		]);
		await harness.session.prompt("watch it");
		expect(toolTexts(harness.requests[2]).at(-1)).toContain('Edited monitor "watch"');
		expect(toolTexts(harness.requests[2]).at(-1)).toContain('match="BBB" (literal)');

		const matched = JSON.stringify(await waitForRequestWith(harness, "matched 1 line(s)"));
		expect(matched).toContain("BBB-line");
		expect(matched).not.toContain("AAA-line");
	});

	it("stop reports a confirmed death in its own result", async () => {
		harness = await createHarness({ features: [background] });
		harness.respond([
			call("background", { action: "start", name: "server", command: "sleep 30", timeoutMs: 0 }),
			call("background", { action: "stop", name: "server" }),
			say("stopped"),
		]);
		await harness.session.prompt("start then stop");
		const stopped = toolTexts(harness.requests[2]).at(-1) ?? "";
		expect(stopped).toMatch(/^background "server": exited after SIGTERM in \d+\.\ds$/m);
		expect(stopped).not.toContain("action=status");
	});

	it("keeps running jobs across reload", async () => {
		harness = await createHarness({ features: [background] });
		harness.respond([
			call("background", { action: "start", name: "longjob", command: "sleep 30", timeoutMs: 0 }),
			say("started"),
			call("background", { action: "list" }),
			say("listed"),
		]);
		await harness.session.prompt("start");
		await harness.session.reload();
		await harness.session.prompt("list");
		const listed = toolTexts(harness.requests.at(-1)).at(-1) ?? "";
		expect(listed).toContain("- longjob [background]");
		expect(listed).toContain("state: running");
	});

	it("holds an exit digest that comes during a manual compaction until the compaction ends", async () => {
		harness = await createHarness({ features: [background] });
		const h = harness;
		let startSummary = () => {};
		const summaryStarted = new Promise<void>((resolve) => {
			startSummary = resolve;
		});
		let releaseSummary = () => {};
		const summaryReleased = new Promise<void>((resolve) => {
			releaseSummary = resolve;
		});
		const go = join(h.cwd, "go");
		h.respond([
			call("background", {
				action: "start",
				name: "gated",
				command: `while [ ! -f ${go} ]; do sleep 0.05; done; echo GATED-DONE`,
			}),
			say("started"),
			say("R2"),
			async () => {
				startSummary();
				await summaryReleased;
				return say("SUMMARY-MANUAL");
			},
			say("saw the digest"),
			say("spare"),
		]);
		await h.session.prompt(`OLD-P1 ${"x".repeat(100_000)}`);
		await h.session.prompt(`OLD-P2 ${"x".repeat(100_000)}`);
		const log: string[] = [];
		h.session.subscribe((event) => {
			if (event.type === "compaction_end") log.push("compaction_end");
			if (event.type === "agent_start") log.push("agent_start");
		});

		const compacting = h.session.compact();
		await summaryStarted;
		writeFileSync(go, "");
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		const requestsWhileCompacting = h.requests.length;
		releaseSummary();
		await compacting;
		await h.waitForRequests(5);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await h.session.waitForIdle();
		const woken = JSON.stringify(h.requests[4]);

		expect(requestsWhileCompacting).toBe(4);
		expect(log).toEqual(["compaction_end", "agent_start"]);
		expect(h.requests).toHaveLength(5);
		expect(woken).toContain("SUMMARY-MANUAL");
		expect(woken).toContain('Background job \\"gated\\" ended: exit code 0');
		expect(woken).not.toContain("OLD-P1");
	});
});
