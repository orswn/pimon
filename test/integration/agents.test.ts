import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { defineFeature } from "../../src/core/feature.ts";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { createAgentsFeature } from "../../src/features/agents/index.ts";
import type { Placer } from "../../src/features/agents/placement.ts";
import {
	type AgentPaths,
	agentPaths,
	SPAWN_ENTRY,
	type SpawnFile,
	spawnEntry,
	takeSpawnFile,
	writeSpawnFile,
} from "../../src/features/agents/spawn-file.ts";
import type { BusService } from "../../src/features/bus/index.ts";
import { BusNode } from "../../src/features/bus/node.ts";
import type { Envelope } from "../../src/features/bus/protocol.ts";
import { busDirs } from "../../src/features/bus/registry.ts";
import { features } from "../../src/features/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "../support/harness.ts";

const OWNER_KEY = "__piBusOwner";
const globals = globalThis as Record<string, unknown>;
const PARENT = "0123456789abcdef0123456789abcdef";

let service: BusService | undefined;
const capture = defineFeature({
	id: "bus-capture",
	description: "test feature that captures the bus service",
	defaultEnabled: true,
	dependsOn: ["bus"],
	setup(ctx) {
		service = ctx.service("bus");
	},
});
function busService(): BusService {
	if (!service) throw new Error("no bus service");
	return service;
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function sections(request: Message[] | undefined): Record<string, string> {
	const system = request?.find((message) => message.role === "system") as { sections?: Record<string, string> };
	return system?.sections ?? {};
}

function spawnData(spawnId: string, tools: string[] | undefined): SpawnFile {
	return {
		version: 1,
		spawnId,
		role: { name: "worker", prompt: "You are the worker role.\nWork carefully." },
		parent: { name: "boss", owner: PARENT },
		child: { name: "impl-w", labels: { role: "worker", parent: PARENT, spawn: spawnId, depth: "1" }, tools },
		controlToken: "secret-token-value",
		task: "Task: build the parser",
		createdAt: Date.now(),
	};
}

function bullets(text: string): string[] {
	return text.split("\n").filter((line) => line.startsWith("- "));
}

describe("agents feature", () => {
	let harness: Harness | undefined;
	let root: string;
	let paths: AgentPaths;
	const nodes: BusNode[] = [];

	beforeEach(() => {
		delete globals[OWNER_KEY];
		clearReloadState();
		root = mkdtempSync(join(tmpdir(), "agents-it-"));
		paths = agentPaths(join(root, "pi-agents"));
	});

	afterEach(async () => {
		for (const key of ["PIMON_SPAWN_FILE", "PI_BUS_NAME", "PI_BUS_ROLE", "PI_BUS_PARENT", "PI_AGENTS_TOOLS"])
			delete process.env[key];
		delete process.env["PI_BUS_CONTROL_TOKEN"];
		delete process.env["HERDR_ENV"];
		for (const node of nodes.splice(0)) await node.stop();
		service = undefined;
		await harness?.shutdown();
		harness?.dispose();
		harness = undefined;
		rmSync(root, { recursive: true, force: true });
		delete globals[OWNER_KEY];
		clearReloadState();
	});

	function featureSet(placer?: Placer) {
		const agents = createAgentsFeature({
			paths,
			...(placer ? { placer } : {}),
			timing: { spawnWaitMs: 3_000, pollMs: 20 },
		});
		// The footer needs a full UI theme. These tests pass a bare UI to see notices.
		const used = features.filter((feature) => feature.id !== "statusline");
		return [...used.map((feature) => (feature.id === "agents" ? agents : feature)), capture];
	}

	async function start(options: Partial<HarnessOptions> & { placer?: Placer } = {}): Promise<Harness> {
		harness = await createHarness({ ...options, features: featureSet(options.placer) });
		return harness;
	}

	async function refusesTokenlessControl(h: Harness): Promise<void> {
		const refused = new Promise<Envelope>((resolve) => {
			const node = new BusNode({
				owner: PARENT,
				desiredName: "parent",
				labels: {},
				dirs: busDirs(h.agentDir),
				onEnvelope: (envelope) => resolve(envelope),
			});
			nodes.push(node);
			void node
				.start()
				.then(() => node.send(`id:${busService().instanceId}`, { body: "shutdown", kind: "control", wake: "now" }));
		});
		expect((await refused).body).toContain("Refused control request");
		expect(busService().started).toBe(true);
	}

	describe("spawned child", () => {
		it("reads and deletes its spawn file and starts with the task under its role", async () => {
			const spawnId = randomUUID();
			const file = writeSpawnFile(paths, spawnData(spawnId, ["read", "pi_bus"]));
			process.env["PIMON_SPAWN_FILE"] = file;
			const h = await start({ responses: [fauxAssistantMessage(fauxText("on it"))] });
			expect(existsSync(file)).toBe(false);
			expect(process.env["PIMON_SPAWN_FILE"]).toBeUndefined();
			await h.waitForRequests(1);

			const first = h.requests[0];
			const rendered = sections(first);
			expect(rendered["role"]).toBe("<role>\nYou are the worker role.\nWork carefully.\n</role>");
			expect(rendered["delegated"]).toContain(
				`- Your bus name is impl-w. Your coordinator is boss at \`owner:${PARENT}\`.`,
			);
			expect(rendered["agents"]).toBeUndefined();
			expect(first?.find((message) => message.role === "user")?.content).toEqual([
				{ type: "text", text: "Task: build the parser" },
			]);
			expect(h.session.getActiveToolNames().sort()).toEqual(["pi_bus", "read"]);

			expect(busService().name).toBe("impl-w");
			expect(busService().labels).toMatchObject({ role: "worker", parent: PARENT, spawn: spawnId, depth: "1" });
			const entries = h.session.sessionManager.getEntries().filter((entry) => entry.type === "custom");
			expect(entries).toHaveLength(1);
			const stored = JSON.stringify(entries[0]);
			expect(stored).toContain(SPAWN_ENTRY);
			expect(stored).not.toContain("secret-token-value");
			expect(stored).not.toContain("build the parser");
			expect(h.runtime.diagnostics()).toEqual([]);
		});

		it("sends no second task after a reload", async () => {
			const file = writeSpawnFile(paths, spawnData(randomUUID(), ["read", "pi_bus"]));
			process.env["PIMON_SPAWN_FILE"] = file;
			const h = await start({ responses: [fauxAssistantMessage(fauxText("on it"))] });
			await h.waitForRequests(1);
			const instanceId = busService().instanceId;
			await h.session.reload();
			await until(() => busService().started && busService().instanceId !== instanceId);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(h.requests).toHaveLength(1);
			expect(busService().name).toBe("impl-w");
			expect(h.runtime.diagnostics()).toEqual([]);
		});

		it("repeats no bullet across all rendered sections", async () => {
			const file = writeSpawnFile(paths, spawnData(randomUUID(), undefined));
			process.env["PIMON_SPAWN_FILE"] = file;
			const h = await start({ responses: [fauxAssistantMessage(fauxText("on it"))] });
			await h.waitForRequests(1);
			const rendered = sections(h.requests[0]);
			const ours = h.runtime.prompts.current().map((section) => rendered[section.name] ?? "");
			expect(Object.keys(rendered)).toEqual(expect.arrayContaining(["agents", "bus", "role", "delegated"]));
			const all = ours.flatMap(bullets);
			expect(all.filter((line, index) => all.indexOf(line) !== index)).toEqual([]);
		});

		it("rebuilds identity and sections from the session entry on resume, without a task or a token", async () => {
			const spawnId = randomUUID();
			const data = spawnData(spawnId, ["read", "pi_bus"]);
			const h = await start({
				sessionManager: (cwd) => {
					const manager = SessionManager.inMemory(cwd);
					manager.appendCustomEntry(SPAWN_ENTRY, spawnEntry(data));
					return manager;
				},
			});
			expect(busService().name).toBe("impl-w");
			expect(busService().labels).toMatchObject({ role: "worker", parent: PARENT, spawn: spawnId });
			expect(h.session.getActiveToolNames().sort()).toEqual(["pi_bus", "read"]);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(h.requests).toEqual([]);

			h.respond([fauxAssistantMessage(fauxText("back"))]);
			await h.session.prompt("continue");
			const rendered = sections(h.requests[0]);
			expect(rendered["role"]).toBe("<role>\nYou are the worker role.\nWork carefully.\n</role>");
			expect(rendered["delegated"]).toContain("Your bus name is impl-w.");
			await refusesTokenlessControl(h);
		});

		it("joins with a default identity and reports one error when the spawn file is missing", async () => {
			process.env["PIMON_SPAWN_FILE"] = join(root, "missing.json");
			const h = await start({ ui: {} });
			const errors = h.runtime.diagnostics().filter((entry) => entry.level === "error");
			expect(errors).toHaveLength(1);
			expect(errors[0]?.message).toContain("spawn data not loaded");
			expect(h.notifications.some((entry) => entry.level === "error")).toBe(true);
			expect(busService().started).toBe(true);
			expect(busService().labels["spawn"]).toBeUndefined();
			h.respond([fauxAssistantMessage(fauxText("hi"))]);
			await h.session.prompt("hi");
			expect(sections(h.requests[0])["delegated"]).toBeUndefined();
		});

		it("ignores a spawn entry in the session when its own spawn file is bad", async () => {
			process.env["PIMON_SPAWN_FILE"] = join(root, "missing.json");
			const inherited = spawnData(randomUUID(), ["read"]);
			const h = await start({
				sessionManager: (cwd) => {
					const manager = SessionManager.inMemory(cwd);
					manager.appendCustomEntry(SPAWN_ENTRY, spawnEntry(inherited));
					return manager;
				},
			});
			expect(busService().labels["spawn"]).toBeUndefined();
			expect(busService().name).not.toBe("impl-w");
			expect(h.session.getActiveToolNames()).toContain("pi_bus");
			h.respond([fauxAssistantMessage(fauxText("hi"))]);
			await h.session.prompt("hi");
			expect(sections(h.requests[0])["delegated"]).toBeUndefined();
		});
	});

	describe("child of an old parent", () => {
		it("takes its identity and tools from the env and renders no delegated section", async () => {
			process.env["PI_BUS_NAME"] = "legacy-w";
			process.env["PI_BUS_ROLE"] = "worker";
			process.env["PI_BUS_PARENT"] = PARENT;
			process.env["PI_BUS_CONTROL_TOKEN"] = "legacy-token";
			process.env["PI_AGENTS_TOOLS"] = "read,pi_bus";
			const h = await start();
			expect(busService().name).toBe("legacy-w");
			expect(busService().labels).toMatchObject({ role: "worker", parent: PARENT });
			expect(h.session.getActiveToolNames().sort()).toEqual(["pi_bus", "read"]);
			h.respond([fauxAssistantMessage(fauxText("hi"))]);
			await h.session.prompt("hi");
			const rendered = sections(h.requests[0]);
			expect(rendered["delegated"]).toBeUndefined();
			expect(rendered["role"]).toBeUndefined();
			expect(rendered["agents"]).toBeUndefined();
		});
	});

	describe("parent", () => {
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

		it("spawns a child that takes its task and lists it through the command", async () => {
			let agentDir = "";
			const h = await start({
				placer: childPlacer(() => agentDir),
				setupAgentDir: (dir) => {
					agentDir = dir;
					mkdirSync(join(dir, "agents"));
					writeFileSync(join(dir, "agents", "worker.md"), "---\nname: worker\n---\nYou work.\n");
				},
				ui: {},
			});
			h.respond([
				fauxAssistantMessage(fauxToolCall("pi_agents", { action: "spawn", role: "worker", task: "go" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxText("spawned")),
			]);
			await h.session.prompt("spawn one");
			const result = h.session.messages.find((message) => message.role === "toolResult") as {
				content: { type: string; text: string }[];
			};
			expect(result.content.map((block) => block.type)).toEqual(["text"]);
			const text = result.content[0]?.text ?? "";
			expect(text).toMatch(/^Bus: owner:[0-9a-f]{12}\.$/m);
			expect(text.split("\n").at(-1)).toBe("Task delivered.");

			await h.session.prompt("/agents");
			await until(() => h.uiNotices.some((notice) => notice.includes("(worker)")));
			expect(h.uiNotices.at(-1)).toContain("status: idle");
		});
	});
});
