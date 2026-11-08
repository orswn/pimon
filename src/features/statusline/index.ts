import { DEFAULT_COMPACTION_SETTINGS, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createProcessRunner, type ExecFn } from "../../core/exec.ts";
import { defineFeature } from "../../core/feature.ts";
import { type CompactionSettingsInput, compactionThreshold, type ModelWindow } from "../compaction/threshold.ts";
import { createGitWatch } from "./git.ts";
import {
	type BusIdentity,
	busSegment,
	clickedCount,
	compactPath,
	type CountKind,
	type CountRegion,
	fmt,
	type FooterLayout,
	type GoalIndicator,
	gitSegment,
	goalSegment,
	layoutFooter,
	type ThemeLike,
	usageColor,
	type WorkCounts,
} from "./segments.ts";
import { cacheHitRate, createStatsCache } from "./totals.ts";
import {
	createUsagePoller,
	formatUsagePart,
	hasUsageSource,
	usageCacheDir,
	type UsagePart,
	type UsagePoller,
} from "./usage.ts";

declare module "../../core/events.ts" {
	interface PimonEvents {
		/** A click on a footer count. The feature that owns the count shows the text of its list command. */
		"statusline:list": { kind: CountKind; show: (text: string, level: "info" | "warning" | "error") => void };
	}
}

const configSchema = Type.Object(
	{
		usage: Type.Boolean({ default: true }),
		usagePollSeconds: Type.Integer({ minimum: 30, maximum: 3600, default: 60 }),
		gitStatus: Type.Boolean({ default: true }),
		workCounts: Type.Boolean({ default: true }),
	},
	{ additionalProperties: false },
);

export interface StatuslineFeatureOptions {
	/** Runs git. Tests inject a recorder. */
	exec?: ExecFn;
	fetch?: typeof fetch;
	now?: () => number;
	/** Shared usage cache dir. Tests point it at a temp dir. */
	cacheDir?: string;
}

const DOT = " · ";

export function createStatuslineFeature(options: StatuslineFeatureOptions = {}) {
	return defineFeature({
		id: "statusline",
		description: "Footer status line and working indicator",
		defaultEnabled: true,
		configSchema,
		setup(ctx) {
			const { pi, config } = ctx;
			const now = options.now ?? Date.now;
			const runner = createProcessRunner();
			const stats = createStatsCache();
			let renderNow: (() => void) | undefined;
			let bus: BusIdentity | undefined;
			let goal: GoalIndicator | undefined;
			const counts: WorkCounts = {};
			let aborter = new AbortController();
			let usage: UsagePoller | undefined;
			const git = createGitWatch({
				run: options.exec ?? runner.run,
				now,
				onChange: () => renderNow?.(),
			});
			// pi.getSettings() clones every setting, so the limit is read once per model and run, not per render.
			let cachedLimit: { key: string; limit: number } | undefined;
			const contextLimit = (model: ModelWindow | undefined): number => {
				if (!model?.contextWindow) return 0;
				const key = `${model.provider}/${model.id}/${model.contextWindow}`;
				if (cachedLimit?.key === key) return cachedLimit.limit;
				const settings = pi.getSettings().compaction as CompactionSettingsInput | undefined;
				const info = compactionThreshold(model, settings, DEFAULT_COMPACTION_SETTINGS);
				// A reserve that leaves no room makes pi compact at every check, so no limit is shown.
				const limit = !info.enabled ? model.contextWindow : info.threshold > 0 ? info.threshold : 0;
				cachedLimit = { key, limit };
				return limit;
			};
			const requestGit = (cwd: string) => {
				// Only a built footer shows git. RPC mode has a UI but ignores custom footers.
				if (config.gitStatus && renderNow) git.request(cwd);
			};

			// Bus is optional: without the bus feature this never fires and no bus segment shows.
			ctx.events.on("bus:identity", (payload) => {
				bus = payload;
				renderNow?.();
			});

			// Goal is optional: without the goal feature this never fires and no goal segment shows.
			ctx.events.on("goal:state", (payload) => {
				goal = payload;
				renderNow?.();
			});

			// Agents and background are optional: a feature that is off never publishes, so its letters do not show.
			if (config.workCounts) {
				ctx.events.on("agents:counts", ({ active }) => {
					counts.agents = active;
					renderNow?.();
				});
				ctx.events.on("background:counts", (payload) => {
					counts.background = payload.background;
					counts.monitor = payload.monitor;
					counts.timers = payload.timers;
					renderNow?.();
				});
			}

			const renderLine = (
				ext: ExtensionContext,
				theme: ThemeLike,
				gitBranch: string | null,
				width: number,
			): FooterLayout => {
				const time = now();
				if (config.gitStatus) git.onRender(ext.cwd);
				const model = ext.model;
				const provider = model?.provider;
				let limits: UsagePart[] = [];
				if (usage && model && hasUsageSource(provider) && ext.modelRegistry.isUsingOAuth(model)) {
					// pi refreshes the token under its own lock. Only the claim winner asks for it.
					void usage.check(provider, async () => (await ext.modelRegistry.getProviderAuth(provider))?.auth.apiKey);
					limits = usage.parts(provider);
				}

				const { totals, context } = stats.get(ext);
				const contextTokens = context?.tokens ?? 0;
				const limit = contextLimit(model);
				const pct = limit ? Math.round((contextTokens / limit) * 100) : 0;
				const contextPart = theme.fg(
					usageColor(pct),
					limit ? `${fmt(contextTokens)}/${fmt(limit)} (${pct}%)` : fmt(contextTokens),
				);

				const status =
					(config.gitStatus ? git.status(ext.cwd) : undefined) ??
					(gitBranch ? { branch: gitBranch, dirty: 0, ahead: 0, behind: 0 } : undefined);
				const loc = [theme.fg("text", theme.bold(compactPath(ext.cwd))), gitSegment(status, theme)]
					.filter(Boolean)
					.join(theme.fg("dim", DOT));

				const providerName = ext.modelRegistry.getProvider(provider ?? "")?.name ?? provider ?? "";
				const modelName = model?.name ?? model?.id ?? "";
				const modelPart = theme.fg("accent", `${providerName} - ${modelName} - ${pi.getThinkingLevel()}`);

				const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
				const hitRate = cacheHitRate(totals.input, totals.cacheRead, totals.cacheWrite);
				const cacheHitPart =
					totals.cacheRead + totals.cacheWrite > 0 && hitRate !== undefined
						? theme.fg("dim", `CH${hitRate.toFixed(1)}%`)
						: undefined;
				// Providers without pricing report cost 0; token counts must not depend on it.
				const tokenPart =
					promptTokens + totals.output > 0 ? theme.fg("dim", `${fmt(promptTokens)}/${fmt(totals.output)}`) : undefined;
				const costPart =
					[tokenPart, cacheHitPart, totals.cost > 0 ? `$${totals.cost.toFixed(2)}` : undefined]
						.filter(Boolean)
						.join(" ") || undefined;
				const limitPart =
					limits.length > 0
						? limits.map((part) => theme.fg(usageColor(part.percent), formatUsagePart(part, time))).join(" ")
						: undefined;

				return layoutFooter(
					{
						loc,
						model: modelPart,
						context: contextPart,
						bus: busSegment(bus, theme),
						goal: goalSegment(goal, theme, time),
						cost: costPart,
						limits: limitPart,
					},
					counts,
					width,
					theme,
				);
			};

			const install = (ext: ExtensionContext) => {
				const frameTheme = ext.ui.theme;
				ext.ui.setWorkingIndicator({
					frames: [
						frameTheme.fg("dim", "·"),
						frameTheme.fg("muted", "•"),
						frameTheme.fg("accent", "*"),
						frameTheme.fg("muted", "•"),
					],
					intervalMs: 140,
				});
				ext.ui.setFooter((tui, theme, footerData) => {
					const requestRender = () => tui.requestRender();
					renderNow = requestRender;
					const disposeBranch = footerData.onBranchChange(() => {
						requestGit(ext.cwd);
						tui.requestRender();
					});
					let regions: CountRegion[] = [];
					return {
						dispose() {
							disposeBranch();
							if (renderNow === requestRender) renderNow = undefined;
						},
						invalidate() {},
						render: (width: number) => {
							const layout = renderLine(ext, theme, footerData.getGitBranch(), width);
							regions = layout.regions;
							return [layout.line];
						},
						// Only fullscreen mode routes mouse events to components.
						handleMouse: (event: TuiMouseEvent) => {
							const kind = clickedCount(event, regions);
							if (!kind) return undefined;
							const show = (text: string, level: "info" | "warning" | "error") => {
								try {
									ext.ui.notify(text, level);
								} catch {
									// A list can resolve after /new, /resume, or /reload replaced this session's UI.
								}
							};
							ctx.events.emit("statusline:list", { kind, show });
							return { handled: true };
						},
					};
				});
			};

			ctx.onSessionStart((_event, ext) => {
				cachedLimit = undefined;
				// Bus, goal, agents, and background are not cleared: they start first and always publish at session start.
				aborter = new AbortController();
				usage = config.usage
					? createUsagePoller({
							dir: options.cacheDir ?? usageCacheDir(process.env, process.getuid?.()),
							agentDir: ctx.agentDir,
							pollMs: config.usagePollSeconds * 1000,
							fetch: options.fetch ?? fetch,
							now,
							signal: aborter.signal,
							onChange: () => renderNow?.(),
						})
					: undefined;
				if (ext.hasUI) install(ext);
				requestGit(ext.cwd);
			});

			// Settings can change between runs.
			pi.on("agent_start", () => {
				cachedLimit = undefined;
			});
			pi.on("turn_end", (_event, ext) => {
				requestGit(ext.cwd);
				renderNow?.();
			});
			pi.on("model_select", () => renderNow?.());
			pi.on("thinking_level_select", () => renderNow?.());

			ctx.onSessionShutdown(() => {
				renderNow = undefined;
				aborter.abort();
				usage = undefined;
				runner.terminateAll();
			});
		},
	});
}

export const statusline = createStatuslineFeature();
