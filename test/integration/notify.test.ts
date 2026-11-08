import { existsSync, readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ExecFn, ExecOptions } from "../../src/core/exec.ts";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { createNotifyFeature } from "../../src/features/notify/index.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const call = (args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall("notify", args), { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage(fauxText(text));
const toolTexts = (messages: Message[] | undefined) =>
	(messages ?? [])
		.filter((message) => message.role === "toolResult")
		.map((message) => message.content.map((block) => (block.type === "text" ? block.text : "")).join(""));

interface Call {
	command: string;
	args: string[];
	options?: ExecOptions | undefined;
}

let harness: Harness | undefined;
afterEach(() => {
	harness?.dispose();
	harness = undefined;
	clearReloadState();
});

async function start(exec: ExecFn) {
	harness = await createHarness({ features: [createNotifyFeature({ exec })] });
	return harness;
}

function recorder() {
	const calls: Call[] = [];
	const exec: ExecFn = async (command, args, options) => {
		calls.push({ command, args, options });
		if (command === "kdeconnect-cli" && args[0] === "-a") return { code: 0, stdout: "phone_0001\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	return { calls, exec };
}

describe("notify in a session", () => {
	it("sends titled notifications through the injected exec, and dedupes by message and detail", async () => {
		const { calls, exec } = recorder();
		const h = await start(exec);
		h.respond([
			call({ kind: "done", message: "build finished", detail: "first" }),
			call({ kind: "done", message: "build finished", detail: "first" }),
			call({ kind: "done", message: "build finished", detail: "second" }),
			call({ kind: "info", message: "fyi" }),
			say("done"),
		]);
		await h.session.prompt("tell me");
		await h.waitForRequests(5);

		const results = toolTexts(h.requests[4]);
		expect(results[0]).toContain("Notified via desktop");
		expect(results[1]).toBe("Not sent: the same notification went out moments ago.");
		expect(results[2]).toContain("Notified via desktop");
		const desktop = calls.filter((entry) => entry.command === "notify-send").map((entry) => entry.args);
		expect(desktop).toHaveLength(3);
		expect(desktop[0]).toContain("pi: done");
		expect(desktop[2]).toContain("pi");
		expect(calls.filter((entry) => entry.args.includes("--ping-msg")).map((entry) => entry.args.at(-1))).toEqual([
			"pi: done: build finished\nfirst",
			"pi: done: build finished\nsecond",
			"pi: fyi",
		]);
	});

	it("starts desktop and phone together, and Esc cancels the fan-out through the tool signal", async () => {
		const started: Call[] = [];
		const exec: ExecFn = (command, args, options) => {
			started.push({ command, args, options });
			return new Promise((resolve) => {
				options?.signal?.addEventListener("abort", () =>
					resolve({ code: -1, stdout: "", stderr: "cancelled", failed: "aborted" }),
				);
			});
		};
		const h = await start(exec);
		h.respond([call({ kind: "info", message: "slow" }), say("after")]);
		const running = h.session.prompt("go");
		const deadline = Date.now() + 5_000;
		while (started.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(started.map((entry) => entry.command)).toEqual(["notify-send", "kdeconnect-cli"]);
		await h.session.abort();
		await running;
		expect(started.every((entry) => entry.options?.signal?.aborted)).toBe(true);
	});

	it("never reaches the real notifier binaries", async () => {
		const log = process.env["PIMON_TEST_STUB_LOG"];
		const read = () => (log && existsSync(log) ? readFileSync(log, "utf8") : "");
		const before = read().length;
		const { calls, exec } = recorder();
		const h = await start(exec);
		h.respond([call({ kind: "blocked", message: "needs a key" })]);
		await h.session.prompt("go");
		await h.waitForRequests(1);
		expect(calls.some((entry) => entry.command === "notify-send")).toBe(true);
		expect(read().slice(before)).not.toMatch(/notify-send|kdeconnect-cli/);
	});
});
