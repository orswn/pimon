import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type FeaturePlan, loadConfigFile, planFeature } from "./config.ts";
import { createEventBus } from "./events.ts";
import type {
	AnyFeature,
	FeatureContext,
	FeatureId,
	FeatureLog,
	SessionShutdownHandler,
	SessionStartHandler,
} from "./feature.ts";
import { PromptRegistry } from "./prompt.ts";
import { reloadSlot } from "./reload-state.ts";
import type { ServiceMap } from "./services.ts";

export type FeatureStatus = FeaturePlan | { id: FeatureId; state: "failed"; reason: string };

export interface Diagnostic {
	/** A feature id, or `pimon` for the core. */
	feature: FeatureId;
	level: "warning" | "error";
	message: string;
}

export interface PimonRuntime {
	status(): readonly FeatureStatus[];
	diagnostics(): readonly Diagnostic[];
	prompts: PromptRegistry;
}

export interface PimonOptions {
	agentDir?: string;
	onRuntime?: (runtime: PimonRuntime) => void;
}

export function createPimon(features: readonly AnyFeature[], options: PimonOptions = {}): ExtensionFactory {
	return (pi) => {
		const runtime = startRuntime(pi, features, options.agentDir ?? getAgentDir());
		options.onRuntime?.(runtime);
	};
}

function startRuntime(pi: ExtensionAPI, features: readonly AnyFeature[], agentDir: string): PimonRuntime {
	const diagnostics: Diagnostic[] = [];
	const report = (feature: Diagnostic["feature"], level: Diagnostic["level"], message: string, cause?: unknown) => {
		diagnostics.push({ feature, level, message: cause === undefined ? message : `${message}: ${describe(cause)}` });
	};

	const loaded = loadConfigFile(agentDir);
	for (const problem of loaded.problems) report("pimon", "error", problem);
	const settings = loaded.file.features ?? {};
	for (const id of Object.keys(settings)) {
		if (!features.some((feature) => feature.id === id))
			report("pimon", "warning", `${loaded.path}: unknown feature "${id}"`);
	}

	const events = createEventBus((event, error) => report("pimon", "error", `listener for ${event} threw`, error));
	const services = new Map<FeatureId, unknown>();
	const prompts = new PromptRegistry();
	const startHandlers: { feature: FeatureId; handler: SessionStartHandler }[] = [];
	const shutdownHandlers: { feature: FeatureId; handler: SessionShutdownHandler }[] = [];
	const statuses = new Map<FeatureId, FeatureStatus>();

	for (const feature of orderByDependencies(features, report)) {
		const blocked = (feature.dependsOn ?? []).find((dep) => statuses.get(dep)?.state !== "enabled");
		if (blocked !== undefined) {
			const depState = statuses.get(blocked)?.state ?? "missing";
			statuses.set(feature.id, { id: feature.id, state: "disabled", reason: `needs ${blocked}, which is ${depState}` });
			continue;
		}
		const plan = planFeature(feature, settings[feature.id]);
		if (plan.state !== "enabled") {
			statuses.set(feature.id, plan);
			if (plan.state === "invalid") report(feature.id, "error", plan.reason);
			continue;
		}
		const log: FeatureLog = {
			warn: (message) => report(feature.id, "warning", message),
			error: (message, cause) => report(feature.id, "error", message, cause),
		};
		const ctx: FeatureContext<unknown> = {
			id: feature.id,
			pi,
			config: plan.config,
			agentDir,
			events,
			log,
			service<K extends keyof ServiceMap>(id: K): ServiceMap[K] {
				if (!services.has(id as FeatureId))
					throw new Error(`${feature.id} used service ${String(id)}, which is not running`);
				return services.get(id as FeatureId) as ServiceMap[K];
			},
			reloadState: (key, version, create) => reloadSlot(feature.id, key, version, create),
			promptSection: (section) => prompts.add(feature.id, section),
			onSessionStart: (handler) => startHandlers.push({ feature: feature.id, handler }),
			onSessionShutdown: (handler) => shutdownHandlers.push({ feature: feature.id, handler }),
		};
		try {
			const service = feature.setup(ctx as FeatureContext<never>);
			if (service !== undefined) services.set(feature.id, service);
			statuses.set(feature.id, plan);
		} catch (error) {
			statuses.set(feature.id, { id: feature.id, state: "failed", reason: describe(error) });
			report(feature.id, "error", "setup failed", error);
		}
	}

	const enabled = () =>
		new Set([...statuses.values()].filter((status) => status.state === "enabled").map((status) => status.id));

	let announced = 0;
	const announce = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || diagnostics.length <= announced) return;
		const fresh = diagnostics.slice(announced);
		announced = diagnostics.length;
		const level = fresh.some((item) => item.level === "error") ? "error" : "warning";
		ctx.ui.notify(
			`pimon: ${fresh.map((item) => `${item.feature}: ${item.message}`).join("\n")}\nRun /pimon for details.`,
			level,
		);
	};
	let hostChecked = false;
	let promptsRendered = false;
	// Render once per runtime. pi skips session_start on reload when the host has no UI bindings.
	const renderPrompts = (cwd: string) => {
		if (promptsRendered) return;
		promptsRendered = true;
		prompts.render({ cwd, enabledFeatures: enabled() }, (feature, error) =>
			report(feature, "error", "prompt section failed to render", error),
		);
	};

	pi.on("session_start", async (event, ctx) => {
		if (!hostChecked) {
			hostChecked = true;
			// A second copy of the pi packages gives features classes and registries that pi does not see.
			if (!((ctx.sessionManager as object) instanceof SessionManager)) {
				report(
					"pimon",
					"error",
					"a second copy of @earendil-works/pi-coding-agent is loaded; keep the pi packages in peerDependencies only",
				);
			}
		}
		for (const { feature, handler } of startHandlers) {
			if (!enabled().has(feature)) continue;
			try {
				await handler(event, ctx);
			} catch (error) {
				report(feature, "error", `session_start (${event.reason}) failed`, error);
			}
		}
		renderPrompts(ctx.cwd);
		announce(ctx);
		events.emit("pimon:session-ready", { reason: event.reason });
	});

	pi.on("before_agent_start", (event, ctx) => {
		renderPrompts(ctx.cwd);
		prompts.apply(event.systemPromptOptions);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		for (const { feature, handler } of [...shutdownHandlers].reverse()) {
			try {
				await handler(event, ctx);
			} catch (error) {
				report(feature, "error", `session_shutdown (${event.reason}) failed`, error);
			}
		}
	});

	pi.registerCommand("pimon", {
		description: "Show pimon feature status and diagnostics",
		handler: async (_args, ctx) => {
			ctx.ui.notify(renderStatus([...statuses.values()], diagnostics, prompts), "info");
		},
	});

	return {
		status: () => [...statuses.values()],
		diagnostics: () => diagnostics,
		prompts,
	};
}

function orderByDependencies(
	features: readonly AnyFeature[],
	report: (feature: FeatureId, level: Diagnostic["level"], message: string) => void,
): AnyFeature[] {
	const byId = new Map(features.map((feature) => [feature.id, feature]));
	const ordered: AnyFeature[] = [];
	const visiting = new Set<FeatureId>();
	const done = new Set<FeatureId>();
	const visit = (feature: AnyFeature) => {
		if (done.has(feature.id)) return;
		if (visiting.has(feature.id)) {
			report(feature.id, "error", "dependency cycle");
			return;
		}
		visiting.add(feature.id);
		for (const dep of feature.dependsOn ?? []) {
			const target = byId.get(dep);
			if (target) visit(target);
		}
		visiting.delete(feature.id);
		done.add(feature.id);
		ordered.push(feature);
	};
	for (const feature of features) visit(feature);
	return ordered;
}

function renderStatus(
	statuses: readonly FeatureStatus[],
	diagnostics: readonly Diagnostic[],
	prompts: PromptRegistry,
): string {
	const lines = statuses.map((status) =>
		status.state === "enabled" ? `${status.id}: enabled` : `${status.id}: ${status.state} (${status.reason})`,
	);
	if (statuses.length === 0) lines.push("no features");
	const sections = prompts
		.current()
		.map((section) => `<${section.name}> ${section.text.length} chars from ${section.feature}`);
	if (sections.length > 0) lines.push("", "Prompt sections:", ...sections);
	if (diagnostics.length > 0)
		lines.push("", "Diagnostics:", ...diagnostics.map((d) => `${d.level} ${d.feature}: ${d.message}`));
	return lines.join("\n");
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
