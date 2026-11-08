import { dirname, join } from "node:path";
import { createProcessRunner, type ExecFn } from "../../core/exec.ts";
import { defineFeature } from "../../core/feature.ts";
import {
	awaitPlacement,
	loadSpawnFile,
	newChildState,
	sendTask,
	type SpawnSource,
	spawnIdentity,
	spawnSource,
	startChildSession,
} from "./child.ts";
import { registerCommands } from "./commands.ts";
import { createHerdrPlacer, HERDR_START_TIMEOUT_MS, type Placer } from "./placement.ts";
import { AGENTS_PROMPT, delegatedPrompt } from "./prompt.ts";
import { ChildRecords } from "./records.ts";
import { type AgentPaths, agentPaths, placedMarkerPath } from "./spawn-file.ts";
import {
	AGENTS_TOOL_DESCRIPTION,
	type AgentsHost,
	type AgentsToolInput,
	agentsToolSchema,
	cleanupGoneChild,
	pruneFiles,
	rewatchChildren,
	runToolAction,
} from "./tool.ts";

interface AgentsFeatureOptions {
	/** Defaults to Herdr through the process runner. */
	placer?: Placer;
	/** Runs herdr. Ignored when `placer` is given. */
	exec?: ExecFn;
	paths?: AgentPaths;
	timing?: Partial<AgentsHost["timing"]>;
}

const DEFAULT_TIMING: AgentsHost["timing"] = {
	spawnWaitMs: 15_000,
	pollMs: 200,
	killGraceMs: 2_000,
	placedPollMs: 100,
	// A parent that died after placement must not strand the task.
	placedWaitMs: 2 * HERDR_START_TIMEOUT_MS,
};

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
				agentDir: ctx.agentDir,
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
			let cancelWait: (() => void) | undefined;
			// TODO(okka): the task is lost when the child reloads before placement; keep pendingTask in reload state to fix.
			ctx.onSessionShutdown(() => {
				cancelWait?.();
				cancelWait = undefined;
			});
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
			// The task waits for the render and for the parent's placement. The render puts the role and delegated sections in the first request.
			ctx.events.on("pimon:session-ready", () => {
				const task = pendingTask;
				pendingTask = undefined;
				if (task === undefined || !child.data || !bus.launch.spawnFile) return;
				const marker = placedMarkerPath(dirname(bus.launch.spawnFile), child.data.spawnId);
				const timing = { pollMs: host.timing.placedPollMs, waitMs: host.timing.placedWaitMs };
				cancelWait = awaitPlacement(marker, timing, () => {
					cancelWait = undefined;
					sendTask(ctx.pi, task);
				});
			});
		},
	});
}

export const agents = createAgentsFeature();
