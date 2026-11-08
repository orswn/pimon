import { join } from "node:path";
import { createProcessRunner, type ExecFn } from "../../core/exec.ts";
import { defineFeature } from "../../core/feature.ts";
import {
	loadSpawnFile,
	newChildState,
	sendTask,
	type SpawnSource,
	spawnIdentity,
	spawnSource,
	startChildSession,
} from "./child.ts";
import { registerCommands } from "./commands.ts";
import { createHerdrPlacer, type Placer } from "./placement.ts";
import { AGENTS_PROMPT, delegatedPrompt } from "./prompt.ts";
import { ChildRecords } from "./records.ts";
import { type AgentPaths, agentPaths } from "./spawn-file.ts";
import {
	AGENTS_TOOL_DESCRIPTION,
	AGENTS_TOOL_SNIPPET,
	type AgentsHost,
	type AgentsToolInput,
	agentsToolSchema,
	cleanupGoneChild,
	pruneFiles,
	rewatchChildren,
	runToolAction,
} from "./tool.ts";

export interface AgentsFeatureOptions {
	/** Defaults to Herdr through the process runner. */
	placer?: Placer;
	/** Runs herdr. Ignored when `placer` is given. */
	exec?: ExecFn;
	paths?: AgentPaths;
	timing?: Partial<AgentsHost["timing"]>;
}

const DEFAULT_TIMING: AgentsHost["timing"] = { spawnWaitMs: 15_000, pollMs: 200, killGraceMs: 2_000 };

export function createAgentsFeature(options: AgentsFeatureOptions = {}) {
	return defineFeature({
		id: "agents",
		description: "Visible child pi instances in Herdr tabs, with roles and lifecycle",
		dependsOn: ["bus"],
		defaultEnabled: true,
		setup(ctx) {
			const bus = ctx.service("bus");
			const runner = createProcessRunner();
			ctx.onSessionShutdown(() => runner.terminateAll());
			const paths = options.paths ?? agentPaths();
			const pruned = ctx.reloadState("pruned", 1, () => ({ done: false }));
			const host: AgentsHost = {
				pi: ctx.pi,
				bus,
				paths,
				userRolesDir: join(ctx.agentDir, "agents"),
				placer: options.placer ?? createHerdrPlacer({ exec: options.exec ?? runner.run }),
				records: new ChildRecords(paths),
				timing: { ...DEFAULT_TIMING, ...options.timing },
				pruneOnce(key) {
					if (pruned.done) return;
					pruned.done = true;
					pruneFiles(paths, key);
				},
			};

			const child = ctx.reloadState("child", 1, newChildState);
			loadSpawnFile(child, bus.launch, ctx.log);
			let source: SpawnSource | undefined;
			let pendingTask: string | undefined;
			bus.setSpawnIdentity((extCtx) => spawnIdentity(spawnSource(child, extCtx, bus.launch)));

			ctx.promptSection({ name: "agents", requiresTools: ["pi_agents"], render: () => AGENTS_PROMPT });
			ctx.promptSection({ name: "role", render: () => source?.entry.role.prompt });
			ctx.promptSection({
				name: "delegated",
				render: () => {
					if (!source) return undefined;
					const { entry } = source;
					const name = bus.started ? bus.name : entry.child.name || entry.role.name;
					return delegatedPrompt(name, entry.parent.name, entry.parent.owner);
				},
			});

			ctx.pi.registerTool({
				name: "pi_agents",
				label: "Pi Agents",
				description: AGENTS_TOOL_DESCRIPTION,
				promptSnippet: AGENTS_TOOL_SNIPPET,
				parameters: agentsToolSchema,
				async execute(toolCallId, params, signal, _onUpdate, extCtx) {
					const result = await runToolAction(host, extCtx, params as AgentsToolInput, toolCallId, signal);
					return { content: [{ type: "text", text: result.text }], details: result.details };
				},
			});
			registerCommands(ctx.pi, () => host);

			bus.onPeerGone((event) => {
				cleanupGoneChild(host, event).catch((error: unknown) => ctx.log.error("child cleanup failed", error));
			});
			bus.onReady(() => rewatchChildren(host));

			ctx.onSessionStart((event, extCtx) => {
				source = spawnSource(child, extCtx, bus.launch);
				pendingTask = startChildSession(ctx.pi, child, source, bus.launch, event);
				rewatchChildren(host);
			});
			// The task goes after the render, so the first request carries the role and delegated sections.
			ctx.events.on("pimon:session-ready", () => {
				const task = pendingTask;
				pendingTask = undefined;
				if (task !== undefined) sendTask(ctx.pi, task);
			});
		},
	});
}

export const agents = createAgentsFeature();
