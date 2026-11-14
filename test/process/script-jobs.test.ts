import { readFileSync, statSync } from "node:fs";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { defineFeature } from "../../src/core/feature.ts";
import { clearReloadState, reloadSlot } from "../../src/core/reload-state.ts";
import { createAskSecret } from "../../src/features/ask-secret/index.ts";
import { background } from "../../src/features/background/index.ts";
import { createRegistry, findJob, type Registry } from "../../src/features/background/registry.ts";
import { shutdownJobs } from "../../src/features/background/runner.ts";
import { SCRIPT_EXIT_BUDGET } from "../../src/features/background/digest.ts";
import { createEngineCache, type EngineCache } from "../../src/features/background/script-engine.ts";
import { createScriptStore, type ScriptStore } from "../../src/features/background/scripts.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const SECRET = "s3cr3t-value";
const call = (tool: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));
const toolTexts = (messages: Message[] | undefined) =>
	(messages ?? [])
		.filter((message) => message.role === "toolResult")
		.map((message) => message.content.map((block) => (block.type === "text" ? block.text : "")).join(""));
const registry = () => reloadSlot<Registry>("background", "registry", 1, () => createRegistry(""));
const engineLoaded = () => reloadSlot<EngineCache>("background", "engine", 1, createEngineCache).loaded;

const probe = defineFeature({
	id: "script-probe",
	description: "test tools for scripts",
	defaultEnabled: true,
	setup(ctx) {
		ctx.pi.registerTool({
			name: "echo",
			label: "Echo",
			description: "Return the text",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, params) => ({ content: [{ type: "text", text: `echo ${params.text}` }], details: {} }),
		});
		ctx.pi.registerTool({
			name: "fail",
			label: "Fail",
			description: "Always fails",
			parameters: Type.Object({}),
			execute: async () => {
				throw new Error("the tool failed on purpose");
			},
		});
		ctx.pi.registerTool({
			name: "structured",
			label: "Structured",
			description: "Fails with structured content",
			parameters: Type.Object({}),
			outputSchema: { type: "object", properties: { state: { type: "string" } } },
			execute: async () => ({
				content: [{ type: "text", text: "structured failure" }],
				structuredContent: { state: "failed" },
				isError: true,
				details: {},
			}),
		});
		ctx.pi.registerTool({
			name: "leak",
			label: "Leak",
			description: "Return the secret value",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: SECRET }], details: {} }),
		});
	},
});

let harness: Harness | undefined;

afterEach(async () => {
	await shutdownJobs(registry());
	harness?.dispose();
	harness = undefined;
	clearReloadState();
});

async function start(features = [background, probe]): Promise<Harness> {
	harness = await createHarness({ features, ui: {} });
	return harness;
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const wakes = (h: Harness, customType: string) =>
	h.session.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === customType)
		.map((entry) => (entry.type === "custom_message" && typeof entry.content === "string" ? entry.content : ""));

const LONG_SCRIPT = `for (let i = 0; ; i++) { emit("tick " + i); await sleep(50); }`;

describe("script jobs", () => {
	it("does not load the sandbox before the first script job", async () => {
		const h = await start();
		h.respond([call("background", { action: "list" }), say("ok")]);
		await h.session.prompt("go");
		await h.waitForRequests(2);
		expect(engineLoaded()).toBe(false);

		h.respond([call("background_codemode", { code: "return 1", name: "first" }), say("started"), say("woke")]);
		await h.session.prompt("start");
		await h.waitForRequests(5);
		expect(engineLoaded()).toBe(true);
	});

	it("keeps the loaded sandbox across reload", async () => {
		const h = await start();
		h.respond([call("background_codemode", { code: "return 1", name: "warm" }), say("started"), say("woke")]);
		await h.session.prompt("go");
		await h.waitForRequests(3);
		const before = reloadSlot<EngineCache>("background", "engine", 1, createEngineCache).engine;

		await h.session.reload();
		const after = reloadSlot<EngineCache>("background", "engine", 1, createEngineCache);
		expect(after.loaded).toBe(true);
		expect(after.engine).toBe(before);
	});

	it("runs a script that calls a tool, emits 3 lines, and returns a value", async () => {
		const h = await start();
		const code = `const echoed = await tools.echo({ text: "one" }); emit(echoed); emit("two"); emit("three"); console.log("logged"); return { done: true };`;
		h.respond([call("background_codemode", { code, name: "s1" }), say("started"), say("woke")]);
		await h.session.prompt("go");
		await h.waitForRequests(3);

		expect(toolTexts(h.requests[1])[0]).toContain('Started background script "s1".');
		const digest = wakes(h, "background")[0] ?? "";
		expect(digest).toMatch(/^Background script "s1" ended: ok after /);
		expect(digest).toContain('echo one\ntwo\nthree\nlogged\nReturned: {"done":true}');
		const logFile = findJob(registry(), "s1")?.sink.path ?? "";
		expect(digest).toContain(`Full log: ${logFile}`);
		const log = readFileSync(logFile, "utf8");
		expect(log).toContain('# | const echoed = await tools.echo({ text: "one" });');
		expect(log).toContain('echo one\ntwo\nthree\nlogged\nReturned: {"done":true}\n');
		expect(statSync(logFile).mode & 0o777).toBe(0o600);
	});

	it("waits with sleep and fails a script that waits on a promise that never settles", async () => {
		const h = await start();
		h.respond([
			call("background_codemode", {
				code: `const t = Date.now(); await sleep(200); emit("slept " + (Date.now() - t >= 190));`,
				name: "nap",
			}),
			call("background_codemode", { code: "await new Promise(() => {});", name: "stuck" }),
			say("started"),
			say("woke"),
			say("woke"),
		]);
		await h.session.prompt("go");
		await until(() => wakes(h, "background").length === 2);
		await h.session.waitForIdle();

		const all = wakes(h, "background").join("\n");
		expect(all).toContain('Background script "nap" ended: ok');
		expect(all).toContain("slept true");
		expect(all).toContain('Background script "stuck" ended: error');
		expect(all).toContain("Script error: The script is waiting on a promise that can never settle");
	});

	it("turns a failed tool call into a script error and an error digest", async () => {
		const h = await start();
		h.respond([
			call("background_codemode", { code: "await tools.fail({});", name: "bad" }),
			say("started"),
			say("woke"),
		]);
		await h.session.prompt("go");
		await h.waitForRequests(3);

		const digest = wakes(h, "background")[0] ?? "";
		expect(digest).toMatch(/^Background script "bad" ended: error/);
		expect(digest).toContain("Script error: the tool failed on purpose");
	});

	it("keeps a long script error inside the digest budget", async () => {
		const h = await start();
		const code = `throw new Error("x".repeat(100000));`;
		h.respond([call("background_codemode", { code, name: "big" }), say("started"), say("woke")]);
		await h.session.prompt("go");
		await h.waitForRequests(3);

		const digest = wakes(h, "background")[0] ?? "";
		expect(digest).toMatch(/^Background script "big" ended: error/);
		expect(digest).toContain("Script error: xxx");
		expect(digest).not.toMatch(/^Error: /m);
		expect(digest.length).toBeLessThan(SCRIPT_EXIT_BUDGET.maxTotalChars + 500);
		expect(readFileSync(findJob(registry(), "big")?.sink.path ?? "", "utf8")).toContain("x".repeat(100_000));
	});

	it("wakes once with a timeout digest when a script hits its deadline, also with notifyExit false", async () => {
		const h = await start();
		const code = "for (;;) { await sleep(50); }";
		h.respond([
			call("background_codemode", { code, name: "slow", timeoutMs: 200, notifyExit: false }),
			say("started"),
			say("woke"),
		]);
		await h.session.prompt("go");
		await h.waitForRequests(3);
		await new Promise((resolve) => setTimeout(resolve, 200));

		const all = wakes(h, "background");
		expect(all).toHaveLength(1);
		expect(all[0]).toMatch(/^Background script "slow" ended: timeout after /);
		expect(findJob(registry(), "slow")?.exitStatus).toBe("timeout");
	});

	it("runs a script with timeoutMs 0 without a deadline", async () => {
		const h = await start();
		h.respond([
			call("background_codemode", { code: `await sleep(300); return "late";`, name: "open", timeoutMs: 0 }),
			say("started"),
			say("woke"),
		]);
		await h.session.prompt("go");
		await h.waitForRequests(3);

		expect(findJob(registry(), "open")?.options.timeoutMs).toBe(0);
		expect(wakes(h, "background")[0]).toContain("ended: ok");
		expect(wakes(h, "background")[0]).toContain("Returned: late");
	});

	it("refuses monitor edits that a script monitor cannot follow", async () => {
		const h = await start();
		h.respond([
			call("monitor_codemode", { code: LONG_SCRIPT, name: "ed" }),
			call("monitor", { action: "edit", name: "ed", timeoutMs: 100 }),
			call("monitor", { action: "edit", name: "ed", stream: "stderr" }),
			call("monitor", { action: "edit", name: "ed", ignoreCase: true }),
			call("monitor", { action: "edit", name: "ed", match: "tick 3", ignoreCase: true }),
			say("done"),
		]);
		await h.session.prompt("go");
		await h.waitForRequests(6);

		const results = toolTexts(h.requests[5]);
		expect(results[1]).toBe(
			'"ed" is a script monitor. Its deadline and stream are fixed at start; edit cannot change timeoutMs or stream.',
		);
		expect(results[2]).toBe(results[1]);
		expect(results[3]).toBe('"ed" matches every line. ignoreCase and regex need match; pass match too.');
		expect(results[4]).toMatch(/^Edited monitor "ed": match="tick 3" \(literal, ignoreCase\)/);
		expect(findJob(registry(), "ed")?.options.timeoutMs).toBe(0);
	});

	it("resolves a tool with an output schema to its structured content, also on error, as pi's codemode does", async () => {
		const h = await start();
		const code = `const value = await tools.structured({}); return value;`;
		h.respond([call("background_codemode", { code, name: "shape" }), say("started"), say("woke")]);
		await h.session.prompt("go");
		await h.waitForRequests(3);

		const digest = wakes(h, "background")[0] ?? "";
		expect(digest).toContain("ended: ok");
		expect(digest).toContain('Returned: {"state":"failed"}');
	});

	it("does not give scripts the script tools", async () => {
		const h = await start();
		const code = [
			"emit(String(ALL_TOOLS.some((tool) => tool.name.endsWith('_codemode'))));",
			"emit(String(ALL_TOOLS.some((tool) => tool.name === 'background')));",
			"try { await tools.background_codemode({ code: 'return 1' }); emit('started'); } catch (error) { emit('refused'); }",
		].join("\n");
		h.respond([call("background_codemode", { code, name: "reach" }), say("started"), say("woke")]);
		await h.session.prompt("go");
		await h.waitForRequests(3);

		expect(wakes(h, "background")[0]).toContain("false\ntrue\nrefused");
	});

	it("lists, reads, and stops a script job through background, with no exit wake", async () => {
		const h = await start();
		h.respond([call("background_codemode", { code: LONG_SCRIPT, name: "ticker" }), say("started")]);
		await h.session.prompt("go");
		await h.waitForRequests(2);
		await until(() => (findJob(registry(), "ticker")?.totalLines ?? 0) >= 2);

		await h.session.prompt("/background list");
		expect(h.uiNotices.at(-1)).toMatch(/^- ticker \[background script\] up /);
		expect(h.uiNotices.at(-1)).toContain("code: script: for (let i = 0; ; i++)");
		await h.session.prompt("/background logs ticker");
		expect(h.uiNotices.at(-1)).toContain("tick 0\ntick 1");
		await h.session.prompt("/background stop ticker");
		expect(h.uiNotices.at(-1)).toMatch(/^background "ticker": aborted in /);

		expect(findJob(registry(), "ticker")?.exitStatus).toBe("aborted");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(wakes(h, "background")).toEqual([]);
		expect(h.requests).toHaveLength(2);
	});

	it("wakes a script monitor only for emitted lines that match", async () => {
		const h = await start();
		const code = `// watch\nemit("noise 1"); emit("READY 2"); emit("noise 3"); await sleep(100);`;
		h.respond([call("monitor_codemode", { code, name: "watch", match: "READY" }), say("started"), say("woke")]);
		await h.session.prompt("go");
		await h.waitForRequests(3);
		await until(() => findJob(registry(), "watch")?.exitedAt !== undefined);

		const all = wakes(h, "monitor");
		expect(all).toHaveLength(1);
		expect(all[0]).toContain('Monitor "watch" matched 1 line(s).');
		expect(all[0]).toContain("READY 2");
		expect(all[0]).not.toContain("noise");
	});

	it("wakes a script monitor without match on every emitted line, batched", async () => {
		const h = await start();
		const code = `emit("a"); emit("b"); emit("c"); await sleep(600);`;
		h.respond([call("monitor_codemode", { code, name: "every" }), say("started"), say("woke")]);
		await h.session.prompt("go");
		await h.waitForRequests(3);
		await until(() => findJob(registry(), "every")?.exitedAt !== undefined);

		const all = wakes(h, "monitor");
		expect(all).toHaveLength(1);
		expect(all[0]).toContain('Monitor "every" matched 3 line(s).');
		expect(all[0]).toContain("Pattern: every line");
	});

	it("stops a script monitor with once after the first batch", async () => {
		const h = await start();
		const code = `emit("hit 1"); await sleep(1000); emit("hit 2"); await sleep(1000);`;
		h.respond([
			call("monitor_codemode", { code, name: "first", match: "hit", once: true }),
			say("started"),
			say("woke"),
		]);
		await h.session.prompt("go");
		await h.waitForRequests(3);
		await until(() => findJob(registry(), "first")?.exitedAt !== undefined);
		await new Promise((resolve) => setTimeout(resolve, 1200));

		const all = wakes(h, "monitor");
		expect(all).toHaveLength(1);
		expect(all[0]).toContain("hit 1");
		const state = findJob(registry(), "first");
		expect(state?.exitStatus).toBe("stopped (matched once)");
		const log = readFileSync(state?.sink.path ?? "", "utf8");
		expect(log).toContain("# pi: stopping (matched once)");
		expect(log).toContain("Script stopped (matched once)");
		expect(log).not.toContain("aborted");
	});

	it("aborts running script jobs at reload, keeps them listed, wakes no model, and says so once", async () => {
		const h = await start();
		h.respond([
			call("background_codemode", { code: LONG_SCRIPT, name: "r1" }),
			call("monitor_codemode", { code: LONG_SCRIPT, name: "r2", match: "never" }),
			say("started"),
		]);
		await h.session.prompt("go");
		await h.waitForRequests(3);

		await h.session.reload();
		await until(
			() => findJob(registry(), "r1")?.exitStatus === "aborted" && findJob(registry(), "r2")?.exitStatus === "aborted",
		);
		expect(findJob(registry(), "r1")?.exitStatus).toBe("aborted");
		expect(findJob(registry(), "r2")?.exitStatus).toBe("aborted");
		expect(h.uiNotices.filter((text) => text.startsWith("Script jobs stopped at reload:"))).toEqual([
			"Script jobs stopped at reload: r1, r2",
		]);
		await h.session.prompt("/background list");
		expect(h.uiNotices.at(-1)).toContain("r1 script (aborted)");
		expect(h.requests).toHaveLength(3);
		expect(wakes(h, "background")).toEqual([]);

		await h.session.reload();
		expect(h.uiNotices.filter((text) => text.startsWith("Script jobs stopped"))).toHaveLength(1);
	});

	it("keeps no notice for script jobs stopped at quit", async () => {
		const h = await start();
		h.respond([call("background_codemode", { code: LONG_SCRIPT, name: "q1" }), say("started")]);
		await h.session.prompt("go");
		await h.waitForRequests(2);

		await h.shutdown();
		expect(findJob(registry(), "q1")?.exitStatus).toBe("aborted");
		expect(reloadSlot<ScriptStore>("background", "scripts", 1, createScriptStore).stopped.size).toBe(0);
	});

	it("says which script jobs a session switch stopped when that session starts again", async () => {
		const h = await start();
		h.respond([call("background_codemode", { code: LONG_SCRIPT, name: "sw" }), say("started")]);
		await h.session.prompt("go");
		await h.waitForRequests(2);

		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
		expect(findJob(registry(), "sw")?.exitStatus).toBe("aborted");
		await h.session.extensionRunner.emit({ type: "session_start", reason: "resume" });
		expect(h.uiNotices).toContain("Script jobs stopped at session switch: sw");
	});

	it("refuses a fifth running script job and names the running ones", async () => {
		const h = await start();
		h.respond([
			...[1, 2, 3, 4, 5].map((n) => call("background_codemode", { code: LONG_SCRIPT, name: `j${n}` })),
			say("started"),
		]);
		await h.session.prompt("go");
		await h.waitForRequests(6);

		const results = toolTexts(h.requests[5]);
		expect(results[4]).toBe(
			"Too many script jobs: 4 of 4 run now (j1, j2, j3, j4). Stop one with background action=stop before starting another.",
		);
		expect(findJob(registry(), "j5")).toBeUndefined();
	});

	it("redacts a secret that a script reads through a tool", async () => {
		const askSecret = createAskSecret({ alert: () => {} });
		const h = await start([askSecret, background, probe]);
		const code = `const value = await tools.leak({}); emit("read " + value); return value;`;
		h.respond([call("background_codemode", { code, name: "secret" }), say("started"), say("woke")]);
		await h.session.prompt(`use [[secret DB:${SECRET}]] in a script`);
		await h.waitForRequests(3);

		const digest = wakes(h, "background")[0] ?? "";
		expect(digest).toContain("read $PI_SECRET_DB");
		expect(digest).not.toContain(SECRET);
		expect(readFileSync(findJob(registry(), "secret")?.sink.path ?? "", "utf8")).not.toContain(SECRET);
		expect(JSON.stringify(h.requests)).not.toContain(SECRET);
	});
});
