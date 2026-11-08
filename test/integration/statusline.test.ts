import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ExecFn, ExecResult } from "../../src/core/exec.ts";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { createStatuslineFeature, type StatuslineFeatureOptions } from "../../src/features/statusline/index.ts";
import type { PimonEventBus } from "../../src/core/events.ts";
import { type AnyFeature, defineFeature } from "../../src/core/feature.ts";
import { createAgentsFeature } from "../../src/features/agents/index.ts";
import type { Placer } from "../../src/features/agents/placement.ts";
import { type AgentPaths, agentPaths, takeSpawnFile } from "../../src/features/agents/spawn-file.ts";
import { background } from "../../src/features/background/index.ts";
import { createRegistry, type JobState, type Registry } from "../../src/features/background/registry.ts";
import { shutdownJobs } from "../../src/features/background/runner.ts";
import { bus } from "../../src/features/bus/index.ts";
import { BusNode } from "../../src/features/bus/node.ts";
import { busDirs } from "../../src/features/bus/registry.ts";
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
	/** Settings of other features in `pimon.json`. */
	features?: Record<string, unknown>;
	auth?: Record<string, unknown>;
	hasUI?: boolean;
	/** Features that load before the statusline, as in the real feature list. */
	before?: AnyFeature[];
	/** A host with a UI that ignores custom footers, like RPC mode. */
	dropFooter?: boolean;
	settings?: Parameters<typeof createHarness>[0]["settings"];
	prepareAgentDir?: (dir: string) => void;
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
		...(options.settings ? { settings: options.settings } : {}),
		setupAgentDir: (dir) => {
			options.prepareAgentDir?.(dir);
			if (options.config || options.features) {
				const features = { ...options.features, ...(options.config ? { statusline: options.config } : {}) };
				writeFileSync(join(dir, "pimon.json"), JSON.stringify({ features }));
			}
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
	const usageDone = () => {
		if (!existsSync(cacheDir)) return false;
		const names = readdirSync(cacheDir);
		return names.some((name) => name.endsWith(".json")) && !names.some((name) => name.endsWith(".claim"));
	};
	/** Renders once and waits until the usage check wrote its cache, released its claim, and asked for a render. */
	const checked = async () => {
		const before = renders;
		line();
		const deadline = Date.now() + 5_000;
		// A git status result also asks for a render, so a render alone does not mean the usage check ended.
		while (renders === before || !usageDone()) {
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
		/** Publishes on the pimon event bus, like the bus feature. */
		busIdentity: (payload: { name?: string; role?: string }) => {
			if (!events) throw new Error("no pimon events");
			events.emit("bus:identity", payload);
		},
		events: () => {
			if (!events) throw new Error("no pimon events");
			return events;
		},
		/** Publishes on the pimon event bus, like the agents feature. */
		agentCounts: (payload: { active: number }) => {
			if (!events) throw new Error("no pimon events");
			events.emit("agents:counts", payload);
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

	it("measures context against the compaction threshold", async () => {
		const s = await start({ settings: { compaction: { enabled: true, reserveTokens: 28_000 } } });
		expect(s.line()).toContain("0/100k (0%)");
	});

	it("uses the per-model compaction reserve first", async () => {
		const s = await start();
		const model = s.h.session.model;
		if (!model) throw new Error("no model");
		const key = `${model.provider}/${model.id}`;
		s.h.session.settingsManager.applyOverrides({
			compaction: { enabled: true, reserveTokens: 28_000, modelOverrides: { [key]: { reserveTokens: 64_000 } } },
		});
		await runTurn(s.h);
		expect(s.line()).toMatch(/\/64k \(\d+%\)/);
	});

	it("measures context against the model window when compaction is off, from the next run", async () => {
		const s = await start({ settings: { compaction: { enabled: true, reserveTokens: 28_000 } } });
		expect(s.line()).toContain("/100k (");
		s.h.session.settingsManager.setCompactionEnabled(false);
		await runTurn(s.h);
		expect(s.line()).toMatch(/\/128k \(\d+%\)/);
	});

	it("shows tokens only when the compaction reserve leaves no room", async () => {
		const s = await start({ settings: { compaction: { enabled: true, reserveTokens: 128_000 } } });
		const line = s.line();
		expect(line).toMatch(/│ 0$/);
		expect(line).not.toContain("/128k");
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
		s.busIdentity({ name: "worker-1", role: "worker" });
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
		s.busIdentity({ name: "mars", role: "coordinator" });
		s.goal({ state: "paused", turns: 2 });
		expect(s.renders()).toBe(before + 2);
		const line = s.line();
		expect(line).toContain("mars:coordinator");
		expect(line).toContain("goal paused");
	});

	it("keeps the last bus identity and goal state at session start", async () => {
		const s = await start();
		s.busIdentity({ name: "mars" });
		s.goal({ state: "active", turns: 1 });
		expect(s.line()).toContain("goal 1");
		await s.h.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		const line = s.line();
		expect(line).toContain("mars");
		expect(line).toContain("goal 1");
	});

	it("ignores a bus identity on pi.events", async () => {
		const s = await start();
		s.pi().events.emit("pi-bus:identity", { name: "ghost", role: "worker" });
		expect(s.line()).not.toContain("ghost");
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

describe("statusline with the bus feature", () => {
	afterEach(async () => {
		await harness?.shutdown();
		delete process.env["PI_BUS_NAME"];
		delete process.env["PI_BUS_ROLE"];
	});

	it("shows name and role after start and after a reload with no human action", async () => {
		process.env["PI_BUS_NAME"] = "mars";
		process.env["PI_BUS_ROLE"] = "coordinator";
		const s = await start({ before: [bus] });
		expect(s.line()).toContain("mars:coordinator");

		await s.h.session.reload();
		s.mount();
		expect(s.line()).toContain("mars:coordinator");
	});

	it("shows no bus segment when the bus feature is off", async () => {
		process.env["PI_BUS_NAME"] = "mars";
		process.env["PI_BUS_ROLE"] = "coordinator";
		const s = await start({ before: [bus], features: { bus: false } });
		expect(s.line()).not.toContain("mars");
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

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("statusline work counts", () => {
	const stateRoot = mkdtempSync(join(tmpdir(), "statusline-counts-"));
	const call = (tool: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
	const quiet: ExecFn = async () => ({ code: 0, stdout: "", stderr: "" });
	const counts = (line: string) => / ((?:[ABMT]:\d+ )*[ABMT]:\d+) │ /.exec(line)?.[1];

	beforeEach(() => {
		process.env["PI_BACKGROUND_DIR"] = stateRoot;
	});

	afterAll(() => {
		rmSync(stateRoot, { recursive: true, force: true });
	});

	afterEach(async () => {
		await shutdownJobs(reloadSlot("background", "registry", 1, () => createRegistry("")));
		delete process.env["PI_BACKGROUND_DIR"];
	});

	async function act(s: Awaited<ReturnType<typeof start>>, ...steps: ReturnType<typeof call>[]) {
		s.h.respond([...steps, fauxAssistantMessage(fauxText("ok"))]);
		await s.h.session.prompt("go");
	}

	it("shows zero background, monitor, and timer counts and no agents letter without the agents feature", async () => {
		const s = await start({ before: [background] });
		const line = s.line();
		expect(counts(line)).toBe("B:0 M:0 T:0");
		expect(line).toMatch(/fallback-branch +B:0 M:0 T:0 │ /);
	});

	it("counts a running background job until it exits", async () => {
		const s = await start({ before: [background], features: { background: { inlineWaitMs: 0 } } });
		s.mount();
		const before = s.renders();
		const go = join(mkdtempSync(join(stateRoot, "gate-")), "go");
		const command = `while [ ! -f ${go} ]; do sleep 0.05; done`;
		await act(s, call("background", { action: "start", name: "job", command, notifyExit: false }));
		expect(counts(s.line())).toBe("B:1 M:0 T:0");
		expect(s.renders()).toBeGreaterThan(before);
		writeFileSync(go, "");
		await until(() => counts(s.line()) === "B:0 M:0 T:0");
	});

	it("lowers the count when a job kept from an earlier runtime ends", async () => {
		const reg = reloadSlot<Registry>("background", "registry", 1, () => createRegistry(""));
		let markExited = () => {};
		const exited = new Promise<void>((resolve) => {
			markExited = resolve;
		});
		reg.active.set("kept", { options: { name: "kept", kind: "background" }, exited } as unknown as JobState);
		const s = await start({ before: [background] });
		expect(counts(s.line())).toBe("B:1 M:0 T:0");
		// Code of the earlier runtime retires the job without the change hook.
		reg.active.delete("kept");
		markExited();
		await until(() => counts(s.line()) === "B:0 M:0 T:0");
	});

	it("counts a monitor until it is stopped", async () => {
		const s = await start({ before: [background] });
		await act(s, call("monitor", { action: "start", name: "mon", command: "sleep 30", match: "ready" }));
		expect(counts(s.line())).toBe("B:0 M:1 T:0");
		await act(s, call("monitor", { action: "stop", name: "mon" }));
		expect(counts(s.line())).toBe("B:0 M:0 T:0");
	});

	it("counts an armed timer until it is cancelled", async () => {
		const s = await start({ before: [background] });
		await act(s, call("timer", { action: "set", name: "ci", delaySeconds: 600, reason: "check ci" }));
		expect(counts(s.line())).toBe("B:0 M:0 T:1");
		await act(s, call("timer", { action: "cancel", name: "ci" }));
		expect(counts(s.line())).toBe("B:0 M:0 T:0");
	});

	it("publishes counts only when a number changed", async () => {
		const s = await start({ before: [background] });
		const seen: string[] = [];
		s.events().on("background:counts", (payload) => seen.push(JSON.stringify(payload)));
		await act(
			s,
			call("timer", { action: "set", name: "ci", delaySeconds: 600, reason: "check ci" }),
			call("timer", { action: "set", name: "ci", delaySeconds: 900, reason: "check ci later" }),
			call("timer", { action: "cancel", name: "ci" }),
		);
		expect(seen).toEqual([
			JSON.stringify({ background: 0, monitor: 0, timers: 1 }),
			JSON.stringify({ background: 0, monitor: 0, timers: 0 }),
		]);
	});

	it("counts the timer of an active goal", async () => {
		const s = await start({
			before: [background, createNotifyFeature({ exec: quiet }), createGoalFeature({ exec: quiet })],
		});
		s.h.respond([
			call("timer", { action: "set", delaySeconds: 600, reason: "ci" }),
			fauxAssistantMessage(fauxText("w")),
		]);
		await s.h.session.prompt("/goal ship it");
		await s.h.waitForRequests(2);
		expect(counts(s.line())).toBe("B:0 M:0 T:1");
	});

	it("keeps the counts after a reload", async () => {
		const s = await start({ before: [background] });
		await act(s, call("timer", { action: "set", name: "ci", delaySeconds: 600, reason: "check ci" }));
		await s.h.session.reload();
		s.mount();
		expect(counts(s.line())).toBe("B:0 M:0 T:1");
	});

	it("shows the agents count it receives and re-renders", async () => {
		const s = await start();
		s.mount();
		const before = s.renders();
		s.agentCounts({ active: 2 });
		expect(s.renders()).toBe(before + 1);
		expect(counts(s.line())).toBe("A:2");
	});

	it("shows no counts when work counts are off", async () => {
		const s = await start({ before: [background], config: { workCounts: false } });
		s.agentCounts({ active: 2 });
		const line = s.line();
		expect(line).not.toMatch(/[ABMT]:\d/);
	});

	it("shows no counts when the background feature is off", async () => {
		const s = await start({ before: [background], features: { background: false } });
		expect(s.line()).not.toMatch(/[BMT]:\d/);
	});

	it("drops the counts first on a narrow terminal", async () => {
		const s = await start({ before: [background] });
		s.busIdentity({ name: "worker-1" });
		const wide = s.line(200);
		const gap = / +(?=A:|B:)/.exec(wide)?.[0].length ?? 0;
		const narrow = s.line(wide.length - gap);
		expect(narrow).not.toContain("B:0");
		expect(narrow).toContain("worker-1");
	});
});

describe("statusline agents count", () => {
	const nodes: BusNode[] = [];
	let paths: AgentPaths;

	beforeEach(() => {
		paths = agentPaths(join(mkdtempSync(join(tmpdir(), "statusline-agents-")), "pi-agents"));
	});

	afterEach(async () => {
		for (const node of nodes.splice(0)) await node.stop();
		await harness?.shutdown();
	});

	/** Places nothing. Plays a child that reads its spawn file and joins the bus. */
	function childPlacer(agentDir: () => string): Placer {
		let next = 0;
		return {
			inside: () => true,
			async place(request) {
				const taken = takeSpawnFile(request.env["PIMON_SPAWN_FILE"] ?? "");
				if (!("data" in taken)) throw new Error(taken.error);
				const node = new BusNode({
					owner: randomUUID(),
					desiredName: taken.data.child.name ?? "child",
					labels: taken.data.child.labels,
					dirs: busDirs(agentDir()),
					onEnvelope: () => {},
				});
				nodes.push(node);
				await node.start();
				next++;
				return { kind: "herdr", handle: `w1:p${next}`, tabId: `w1:t${next}`, layout: "tab", detail: "test" };
			},
			alive: async () => true,
			focus: async () => true,
			close: async () => true,
			describe: async () => "herdr: test",
		};
	}

	it("counts a spawned child until its bus endpoint leaves", async () => {
		let agentDir = "";
		const agents = createAgentsFeature({
			paths,
			placer: childPlacer(() => agentDir),
			timing: { spawnWaitMs: 3_000, pollMs: 20, placedPollMs: 20, placedWaitMs: 5_000 },
		});
		const s = await start({
			before: [background, bus, agents],
			prepareAgentDir: (dir) => {
				agentDir = dir;
				mkdirSync(join(dir, "agents"));
				writeFileSync(join(dir, "agents", "worker.md"), "---\nname: worker\n---\nYou work.\n");
			},
		});
		expect(s.line()).toMatch(/ A:0 B:0 M:0 T:0 │ /);
		s.h.respond([
			fauxAssistantMessage(fauxToolCall("pi_agents", { action: "spawn", role: "worker", task: "go" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxText("spawned")),
			fauxAssistantMessage(fauxToolCall("pi_agents", { action: "close" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("closing")),
		]);
		await s.h.session.prompt("spawn one");
		expect(s.line()).toMatch(/ A:1 B:0 M:0 T:0 │ /);

		await s.h.session.prompt("close it");
		const child = nodes.at(-1) as BusNode;
		await child.stop({ announce: true });
		await until(() => / A:0 B:0 M:0 T:0 │ /.test(s.line()));
	});
});
