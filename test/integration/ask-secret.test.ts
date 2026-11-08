import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { defineFeature } from "../../src/core/feature.ts";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { ASKPASS_CLIENT, createAskSecret, REMOVED_OUTPUT } from "../../src/features/ask-secret/index.ts";
import { background } from "../../src/features/background/index.ts";
import { createGoalFeature } from "../../src/features/goal/index.ts";
import { latestFromEntries } from "../../src/features/goal/state.ts";
import { createNotifyFeature } from "../../src/features/notify/index.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const SECRET = "s3cr3t-value";
const alerts: string[] = [];
const askSecret = createAskSecret({ alert: (_pi, text) => alerts.push(text) });
let leakValue = SECRET;

const leaky = defineFeature({
	id: "leaky",
	description: "test tool that echoes a secret in content and details",
	defaultEnabled: true,
	setup(ctx) {
		ctx.pi.registerTool({
			name: "leak",
			label: "Leak",
			description: "Return the value",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `got ${leakValue}` }],
				details: { nested: { token: leakValue } },
			}),
		});
	},
});

const call = (name: string, args: Record<string, string>) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

function runClient(env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string; err: string }> {
	return new Promise((resolve) => {
		const child = spawn(ASKPASS_CLIENT, ["[sudo] password for x:"], { env });
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
		child.on("close", (code) => resolve({ code, out, err }));
	});
}

const ENV_KEYS = ["PI_ASK_SECRET_SOCK", "SUDO_ASKPASS", "XDG_RUNTIME_DIR", "PI_SECRET_DB"];
const isolated = (key: string) => ENV_KEYS.includes(key) || key.startsWith("HERDR_") || key.startsWith("PI_BUS_");

describe("ask-secret in a session", () => {
	let harness: Harness | undefined;
	let saved: Record<string, string | undefined> = {};
	const cleanup: string[] = [];

	beforeEach(() => {
		saved = Object.fromEntries(
			[...new Set([...ENV_KEYS, ...Object.keys(process.env)])].filter(isolated).map((key) => [key, process.env[key]]),
		);
		for (const key of Object.keys(saved)) delete process.env[key];
		alerts.length = 0;
		leakValue = SECRET;
	});

	afterEach(async () => {
		await harness?.shutdown();
		harness?.dispose();
		harness = undefined;
		clearReloadState();
		for (const key of Object.keys(saved)) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	it("sends the handle, not the value, of a secret tag", async () => {
		harness = await createHarness({ features: [askSecret] });
		harness.respond([fauxAssistantMessage(fauxText("ok"))]);
		await harness.session.prompt(`use [[secret DB:${SECRET}]] now`);

		const request = JSON.stringify(harness.requests[0]);
		expect(request).toContain("use $PI_SECRET_DB now");
		expect(request).not.toContain(SECRET);
		expect(JSON.stringify(harness.session.sessionManager.getEntries())).not.toContain(SECRET);
	});

	it("stores the handle, not the value, as the human request of a goal the model sets", async () => {
		const quiet = async () => ({ code: 0, stdout: "", stderr: "" });
		harness = await createHarness({
			features: [background, createNotifyFeature({ exec: quiet }), createGoalFeature({ exec: quiet }), askSecret],
		});
		harness.respond([
			call("goal_set", { action: "create", objective: "The deploy with the DB key is done." }),
			call("notify", { kind: "blocked", message: "needs a decision" }),
		]);
		await harness.session.prompt(`keep going until it is deployed with [[secret DB:${SECRET}]]`);
		await harness.waitForRequests(2);

		const record = latestFromEntries(harness.session.sessionManager.getBranch());
		expect(record?.condition).toBe("keep going until it is deployed with $PI_SECRET_DB");
		expect(JSON.stringify(harness.session.sessionManager.getEntries())).not.toContain(SECRET);
	});

	it("redacts a tool value in content and details, in requests and session entries", async () => {
		harness = await createHarness({ features: [askSecret, leaky] });
		harness.respond([call("leak", {}), fauxAssistantMessage(fauxText("done"))]);
		await harness.session.prompt(`remember [[secret DB:${SECRET}]]`);

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toMatchObject({ details: { nested: { token: "$PI_SECRET_DB" } } });
		expect(JSON.stringify(harness.requests)).not.toContain(SECRET);
		expect(JSON.stringify(harness.requests.at(-1))).toContain("got $PI_SECRET_DB");
		expect(JSON.stringify(harness.session.sessionManager.getEntries())).not.toContain(SECRET);
	});

	it("blocks a bash command that expands an unknown handle", async () => {
		harness = await createHarness({ features: [askSecret] });
		harness.respond([call("bash", { command: "echo $PI_SECRET_X" }), fauxAssistantMessage(fauxText("done"))]);
		await harness.session.prompt("run it");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toMatchObject({ isError: true });
		expect(JSON.stringify(toolResult)).toContain("Unknown or expired secret handle: $PI_SECRET_X");
	});

	it("lets a known handle through and clears it on shutdown", async () => {
		harness = await createHarness({ features: [askSecret] });
		harness.respond([call("bash", { command: 'echo "len=${#PI_SECRET_DB}"' }), fauxAssistantMessage(fauxText("done"))]);
		await harness.session.prompt(`use [[secret DB:${SECRET}]]`);

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toMatchObject({ isError: false });
		expect(JSON.stringify(toolResult)).toContain(`len=${SECRET.length}`);
		expect(process.env["PI_SECRET_DB"]).toBe(SECRET);
		await harness.shutdown();
		expect(process.env["PI_SECRET_DB"]).toBeUndefined();
	});

	it("blocks an oversize tag and puts the text back in the editor", async () => {
		let editor = "";
		harness = await createHarness({
			features: [askSecret],
			ui: { getEditorText: () => editor, setEditorText: (text) => (editor = text) },
		});
		harness.respond([fauxAssistantMessage(fauxText("ok"))]);
		const text = `[[secret:${"x".repeat(64 * 1024 + 1)}]]`;
		await harness.session.prompt(text);

		expect(harness.requests).toEqual([]);
		expect(editor).toBe(text);
		expect(harness.notifications.at(-1)?.message).toContain("ask-secret: message not sent: secret exceeds");
	});

	it("rewrites the bash full output file without the secret", async () => {
		harness = await createHarness({ features: [askSecret] });
		harness.respond([
			call("bash", { command: 'seq 1 3000 | sed "s/$/ $PI_SECRET_DB/"' }),
			fauxAssistantMessage(fauxText("done")),
		]);
		await harness.session.prompt(`print [[secret DB:${SECRET}]]`);

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		const path = (toolResult as { details?: { fullOutputPath?: string } } | undefined)?.details?.fullOutputPath;
		expect(path).toBeTypeOf("string");
		if (!path) return;
		cleanup.push(path);
		const text = readFileSync(path, "utf8");
		expect(text).toContain("3000 $PI_SECRET_DB");
		expect(text).not.toContain(SECRET);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("removes the bash full output file content when it is above the rewrite cap", async () => {
		const capped = createAskSecret({ alert: () => {}, maxRewriteBytes: 1024 });
		harness = await createHarness({ features: [capped], ui: {} });
		harness.respond([
			call("bash", { command: 'seq 1 3000 | sed "s/$/ $PI_SECRET_DB/"' }),
			fauxAssistantMessage(fauxText("done")),
		]);
		await harness.session.prompt(`print [[secret DB:${SECRET}]]`);

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		const path = (toolResult as { details?: { fullOutputPath?: string } } | undefined)?.details?.fullOutputPath;
		expect(path).toBeTypeOf("string");
		if (!path) return;
		cleanup.push(path);
		expect(readFileSync(path, "utf8")).toBe(REMOVED_OUTPUT);
		expect(harness.notifications).toContainEqual({
			message: expect.stringContaining(`ask-secret: removed the content of ${path}`),
			level: "warning",
		});
	});

	it("drops an inherited askpass socket and client outside the TUI", async () => {
		process.env["PI_ASK_SECRET_SOCK"] = "/parent/pi-ask-secret/1.sock";
		process.env["SUDO_ASKPASS"] = "/elsewhere/pi-ask-secret";
		harness = await createHarness({ features: [askSecret], mode: "print" });
		expect(process.env["PI_ASK_SECRET_SOCK"]).toBeUndefined();
		expect(process.env["SUDO_ASKPASS"]).toBeUndefined();
	});

	it("keeps an unrelated SUDO_ASKPASS outside the TUI", async () => {
		process.env["SUDO_ASKPASS"] = "/usr/bin/ssh-askpass";
		harness = await createHarness({ features: [askSecret], mode: "rpc" });
		expect(process.env["SUDO_ASKPASS"]).toBe("/usr/bin/ssh-askpass");
	});

	it("sets no askpass env when the socket cannot listen", async () => {
		const runtimeDir = mkdtempSync(join(tmpdir(), "pimon-askpass-"));
		cleanup.push(runtimeDir);
		const blocker = join(runtimeDir, "file");
		writeFileSync(blocker, "");
		process.env["XDG_RUNTIME_DIR"] = blocker;
		delete process.env["SUDO_ASKPASS"];
		harness = await createHarness({ features: [askSecret], mode: "tui", ui: {} });
		expect(process.env["PI_ASK_SECRET_SOCK"]).toBeUndefined();
		expect(process.env["SUDO_ASKPASS"]).toBeUndefined();
		expect(harness.notifications.map((note) => note.message).join("\n")).toContain("ask-secret: cannot listen");
	});

	it("serves askpass in the TUI and redacts the reply from later tool output", async () => {
		const runtimeDir = mkdtempSync(join(tmpdir(), "pimon-askpass-"));
		cleanup.push(runtimeDir);
		process.env["XDG_RUNTIME_DIR"] = runtimeDir;
		process.env["SUDO_ASKPASS"] = "/usr/bin/ssh-askpass";
		harness = await createHarness({
			features: [askSecret, leaky],
			mode: "tui",
			ui: { custom: async () => "askpass-reply-42" as never },
		});

		const sock = process.env["PI_ASK_SECRET_SOCK"];
		expect(sock).toBe(join(runtimeDir, "pi-ask-secret", `${process.pid}.sock`));
		expect(process.env["SUDO_ASKPASS"]).toBe(ASKPASS_CLIENT);
		expect(statSync(sock ?? "").mode & 0o777).toBe(0o600);

		const reply = await runClient({ ...process.env, PI_ASK_SECRET_REASON: "unit test" });
		expect(reply).toEqual({ code: 0, out: "askpass-reply-42\n", err: "" });
		expect(alerts).toEqual(["unit test"]);
		const stubLog = process.env["PIMON_TEST_STUB_LOG"] ?? "";
		expect(stubLog).not.toBe("");
		const stubCalls = existsSync(stubLog) ? readFileSync(stubLog, "utf8") : "";
		// The log is shared by all test files, so match the ask-secret call shape only.
		expect(stubCalls).not.toMatch(/^notify-send\t.*pi-ask-secret/m);

		leakValue = "askpass-reply-42";
		harness.respond([call("leak", {}), fauxAssistantMessage(fauxText("done"))]);
		await harness.session.prompt("show it");
		expect(JSON.stringify(harness.requests)).not.toContain("askpass-reply-42");
		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toMatchObject({
			content: [{ type: "text", text: "got [askpass reply redacted]" }],
			details: { nested: { token: "[askpass reply redacted]" } },
		});
		expect(Object.keys(process.env).filter((key) => key.startsWith("PI_SECRET_"))).toEqual([]);

		await harness.shutdown();
		expect(process.env["PI_ASK_SECRET_SOCK"]).toBeUndefined();
		expect(process.env["SUDO_ASKPASS"]).toBe("/usr/bin/ssh-askpass");
		expect(() => statSync(sock ?? "")).toThrow();
	});
});
