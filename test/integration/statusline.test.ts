import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ExecFn, ExecResult } from "../../src/core/exec.ts";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { createStatuslineFeature, type StatuslineFeatureOptions } from "../../src/features/statusline/index.ts";
import type { PimonEventBus } from "../../src/core/events.ts";
import { type AnyFeature, defineFeature } from "../../src/core/feature.ts";
import { background } from "../../src/features/background/index.ts";
import { clearAllTimers, createTimerStore, type TimerStore } from "../../src/features/background/timers.ts";
import { createGoalFeature } from "../../src/features/goal/index.ts";
import { createNotifyFeature } from "../../src/features/notify/index.ts";
import { reloadSlot } from "../../src/core/reload-state.ts";
import { createHarness, type Harness } from "../support/harness.ts";

type FooterFactory = Parameters<ExtensionUIContext["setFooter"]>[0];
type FooterData = Parameters<NonNullable<FooterFactory>>[2];

const COLORS: Record<string, number> = {
	error: 31,
	success: 32,
	warning: 33,
	accent: 34,
	muted: 35,
	dim: 90,
	text: 37,
};
const theme = {
	fg: (color: string, text: string) => `\x1b[${COLORS[color] ?? 39}m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;
// oxlint-disable-next-line no-control-regex
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

const ACCESS = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.y`;
const OAUTH = { type: "oauth", access: ACCESS, refresh: "refresh-token", expires: Date.now() + 3_600_000 };

let harness: Harness | undefined;
const timerStore = () => reloadSlot<TimerStore>("background", "timers", 1, createTimerStore);

afterEach(() => {
	clearAllTimers(timerStore());
	harness?.dispose();
	harness = undefined;
	clearReloadState();
});

interface StartOptions extends StatuslineFeatureOptions {
	config?: Record<string, unknown>;
	auth?: Record<string, unknown>;
	hasUI?: boolean;
	/** Features that load before the statusline, as in the real feature list. */
	before?: AnyFeature[];
	/** A host with a UI that ignores custom footers, like RPC mode. */
	dropFooter?: boolean;
}

function gitRecorder(stdout = "## feature...origin/feature [ahead 1]\n M a.ts\n") {
	const calls: string[][] = [];
	const exec: ExecFn = async (_command, args): Promise<ExecResult> => {
		calls.push(args);
		return { code: 0, stdout, stderr: "" };
	};
	return { calls, exec };
}

function usageFetch() {
	const urls: string[] = [];
	const fetchFn = (async (url: string) => {
		urls.push(url);
		if (url.includes("chatgpt.com"))
			return Response.json({
				rate_limit: { primary_window: { used_percent: 61 }, secondary_window: { used_percent: 5 } },
			});
		return Response.json({ five_hour: { utilization: 33 }, seven_day: { utilization: 2 } });
	}) as typeof fetch;
	return { urls, fetch: fetchFn };
}

async function start(options: StartOptions = {}) {
	let factory: FooterFactory;
	let pi: ExtensionAPI | undefined;
	let events: PimonEventBus | undefined;
	const eventsProbe = defineFeature({
		id: "events-probe",
		description: "test probe",
		defaultEnabled: true,
		setup(ctx) {
			events = ctx.events;
		},
	});
	const indicators: unknown[] = [];
	const cacheDir = options.cacheDir ?? join(mkdtempSync(join(tmpdir(), "statusline-cache-")), "pimon", "statusline");
	const h = await createHarness({
		features: [
			...(options.before ?? []),
			eventsProbe,
			createStatuslineFeature({ exec: gitRecorder().exec, fetch: usageFetch().fetch, ...options, cacheDir }),
		],
		setupAgentDir: (dir) => {
			if (options.config)
				writeFileSync(join(dir, "pimon.json"), JSON.stringify({ features: { statusline: options.config } }));
			if (options.auth) writeFileSync(join(dir, "auth.json"), JSON.stringify(options.auth));
		},
		extensions: [
			(api) => {
				pi = api;
			},
		],
		...(options.hasUI === false
			? {}
			: {
					ui: {
						theme,
						setFooter: (next) => {
							if (!options.dropFooter) factory = next;
						},
						setWorkingIndicator: (indicator) => {
							indicators.push(indicator);
						},
					},
				}),
	});
	harness = h;
	let renders = 0;
	const branchListeners: (() => void)[] = [];
	const footerData: FooterData = {
		getGitBranch: () => "fallback-branch",
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 1,
		onBranchChange: (callback) => {
			branchListeners.push(callback);
			return () => {};
		},
	};
	let component: (Component & { dispose?(): void }) | undefined;
	const mount = () => {
		if (!factory) throw new Error("statusline did not install a footer");
		const tui = { requestRender: () => renders++ } as unknown as TUI;
		component = factory(tui, theme, footerData);
		return component;
	};
	const line = (width = 200) => strip((component ?? mount()).render(width).join("\n"));
	const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
	/** Renders once and waits for the re-render that a finished usage check requests. */
	const checked = async () => {
		const before = renders;
		line();
		const deadline = Date.now() + 5_000;
		while (renders === before) {
			if (Date.now() > deadline) throw new Error("no re-render after the usage check");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	return {
		h,
		pi: () => {
			if (!pi) throw new Error("no pi");
			return pi;
		},
		/** Publishes on the pimon event bus, like the goal feature. */
		goal: (payload: { state?: string; turns?: number; timerDueAt?: number }) => {
			if (!events) throw new Error("no pimon events");
			events.emit("goal:state", payload);
		},
		indicators,
		cacheDir,
		hasFooter: () => factory !== undefined,
		mount,
		line,
		settle,
		checked,
		renders: () => renders,
		branchChanged: () => {
			for (const listener of branchListeners) listener();
		},
	};
}

async function runTurn(h: Harness) {
	const count = h.requests.length + 1;
	h.respond([fauxAssistantMessage(fauxText("ok"))]);
	await h.session.prompt("go");
	await h.waitForRequests(count);
}

async function useModel(h: Harness, provider: string) {
	// The harness skips the startup refresh that loads stored credentials into the auth snapshot.
	await h.modelRuntime.refresh({ allowNetwork: false });
	const model = h.modelRuntime.getModels(provider)[0];
	if (!model) throw new Error(`no ${provider} model`);
	await h.session.setModel(model);
	return model;
}

describe("statusline footer", () => {
	it("installs the footer and the working indicator when the host has a UI", async () => {
		const s = await start();
		expect(s.hasFooter()).toBe(true);
		expect(s.indicators).toEqual([{ frames: expect.any(Array), intervalMs: 140 }]);
		expect((s.indicators[0] as { frames: string[] }).frames.map(strip)).toEqual(["·", "•", "*", "•"]);
	});

	it("installs nothing and runs no git without a UI", async () => {
		const git = gitRecorder();
		const s = await start({ hasUI: false, exec: git.exec });
		expect(s.hasFooter()).toBe(false);
		expect(git.calls).toHaveLength(0);
	});

	it("runs no git when the host never builds the footer", async () => {
		const git = gitRecorder();
		const s = await start({ dropFooter: true, exec: git.exec });
		await runTurn(s.h);
		expect(s.hasFooter()).toBe(false);
		expect(git.calls).toHaveLength(0);
	});

	it("stops git triggers after the footer is disposed", async () => {
		let now = 1_000_000;
		const git = gitRecorder();
		const s = await start({ exec: git.exec, now: () => now });
		s.mount().dispose?.();
		const before = git.calls.length;
		now += 60_000;
		await runTurn(s.h);
		expect(git.calls).toHaveLength(before);
	});

	it("polls usage at the configured interval", async () => {
		let now = Date.now();
		const usage = usageFetch();
		const s = await start({
			auth: { "openai-codex": OAUTH },
			fetch: usage.fetch,
			now: () => now,
			config: { usagePollSeconds: 30 },
		});
		await useModel(s.h, "openai-codex");
		await s.checked();
		now += 29_999;
		s.line();
		await s.settle();
		expect(usage.urls).toHaveLength(1);
		now += 1;
		await s.checked();
		expect(usage.urls).toHaveLength(2);
	});

	it("recomputes totals after an entry was added and the leaf moved back between renders", async () => {
		const s = await start();
		const sm = s.h.session.sessionManager;
		const leaf = sm.getLeafId();
		expect(s.line()).not.toContain("$");
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "x" }],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
			},
			stopReason: "stop",
			timestamp: 0,
		});
		if (leaf) sm.branch(leaf);
		else sm.resetLeaf();
		expect(s.line()).toContain("$0.50");
	});

	it("shows path, git status, model, and context on one line", async () => {
		const s = await start();
		s.line(200);
		await s.settle();
		const line = s.line(200);
		expect(line).toContain("feature *1 ↑1");
		expect(line).toMatch(/faux - .+ - off/);
		expect(line).toContain("0/");
		expect(line).toHaveLength(200);
	});

	it("shows only the footer branch when git status is off, and runs no git", async () => {
		const git = gitRecorder();
		const s = await start({ config: { gitStatus: false }, exec: git.exec });
		s.mount();
		s.branchChanged();
		s.line();
		await runTurn(s.h);
		expect(git.calls).toHaveLength(0);
		expect(s.line()).toContain("fallback-branch");
	});

	it("shows codex limits for openai-codex", async () => {
		const usage = usageFetch();
		const s = await start({ auth: { "openai-codex": OAUTH }, fetch: usage.fetch });
		await useModel(s.h, "openai-codex");
		await s.checked();
		expect(usage.urls).toEqual(["https://chatgpt.com/backend-api/wham/usage"]);
		expect(s.line()).toContain("61% 5%");
	});

	it("shows anthropic limits for anthropic", async () => {
		const usage = usageFetch();
		const s = await start({ auth: { anthropic: OAUTH }, fetch: usage.fetch });
		await useModel(s.h, "anthropic");
		await s.checked();
		expect(usage.urls).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
		expect(s.line()).toContain("33% 2%");
	});

	it("shows no codex limits after a switch to a provider without a usage endpoint", async () => {
		const usage = usageFetch();
		const s = await start({ auth: { "openai-codex": OAUTH }, fetch: usage.fetch });
		await useModel(s.h, "openai-codex");
		await s.checked();
		expect(s.line()).toContain("61%");
		const faux = s.h.modelRuntime.getModels().find((candidate) => candidate.provider.startsWith("faux"));
		if (!faux) throw new Error("no faux model");
		await s.h.session.setModel(faux);
		expect(s.line()).not.toContain("61%");
		expect(usage.urls).toHaveLength(1);
	});

	it("makes no usage request for an API key credential", async () => {
		const usage = usageFetch();
		const s = await start({ auth: { anthropic: { type: "api_key", key: "sk-test" } }, fetch: usage.fetch });
		await useModel(s.h, "anthropic");
		s.line();
		await s.settle();
		expect(usage.urls).toHaveLength(0);
	});

	it("makes no usage request when usage is off", async () => {
		const usage = usageFetch();
		const s = await start({ auth: { "openai-codex": OAUTH }, fetch: usage.fetch, config: { usage: false } });
		await useModel(s.h, "openai-codex");
		s.line();
		await s.settle();
		expect(usage.urls).toHaveLength(0);
		expect(existsSync(s.cacheDir)).toBe(false);
	});

	it("takes the token from pi and leaves auth.json untouched", async () => {
		const usage = usageFetch();
		const s = await start({ auth: { "openai-codex": OAUTH }, fetch: usage.fetch });
		await useModel(s.h, "openai-codex");
		const authPath = join(s.h.agentDir, "auth.json");
		const before = statSync(authPath).mtimeMs;
		await s.checked();
		expect(usage.urls).toHaveLength(1);
		expect(statSync(authPath).mtimeMs).toBe(before);
		for (const name of readdirSync(s.cacheDir)) expect(name).not.toContain("claim");
	});

	it("drops the bus segment first on a narrow terminal", async () => {
		const s = await start();
		s.pi().events.emit("pi-bus:identity", { name: "worker-1", role: "worker" });
		s.goal({ state: "active", turns: 3 });
		const wide = s.line(200);
		expect(wide).toContain("worker-1:worker");
		expect(wide).toContain("goal 3");
		const gap = / +(?=faux - )/.exec(wide)?.[0].length ?? 0;
		const narrow = s.line(wide.length - gap);
		expect(narrow).not.toContain("worker-1");
		expect(narrow).toContain("goal 3");
	});
});

describe("statusline events", () => {
	it("re-renders with a new bus identity and goal state", async () => {
		const s = await start();
		s.mount();
		const before = s.renders();
		s.pi().events.emit("pi-bus:identity", { name: "mars", role: "coordinator" });
		s.goal({ state: "paused", turns: 2 });
		expect(s.renders()).toBe(before + 2);
		const line = s.line();
		expect(line).toContain("mars:coordinator");
		expect(line).toContain("goal paused");
	});

	it("asks the bus to publish again at session start and footer install", async () => {
		let refreshes = 0;
		const s = await start();
		s.pi().events.on("pi-bus:refresh", () => refreshes++);
		s.mount();
		expect(refreshes).toBe(1);
		await s.h.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		expect(refreshes).toBe(2);
	});

	it("clears the bus identity at session start and keeps the last goal state", async () => {
		const s = await start();
		s.pi().events.emit("pi-bus:identity", { name: "mars" });
		s.goal({ state: "active", turns: 1 });
		expect(s.line()).toContain("goal 1");
		await s.h.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		const line = s.line();
		expect(line).not.toContain("mars");
		expect(line).toContain("goal 1");
	});

	it("ignores a goal state on pi.events", async () => {
		const s = await start();
		s.pi().events.emit("goal:state", { state: "active", turns: 4 });
		expect(s.line()).not.toContain("goal");
	});

	it("ignores the retired mesh identity event", async () => {
		const s = await start();
		s.pi().events.emit("pi-mesh:identity", { name: "ghost" });
		expect(s.line()).not.toContain("ghost");
	});
});

describe("statusline git triggers", () => {
	it("checks git at session start, turn end, and branch change, spaced 2 s apart", async () => {
		let now = 1_000_000;
		const git = gitRecorder();
		const s = await start({ exec: git.exec, now: () => now });
		expect(git.calls).toHaveLength(0);
		s.mount();
		await s.h.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		expect(git.calls).toHaveLength(1);
		expect(git.calls[0]?.[0]).toBe("--no-optional-locks");
		s.branchChanged();
		expect(git.calls).toHaveLength(1);
		now += 2_000;
		s.line();
		expect(git.calls).toHaveLength(2);
		await s.settle();
		now += 2_000;
		await runTurn(s.h);
		expect(git.calls).toHaveLength(3);
	});
});

describe("statusline shutdown", () => {
	it("aborts the usage fetch, removes the claim, and stops rendering", async () => {
		let started!: () => void;
		const fetchStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let aborted = false;
		const fetchFn = ((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					aborted = true;
					reject(init.signal?.reason);
				});
				started();
			})) as typeof fetch;
		const s = await start({ auth: { "openai-codex": OAUTH }, fetch: fetchFn });
		await useModel(s.h, "openai-codex");
		s.line();
		await fetchStarted;
		expect(readdirSync(s.cacheDir).some((name) => name.endsWith(".claim"))).toBe(true);
		const renders = s.renders();
		await s.h.shutdown();
		await s.settle();
		expect(aborted).toBe(true);
		expect(readdirSync(s.cacheDir)).toEqual([]);
		s.goal({ state: "active", turns: 1 });
		expect(s.renders()).toBe(renders);
	});
});

describe("statusline with the goal feature", () => {
	const quiet: ExecFn = async () => ({ code: 0, stdout: "", stderr: "" });

	it("shows the goal and its wake time after a reload with no human action", async () => {
		const s = await start({
			before: [background, createNotifyFeature({ exec: quiet }), createGoalFeature({ exec: quiet })],
		});
		s.h.respond([
			fauxAssistantMessage(fauxToolCall("timer", { action: "set", delaySeconds: 600, reason: "ci" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxText("waiting")),
		]);
		await s.h.session.prompt("/goal ship it");
		await s.h.waitForRequests(2);
		await s.settle();
		expect(s.line()).toMatch(/goal \d+ wake \d\d:\d\d/);

		await s.h.session.reload();
		s.mount();
		expect(s.line()).toMatch(/goal \d+ wake \d\d:\d\d/);
	});

	it("shows no goal when the goal feature is off", async () => {
		const s = await start();
		expect(s.line()).not.toContain("goal");
	});
});
