import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { type AnyFeature, defineFeature } from "../../src/core/feature.ts";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { createAgentsFeature } from "../../src/features/agents/index.ts";
import type { Placer, PlacementRequest } from "../../src/features/agents/placement.ts";
import {
	type AgentPaths,
	agentPaths,
	pidFilePath,
	SPAWN_ENTRY,
	type SpawnFile,
	spawnEntry,
	spawnFilePath,
	takeSpawnFile,
	writeSpawnFile,
} from "../../src/features/agents/spawn-file.ts";
import { DIGEST_TYPE } from "../../src/features/bus/index.ts";
import { AGENTS_CACHE_MS } from "../../src/features/bus/protocol.ts";
import { features } from "../../src/features/index.ts";
import { busCapture, busHarness, customMessages, hex, toolTexts, until } from "../support/bus.ts";
import type { Harness, HarnessOptions } from "../support/harness.ts";
import { type HubPeer, startPeer, startTestHub, type TestHub } from "../support/hub.ts";

const capture = busCapture();
const busService = () => capture.get();

function sections(request: Message[] | undefined): Record<string, string> {
	const system = request?.find((message) => message.role === "system") as { sections?: Record<string, string> };
	return system?.sections ?? {};
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function bullets(text: string): string[] {
	return text.split("\n").filter((line) => line.startsWith("- "));
}

function workerRole(dir: string): void {
	mkdirSync(join(dir, "agents"));
	writeFileSync(join(dir, "agents", "worker.md"), "---\nname: worker\n---\nYou work.\n");
}

const spawnCall = () =>
	fauxAssistantMessage(fauxToolCall("pi_agents", { action: "spawn", role: "worker", task: "go" }), {
		stopReason: "toolUse",
	});

describe("agents feature", () => {
	let hub: TestHub;
	let harness: Harness | undefined;
	let root: string;
	let paths: AgentPaths;
	const peers: HubPeer[] = [];

	beforeAll(async () => {
		hub = await startTestHub();
	});
	afterAll(async () => {
		await hub.close();
	});

	beforeEach(() => {
		clearReloadState();
		root = mkdtempSync(join(tmpdir(), "agents-it-"));
		paths = agentPaths(join(root, "pi-agents"));
	});

	afterEach(async () => {
		for (const key of ["PI_BUS_NAME", "PI_BUS_ROLE", "PI_AGENTS_TOOLS"]) delete process.env[key];
		for (const peer of peers.splice(0)) await peer.stop();
		capture.reset();
		await harness?.shutdown();
		harness?.dispose();
		harness = undefined;
		rmSync(root, { recursive: true, force: true });
		clearReloadState();
	});

	async function peer(name: string, options: Parameters<typeof startPeer>[2] = {}): Promise<HubPeer> {
		const started = await startPeer(hub.url, name, options);
		peers.push(started);
		return started;
	}

	function featureSet(placer?: Placer, spawnWaitMs = 3_000, extra: AnyFeature[] = []) {
		const agents = createAgentsFeature({ paths, ...(placer ? { placer } : {}), timing: { spawnWaitMs } });
		// The footer needs a full UI theme. These tests pass a bare UI to see notices.
		const used = features.filter((feature) => feature.id !== "statusline");
		return [...used.map((feature) => (feature.id === "agents" ? agents : feature)), capture.feature, ...extra];
	}

	async function start(
		options: Partial<HarnessOptions> & { placer?: Placer; spawnWaitMs?: number; extra?: AnyFeature[] } = {},
	): Promise<Harness> {
		const { placer, spawnWaitMs, extra, ...rest } = options;
		harness = await busHarness(hub.url, capture, { ...rest, features: featureSet(placer, spawnWaitMs, extra) });
		return harness;
	}

	describe("spawned child", () => {
		const TASK = "Task: build the parser";

		async function parentOf(childId: string, tools: string[] | undefined) {
			const boss = await peer("boss");
			const data: SpawnFile = {
				version: 2,
				spawnId: childId,
				role: { name: "worker", prompt: "You are the worker role.\nWork carefully." },
				parent: { name: "boss", id: boss.id },
				child: { name: "impl-w", labels: { team: "parser", depth: "1" }, tools },
				firstTask: { messageId: randomUUID() },
				createdAt: Date.now(),
			};
			await boss.client.addChild({ id: childId, name: "impl-w", role: "worker", labels: data.child.labels });
			const file = writeSpawnFile(paths, data);
			const sendTask = () =>
				boss.send(
					childId,
					TASK,
					{ kind: "task", subject: "build the parser" },
					{ messageId: data.firstTask.messageId },
				);
			return { boss, data, file, sendTask };
		}

		const childSession = (id: string) => (cwd: string) => SessionManager.inMemory(cwd, { id });

		it("reads and deletes its spawn file and starts with the task from its mailbox under its role", async () => {
			const childId = randomUUID();
			const { boss, file, sendTask } = await parentOf(childId, ["read", "pi_bus"]);
			await sendTask();
			const h = await start({
				sessionManager: childSession(childId),
				responses: [fauxAssistantMessage(fauxText("on it"))],
			});
			expect(existsSync(file)).toBe(false);
			await h.waitForRequests(1);

			const first = h.requests[0];
			const rendered = sections(first);
			expect(rendered["role"]).toBe("<role>\nYou are the worker role.\nWork carefully.\n</role>");
			expect(rendered["delegated"]).toContain(
				`- Your bus name is impl-w. Your coordinator is boss at \`id:${hex(boss.id)}\`.`,
			);
			expect(rendered["agents"]).toBeUndefined();
			expect(first?.find((message) => message.role === "user")?.content).toEqual([{ type: "text", text: TASK }]);
			expect(customMessages(h, DIGEST_TYPE)).toEqual([]);
			expect(h.session.getActiveToolNames().sort()).toEqual(["pi_bus", "read"]);

			expect(busService().id).toBe(childId);
			expect(busService().name).toBe("impl-w");
			expect(busService().labels).toMatchObject({ team: "parser", depth: "1" });
			const row = (await boss.client.agents()).find((agent) => agent.id === childId);
			expect(row).toMatchObject({ name: "impl-w", role: "worker", parent: boss.id, online: true });
			let statusText = "";
			const statusBy = Date.now() + 3_000;
			while (statusText !== "build the parser" && Date.now() < statusBy) {
				statusText = (await boss.client.agentInfo(childId)).status.text;
				await pause(50);
			}
			expect(statusText).toBe("build the parser");
			expect(existsSync(pidFilePath(paths, childId))).toBe(true);

			const entries = h.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType !== "pimon-stale");
			expect(entries).toHaveLength(1);
			const stored = JSON.stringify(entries[0]);
			expect(stored).toContain(SPAWN_ENTRY);
			expect(stored).not.toContain("build the parser");
			expect(h.runtime.diagnostics()).toEqual([]);
		});

		it("holds a digest until the first task came and sends the task after the skills load", async () => {
			const childId = randomUUID();
			const { boss, sendTask } = await parentOf(childId, ["read", "pi_bus"]);
			const skills = join(root, "skills");
			mkdirSync(join(skills, "parser-notes"), { recursive: true });
			writeFileSync(
				join(skills, "parser-notes", "SKILL.md"),
				"---\nname: parser-notes\ndescription: Notes on the parser.\n---\nRead the grammar first.\n",
			);
			const h = await start({
				sessionManager: childSession(childId),
				responses: [fauxAssistantMessage(fauxText("on it")), fauxAssistantMessage(fauxText("noted"))],
				extensions: [
					(pi) => {
						pi.on("resources_discover", async () => {
							await pause(300);
							return { skillPaths: [skills] };
						});
					},
				],
			});
			await boss.send(childId, "an early note");
			await pause(300);
			expect(h.requests).toEqual([]);

			await sendTask();
			await h.waitForRequests(2);
			const first = h.requests[0];
			expect(first?.find((message) => message.role === "user")?.content).toEqual([{ type: "text", text: TASK }]);
			expect(JSON.stringify(first?.find((message) => message.role === "system"))).toContain("parser-notes");
			expect(String(customMessages(h, DIGEST_TYPE)[0]?.content)).toContain("an early note");
		});

		it("sends no second task after a reload", async () => {
			const childId = randomUUID();
			const { sendTask } = await parentOf(childId, ["read", "pi_bus"]);
			await sendTask();
			const h = await start({
				sessionManager: childSession(childId),
				responses: [fauxAssistantMessage(fauxText("on it"))],
			});
			await h.waitForRequests(1);
			await h.session.reload();
			await until(() => busService().online);
			await pause(300);
			expect(h.requests).toHaveLength(1);
			expect(busService().name).toBe("impl-w");
			expect(h.runtime.diagnostics()).toEqual([]);
		});

		it("sends the task once when it reaches a reloaded session before that session is ready", async () => {
			const childId = randomUUID();
			const { boss, sendTask } = await parentOf(childId, ["read", "pi_bus"]);
			let readyAt = 0;
			let takenAt = 0;
			const slowReload = defineFeature({
				id: "slow-reload",
				description: "test feature that holds the reload start",
				defaultEnabled: true,
				setup(ctx) {
					ctx.onSessionStart(async (event) => {
						if (event.reason === "reload") await pause(600);
					});
					ctx.events.on("pimon:session-ready", ({ reason }) => {
						if (reason === "reload") readyAt = Date.now();
					});
				},
			});
			let gap: (() => Promise<void>) | undefined;
			const h = await start({
				sessionManager: childSession(childId),
				responses: [fauxAssistantMessage(fauxText("on it")), fauxAssistantMessage(fauxText("again"))],
				extra: [slowReload],
				extensions: [
					(pi) =>
						void pi.on("session_shutdown", async (event) => {
							if (event.reason === "reload" && gap) await gap();
						}),
				],
			});
			gap = async () => {
				gap = undefined;
				await sendTask();
			};
			// The child sets the task to working when its link takes the task.
			const taken = boss
				.next("update", (update) => update.state === "working", 10_000)
				.then(() => {
					takenAt = Date.now();
				});
			await h.session.reload();
			await h.waitForRequests(1);
			await taken;
			await pause(800);
			expect(readyAt).toBeGreaterThan(0);
			expect(takenAt).toBeLessThan(readyAt);
			expect(h.requests).toHaveLength(1);
			const tasks = h.session.messages.filter(
				(message) => message.role === "user" && JSON.stringify(message.content).includes(TASK),
			);
			expect(tasks).toHaveLength(1);
		});

		it("sends the task once when a reload comes after the task and before the first session is ready", async () => {
			const childId = randomUUID();
			const { boss, sendTask } = await parentOf(childId, ["read", "pi_bus"]);
			await sendTask();
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const slowStart = defineFeature({
				id: "slow-start",
				description: "test feature that holds the first session start",
				defaultEnabled: true,
				setup(ctx) {
					ctx.onSessionStart(async (event) => {
						if (event.reason === "startup") await gate;
					});
				},
			});
			let session: AgentSession | undefined;
			const taken = boss.next("update", (update) => update.state === "working", 10_000);
			const starting = start({
				sessionManager: childSession(childId),
				responses: [fauxAssistantMessage(fauxText("on it")), fauxAssistantMessage(fauxText("again"))],
				extra: [slowStart],
				onSession: (created) => {
					session = created;
				},
			});
			// The link takes the task while the first session start still waits.
			await taken;
			await pause(100);
			// The first start ends after its reload shutdown, so its ready event comes after that shutdown.
			const reloading = (session as AgentSession).reload();
			release();
			await reloading;
			const h = await starting;
			await h.waitForRequests(1);
			await pause(800);
			expect(h.requests).toHaveLength(1);
			const tasks = h.session.messages.filter(
				(message) => message.role === "user" && JSON.stringify(message.content).includes(TASK),
			);
			expect(tasks).toHaveLength(1);
		});

		it("repeats no bullet across all rendered sections", async () => {
			const childId = randomUUID();
			const { sendTask } = await parentOf(childId, undefined);
			await sendTask();
			const h = await start({
				sessionManager: childSession(childId),
				responses: [fauxAssistantMessage(fauxText("on it"))],
			});
			await h.waitForRequests(1);
			const rendered = sections(h.requests[0]);
			const ours = h.runtime.prompts
				.current(new Set(h.session.getActiveToolNames()))
				.map((section) => rendered[section.name] ?? "");
			expect(Object.keys(rendered)).toEqual(expect.arrayContaining(["agents", "bus", "role", "delegated"]));
			const all = ours.flatMap(bullets);
			expect(all.filter((line, index) => all.indexOf(line) !== index)).toEqual([]);
		});

		it("rebuilds identity and sections from the session entry on resume, without a task", async () => {
			const childId = randomUUID();
			const { data, file } = await parentOf(childId, ["read", "pi_bus"]);
			rmSync(file);
			const h = await start({
				sessionManager: (cwd) => {
					const manager = SessionManager.inMemory(cwd, { id: childId });
					manager.appendCustomEntry(SPAWN_ENTRY, spawnEntry(data));
					return manager;
				},
			});
			expect(busService().name).toBe("impl-w");
			expect(busService().labels).toMatchObject({ team: "parser" });
			expect(h.session.getActiveToolNames().sort()).toEqual(["pi_bus", "read"]);
			await pause(100);
			expect(h.requests).toEqual([]);
			expect(existsSync(pidFilePath(paths, childId))).toBe(true);

			h.respond([fauxAssistantMessage(fauxText("back"))]);
			await h.session.prompt("continue");
			const rendered = sections(h.requests[0]);
			expect(rendered["role"]).toBe("<role>\nYou are the worker role.\nWork carefully.\n</role>");
			expect(rendered["delegated"]).toContain("Your bus name is impl-w.");
			await h.shutdown();
			expect(existsSync(pidFilePath(paths, childId))).toBe(false);
		});

		it("joins with a default identity and reports one error when the spawn file is bad", async () => {
			const childId = randomUUID();
			mkdirSync(paths.spawn, { recursive: true, mode: 0o700 });
			writeFileSync(spawnFilePath(paths, childId), "{not json", { mode: 0o600 });
			const h = await start({ sessionManager: childSession(childId), ui: {} });
			const errors = h.runtime.diagnostics().filter((entry) => entry.level === "error");
			expect(errors).toHaveLength(1);
			expect(errors[0]?.message).toContain("spawn data not loaded");
			expect(h.notifications.some((entry) => entry.level === "error")).toBe(true);
			expect(busService().online).toBe(true);
			expect(busService().name).not.toBe("impl-w");
			h.respond([fauxAssistantMessage(fauxText("hi"))]);
			await h.session.prompt("hi");
			expect(sections(h.requests[0])["delegated"]).toBeUndefined();
		});

		it("ignores a spawn entry in the session when its own spawn file is bad", async () => {
			const childId = randomUUID();
			const { data, file } = await parentOf(randomUUID(), ["read"]);
			rmSync(file);
			writeFileSync(spawnFilePath(paths, childId), "{not json", { mode: 0o600 });
			const h = await start({
				sessionManager: (cwd) => {
					const manager = SessionManager.inMemory(cwd, { id: childId });
					manager.appendCustomEntry(SPAWN_ENTRY, spawnEntry(data));
					return manager;
				},
			});
			expect(busService().name).not.toBe("impl-w");
			expect(h.session.getActiveToolNames()).toContain("pi_bus");
			h.respond([fauxAssistantMessage(fauxText("hi"))]);
			await h.session.prompt("hi");
			expect(sections(h.requests[0])["delegated"]).toBeUndefined();
		});

		it("removes its pid file when it quits", async () => {
			const childId = randomUUID();
			const { sendTask } = await parentOf(childId, ["read", "pi_bus"]);
			await sendTask();
			const h = await start({
				sessionManager: childSession(childId),
				responses: [fauxAssistantMessage(fauxText("on it"))],
			});
			await h.waitForRequests(1);
			expect(existsSync(pidFilePath(paths, childId))).toBe(true);
			await h.shutdown();
			expect(existsSync(pidFilePath(paths, childId))).toBe(false);
		});
	});

	describe("session started by hand", () => {
		it("takes its identity from the env and ignores PI_AGENTS_TOOLS", async () => {
			process.env["PI_BUS_NAME"] = "legacy-w";
			process.env["PI_BUS_ROLE"] = "worker";
			process.env["PI_AGENTS_TOOLS"] = "read,pi_bus";
			const h = await start();
			expect(busService().name).toBe("legacy-w");
			expect(h.session.getActiveToolNames()).toEqual(expect.arrayContaining(["pi_agents", "pi_bus", "read"]));
			expect(process.env["PI_AGENTS_TOOLS"]).toBeUndefined();
			h.respond([fauxAssistantMessage(fauxText("hi"))]);
			await h.session.prompt("hi");
			const rendered = sections(h.requests[0]);
			expect(rendered["delegated"]).toBeUndefined();
			expect(rendered["role"]).toBeUndefined();
		});
	});

	describe("parent", () => {
		/** Places nothing. Plays a child that reads its spawn file, links, and starts on its first task. */
		function childPlacer(options: { link?: boolean; requests?: PlacementRequest[] } = {}): Placer {
			let next = 0;
			return {
				inside: () => true,
				async place(request, id) {
					options.requests?.push(request);
					next++;
					const placement = {
						kind: "herdr" as const,
						handle: `w1:p${next}`,
						tabId: `w1:t${next}`,
						layout: "tab" as const,
						detail: "test",
					};
					if (options.link === false) return placement;
					const taken = takeSpawnFile(spawnFilePath(paths, id));
					if (!taken || !("data" in taken)) throw new Error(taken?.error ?? "no spawn file");
					const child = await peer(taken.data.child.name ?? "child", { id, parent: taken.data.parent.id });
					void child
						.next("message")
						.then(async (event) => {
							if (event.payload.taskId) await child.client.taskUpdate(event.payload.taskId, { state: "working" });
							await child.client.status("parsing the grammar");
						})
						.catch(() => {});
					return placement;
				},
				alive: async () => true,
				focus: async () => true,
				close: async () => true,
				describe: async () => "herdr: test",
			};
		}

		it("spawns a child by session id that takes its task, and lists it with its status text", async () => {
			const requests: PlacementRequest[] = [];
			const h = await start({ placer: childPlacer({ requests }), setupAgentDir: workerRole, ui: {} });
			h.respond([spawnCall(), fauxAssistantMessage(fauxText("spawned"))]);
			await h.session.prompt("spawn one");
			const text = toolTexts(h)[0] ?? "";
			const child = peers.at(-1) as HubPeer;
			expect(text).toContain(`Bus: id:${hex(child.id)}.`);
			expect(text.split("\n").at(-1)).toBe("Task delivered.");

			const args = requests[0]?.args ?? [];
			expect(args[args.indexOf("--session-id") + 1]).toBe(child.id);
			expect(Object.keys(requests[0]?.env ?? {}).sort()).toEqual(["PI_CODING_AGENT_DIR", "TMPDIR"]);
			const task = await child.next("message");
			expect(task.payload.kind).toBe("task");
			expect(task.payload.text).toContain("go");

			const deadline = Date.now() + 3_000;
			let listed = "";
			while (Date.now() < deadline && !listed.includes("says:")) {
				await h.session.prompt("/agents");
				listed = h.notifications.at(-1)?.message ?? "";
				await pause(100);
			}
			expect(listed).toContain("(worker)");
			expect(listed).toContain('says: "parsing the grammar"');
		});

		it("warns once at /new that its child stays with the old session, and not at /reload", async () => {
			const h = await start({ placer: childPlacer(), setupAgentDir: workerRole, ui: {} });
			h.respond([spawnCall(), fauxAssistantMessage(fauxText("spawned"))]);
			await h.session.prompt("spawn one");
			expect(toolTexts(h)[0]?.split("\n").at(-1)).toBe("Task delivered.");
			const stays = () => h.notifications.filter((entry) => entry.message.includes("stays with session"));
			await h.session.reload();
			await until(() => busService().online);
			await pause(AGENTS_CACHE_MS + 100);
			expect(stays()).toEqual([]);
			const id = busService().id;
			await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
			expect(stays().map((entry) => entry.message)).toEqual([
				`1 child stays with session ${hex(id)}. Resume it to get its result.`,
			]);
		});

		it("keeps its child count when the link drops and still warns at /new", async () => {
			const shared = hub;
			const own = await startTestHub();
			hub = own;
			try {
				const counts: number[] = [];
				const probe = defineFeature({
					id: "counts-probe",
					description: "test feature that records agents counts",
					defaultEnabled: true,
					setup(ctx) {
						ctx.events.on("agents:counts", ({ active }) => counts.push(active));
					},
				});
				const h = await start({ placer: childPlacer(), setupAgentDir: workerRole, ui: {}, extra: [probe] });
				h.respond([spawnCall(), fauxAssistantMessage(fauxText("spawned"))]);
				await h.session.prompt("spawn one");
				await until(() => counts.at(-1) === 1);
				const id = busService().id;
				await own.close();
				await until(() => !busService().online);
				// A publish while offline shows 0 in the statusline and keeps the count for the warning.
				h.respond([
					fauxAssistantMessage(fauxToolCall("pi_agents", { action: "list" }), { stopReason: "toolUse" }),
					fauxAssistantMessage(fauxText("listed")),
				]);
				await h.session.prompt("list");
				await until(() => counts.at(-1) === 0);
				await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
				expect(
					h.notifications.filter((entry) => entry.message.includes("stays with session")).map((entry) => entry.message),
				).toEqual([`1 child stays with session ${hex(id)}. Resume it to get its result.`]);
			} finally {
				hub = shared;
				await own.close().catch(() => {});
			}
		});

		it("starts a fork child from a temp session file and deletes the file once the child is online", async () => {
			const requests: PlacementRequest[] = [];
			const h = await start({
				placer: childPlacer({ requests }),
				setupAgentDir: workerRole,
				ui: {},
				sessionManager: (cwd) => SessionManager.create(cwd, join(root, "sessions")),
			});
			h.respond([
				fauxAssistantMessage(
					fauxToolCall("pi_agents", { action: "spawn", role: "worker", task: "go", context: "fork" }),
					{
						stopReason: "toolUse",
					},
				),
				fauxAssistantMessage(fauxText("spawned")),
			]);
			await h.session.prompt("spawn a fork");
			const text = toolTexts(h)[0] ?? "";
			expect(text).toContain("Context: fork.");
			expect(text.split("\n").at(-1)).toBe("Task delivered.");
			const args = requests[0]?.args ?? [];
			const forkFile = args[args.indexOf("--fork") + 1] ?? "";
			expect(args[args.indexOf("--session-id") + 1]).toBe((peers.at(-1) as HubPeer).id);
			expect(forkFile).toMatch(/\.jsonl$/);
			await until(() => !existsSync(forkFile));
		});

		it("says the task is queued when the child does not link in time", async () => {
			const h = await start({ placer: childPlacer({ link: false }), setupAgentDir: workerRole, spawnWaitMs: 300 });
			h.respond([spawnCall(), fauxAssistantMessage(fauxText("spawned"))]);
			await h.session.prompt("spawn one");
			const text = toolTexts(h)[0] ?? "";
			expect(text).toMatch(/^Bus: id:[0-9a-f]{12}, not online after 0s\.$/m);
			expect(text.split("\n").at(-1)).toBe("Task queued: the hub delivers it when the child links.");
		});

		it("says the pane stays open when the child record cannot be saved", async () => {
			const inner = childPlacer({ link: false });
			let closed: boolean | undefined;
			const h = await start({
				placer: {
					...inner,
					async place(request, id) {
						writeFileSync(paths.state, "not a directory");
						return inner.place(request, id);
					},
					close: async () => {
						closed = false;
						return false;
					},
				},
				setupAgentDir: workerRole,
			});
			h.respond([spawnCall(), fauxAssistantMessage(fauxText("failed"))]);
			await h.session.prompt("spawn one");
			const result = h.session.messages.find((message) => message.role === "toolResult") as {
				isError: boolean;
				content: { text: string }[];
			};
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("Could not persist");
			expect(result.content[0]?.text).toContain("Its herdr pane w1:t1 remains open; close it manually.");
			expect(closed).toBe(false);
		});

		it("starts no run when a closed child exits and shows the exit at the next turn", async () => {
			const h = await start({ placer: childPlacer(), setupAgentDir: workerRole, ui: {} });
			h.respond([spawnCall(), fauxAssistantMessage(fauxText("spawned"))]);
			await h.session.prompt("spawn one");
			const child = peers.at(-1) as HubPeer;
			const task = await child.next("message");
			await child.client.taskUpdate(task.payload.taskId ?? "", {
				state: "completed",
				text: "done",
				artifact: { name: "result", text: "done" },
			});
			h.respond([
				fauxAssistantMessage(fauxText("got the result")),
				fauxAssistantMessage(fauxToolCall("pi_agents", { action: "close" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxText("closing")),
			]);
			await h.waitForRequests(3);
			await h.session.waitForIdle();
			await h.session.prompt("close it");
			expect(toolTexts(h).at(-1)).toContain("finish and exit");
			await child.next("control");
			const requests = h.requests.length;

			await child.stop();
			await until(() => h.notifications.some((entry) => entry.message.includes("went offline")));
			await pause(800);
			expect(h.requests).toHaveLength(requests);

			h.respond([fauxAssistantMessage(fauxText("ok"))]);
			await h.session.prompt("next");
			expect(JSON.stringify(h.requests.at(-1))).toContain(`(id:${hex(child.id)}) went offline.`);
		});
	});
});
