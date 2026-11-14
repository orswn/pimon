import { join } from "node:path";
import { createProcessRunner, type ExecFn } from "../../core/exec.ts";
import { defineFeature } from "../../core/feature.ts";
import { shortId } from "../bus/protocol.ts";
import {
	loadSpawnFile,
	newChildState,
	removePidFile,
	sendTask,
	type SpawnSource,
	spawnIdentity,
	spawnSource,
	startChildSession,
} from "./child.ts";
import { registerCommands, showAgentsList } from "./commands.ts";
import { sessionKey } from "./adhoc.ts";
import { createHerdrPlacer, type Placer } from "./placement.ts";
import { AGENTS_PROMPT, delegatedPrompt } from "./prompt.ts";
import { ChildRecords } from "./records.ts";
import { type AgentPaths, agentPaths } from "./spawn-file.ts";
import {
	AGENTS_TOOL_DESCRIPTION,
	type AgentsHost,
	type AgentsToolInput,
	agentsToolSchema,
	childAgents,
	childOnline,
	cleanupGoneChild,
	isActiveChild,
	pruneFiles,
	runToolAction,
} from "./tool.ts";

declare module "../../core/events.ts" {
	interface PimonEvents {
		/** Children of this session that are starting or online. */
		"agents:counts": { active: number };
	}
}

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
	killGraceMs: 2_000,
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
					void Promise.resolve()
						.then(() => bus.agents(false))
						.then(
							(agents) => new Set(agents.map((agent) => sessionKey(agent.id))),
							() => undefined,
						)
						.then((live) => pruneFiles(paths, key, live))
						.catch(() => {});
				},
			};

			// A record can outlive its child, so only children that are starting or online count.
			// `lastActive` survives a link drop for the exit warning; the statusline shows 0 while offline.
			let lastActive = 0;
			let shown: number | undefined;
			let counting: Promise<void> | undefined;
			const show = (active: number, always: boolean) => {
				if (!always && active === shown) return;
				shown = active;
				ctx.events.emit("agents:counts", { active });
			};
			const publishActive = (always = false) => {
				if (!bus.online) {
					show(0, always);
					return;
				}
				if (host.records.mine(bus.id).length === 0) {
					lastActive = 0;
					show(0, always);
					return;
				}
				counting = (counting ?? Promise.resolve()).then(async () => {
					try {
						const agents = await childAgents(host);
						const children = host.records.mine(bus.id);
						lastActive = children.filter((record) => isActiveChild(record, agents.get(record.spawnId))).length;
						show(lastActive, always);
					} catch {
						// The next presence or link event counts again.
					}
				});
			};
			host.records.onChange = () => publishActive();

			const child = ctx.reloadState("child", 3, newChildState);
			let source: SpawnSource | undefined;
			let ready = false;
			const deliverFirstTask = () => {
				const task = child.firstTask;
				if (!ready || !task || task.sent || task.text === undefined) return;
				task.sent = true;
				sendTask(ctx.pi, task.text);
			};
			bus.setSpawnIdentity((extCtx) => {
				loadSpawnFile(child, paths, extCtx.sessionManager.getSessionId(), ctx.log);
				return spawnIdentity(child, spawnSource(child, extCtx));
			});
			bus.onFirstTask((message) => {
				if (!child.firstTask || child.firstTask.sent) return;
				child.firstTask.text = message.body;
				deliverFirstTask();
			});

			ctx.promptSection({ name: "agents", requiresTools: ["pi_agents"], render: () => AGENTS_PROMPT });
			ctx.promptSection({ name: "role", render: () => source?.entry.role.prompt });
			ctx.promptSection({
				name: "delegated",
				render: () => {
					if (!source) return undefined;
					const { entry } = source;
					const name = bus.started ? bus.name : entry.child.name || entry.role.name;
					return delegatedPrompt(name, entry.parent.name, entry.parent.id);
				},
			});

			ctx.pi.registerTool({
				name: "pi_agents",
				label: "Pi Agents",
				description: AGENTS_TOOL_DESCRIPTION,
				parameters: agentsToolSchema,
				async execute(toolCallId, params, signal, _onUpdate, extCtx) {
					try {
						const result = await runToolAction(host, extCtx, params as AgentsToolInput, toolCallId, signal);
						return { content: [{ type: "text", text: result.text }], details: result.details };
					} finally {
						// A spawn ends after its wait for the child.
						publishActive();
					}
				},
			});
			registerCommands(ctx.pi, () => host);
			ctx.events.on("statusline:list", ({ kind, show }) => {
				if (kind === "agents") void showAgentsList(host, show);
			});

			bus.onPresence((event) => {
				if (event.relation !== "child") return;
				publishActive();
				childOnline(host, event);
				cleanupGoneChild(host, event).catch((error: unknown) => ctx.log.error("child cleanup failed", error));
			});
			bus.onReady(() => publishActive(true));

			ctx.onSessionStart((event, extCtx) => {
				source = spawnSource(child, extCtx);
				startChildSession(ctx.pi, child, source, event, paths, ctx.log);
				publishActive(true);
			});
			// The render puts the role and delegated sections in the first request, so the task waits for it.
			ctx.events.on("pimon:session-ready", () => {
				ready = true;
				deliverFirstTask();
			});
			ctx.onSessionShutdown((event, extCtx) => {
				ready = false;
				if (event.reason === "quit") removePidFile(child, paths);
				const live = lastActive;
				if (live === 0 || !["new", "resume", "fork"].includes(event.reason) || !bus.started) return;
				if (!extCtx.hasUI) return;
				try {
					extCtx.ui.notify(
						live === 1
							? `1 child stays with session ${shortId(bus.id)}. Resume it to get its result.`
							: `${live} children stay with session ${shortId(bus.id)}. Resume it to get their results.`,
						"warning",
					);
				} catch {
					// A replaced context cannot notify.
				}
			});
		},
	});
}

export const agents = createAgentsFeature();
