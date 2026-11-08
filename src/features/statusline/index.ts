import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createProcessRunner, type ExecFn } from "../../core/exec.ts";
import { defineFeature } from "../../core/feature.ts";
import { createGitWatch } from "./git.ts";
import {
	type BusIdentity,
	busSegment,
	compactPath,
	fmt,
	type GoalIndicator,
	gitSegment,
	goalSegment,
	layoutLine,
	type ThemeLike,
	usageColor,
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

const configSchema = Type.Object(
	{
		usage: Type.Boolean({ default: true }),
		usagePollSeconds: Type.Integer({ minimum: 30, maximum: 3600, default: 60 }),
		gitStatus: Type.Boolean({ default: true }),
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
			let aborter = new AbortController();
			let usage: UsagePoller | undefined;
			const git = createGitWatch({
				run: options.exec ?? runner.run,
				now,
				onChange: () => renderNow?.(),
			});
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

			const renderLine = (ext: ExtensionContext, theme: ThemeLike, gitBranch: string | null, width: number): string => {
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
				const contextWindow = model?.contextWindow ?? 0;
				const pct = contextWindow ? Math.round((contextTokens / contextWindow) * 100) : 0;
				const contextPart = theme.fg(
					usageColor(pct),
					contextWindow ? `${fmt(contextTokens)}/${fmt(contextWindow)} (${pct}%)` : fmt(contextTokens),
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

				return layoutLine(
					{
						loc,
						model: modelPart,
						context: contextPart,
						bus: busSegment(bus, theme),
						goal: goalSegment(goal, theme, time),
						cost: costPart,
						limits: limitPart,
					},
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
					return {
						dispose() {
							disposeBranch();
							if (renderNow === requestRender) renderNow = undefined;
						},
						invalidate() {},
						render: (width: number) => [renderLine(ext, theme, footerData.getGitBranch(), width)],
					};
				});
			};

			ctx.onSessionStart((_event, ext) => {
				// Bus and goal are not cleared: both start first and always publish at session start, `{}` when empty.
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
