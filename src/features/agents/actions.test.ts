import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { PresenceEvent, UpdateEvent } from "../../hub/protocol.ts";
import { HubHttpError, NO_ANSWER } from "../bus/hub/client.ts";
import type { AgentInfo, BusService } from "../bus/index.ts";
import type { SendInit, SendResult } from "../bus/tool.ts";
import { pidBirth } from "./pid.ts";
import { OUTSIDE_HERDR, type Placement, type PlacementRequest, type Placer } from "./placement.ts";
import { type ChildRecord, ChildRecords } from "./records.ts";
import {
	type AgentPaths,
	agentPaths,
	pidFilePath,
	type SpawnFile,
	spawnFilePath,
	takeSpawnFile,
	writePidFile,
} from "./spawn-file.ts";
import {
	type AgentsHost,
	type AgentsToolInput,
	cleanupGoneChild,
	closeAction,
	defineRoleAction,
	focusAction,
	killAction,
	listAction,
	probeAction,
	pruneFiles,
	runToolAction,
	spawnAction,
} from "./tool.ts";

const SELF = "0123456789abcdef0123456789abcdef";
const DEAD_PID = 99_999_999;

interface Harness {
	host: AgentsHost;
	ctx: ExtensionContext;
	events: string[];
	rows: Map<string, AgentInfo>;
	placed: { request: PlacementRequest; spawn?: SpawnFile }[];
	sends: { to: string; init: SendInit }[];
	open: Set<string>;
	records: ChildRecords;
	paths: AgentPaths;
	root: string;
	presence(event: Partial<PresenceEvent> & { agent: string }): void;
	closeError?: Error | undefined;
}

/** join: the child links and sets its task to working. early: it does so before the send returns. silent: it never links. */
type ChildBehavior = "join" | "early" | "silent";

interface Options {
	inside?: boolean;
	child?: ChildBehavior;
	delayMs?: number;
	records?: (paths: AgentPaths) => ChildRecords;
	tools?: string[];
	delivery?: "delivered" | "queued" | "unconfirmed" | "failed";
	/** The client-side reason of an unconfirmed send. None means the hub stamped it. */
	reason?: string;
}

function row(id: string, fields: Partial<AgentInfo> = {}): AgentInfo {
	return {
		id,
		name: "worker",
		kind: "pi",
		host: "mars",
		cwd: "/tmp",
		role: "worker",
		labels: {},
		parent: SELF,
		topics: [],
		online: false,
		state: "idle",
		activity: null,
		status: { text: "", at: null },
		lastSeenAt: null,
		...fields,
	};
}

function setup(root: string, options: Options = {}): Harness {
	const events: string[] = [];
	const rows = new Map<string, AgentInfo>();
	const placed: Harness["placed"] = [];
	const sends: Harness["sends"] = [];
	const open = new Set<string>();
	const paths = agentPaths(join(root, "agents"));
	const records = options.records?.(paths) ?? new ChildRecords(paths);
	const updates = new Set<(event: UpdateEvent) => void>();
	const presence = new Set<(event: PresenceEvent) => void>();
	let next = 0;
	let tasks = 0;
	const placer: Placer = {
		inside: () => options.inside ?? true,
		async place(request, spawnId) {
			if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
			const handle = `w1:p${++next}`;
			open.add(handle);
			const entry: Harness["placed"][number] = { request };
			placed.push(entry);
			if ((options.child ?? "join") === "join") {
				const taken = takeSpawnFile(spawnFilePath(paths, spawnId));
				if (taken && "data" in taken) entry.spawn = taken.data;
			}
			return { kind: "herdr", handle, tabId: `w1:t${next}`, layout: "tab", detail: "test" };
		},
		alive: async (placement) => (placement.kind === "herdr" ? open.has(placement.handle) : undefined),
		focus: async (placement) => placement.kind === "herdr" && open.has(placement.handle),
		async close(placement) {
			if (placement.kind !== "herdr") return false;
			events.push(`close ${placement.handle}`);
			return open.delete(placement.handle);
		},
		describe: async () => "herdr: test",
	};
	const h = {} as Harness;
	const bus = {
		launch: {},
		started: true,
		online: true,
		id: SELF,
		name: "boss",
		labels: {},
		unavailable: () => undefined,
		errorText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
		agents: async (includeOffline?: boolean) => [...rows.values()].filter((agent) => includeOffline || agent.online),
		agent: async (id: string) => rows.get(id),
		resolve: async () => [],
		expectOffline: (agent: string) => {
			events.push(`expect ${agent}`);
			return () => events.push(`cancel ${agent}`);
		},
		addChild: async (child: { id: string; name?: string; role?: string; labels?: Record<string, string> }) => {
			events.push(`addChild ${child.name}`);
			rows.set(
				child.id,
				row(child.id, { name: child.name ?? "", role: child.role ?? null, labels: child.labels ?? {} }),
			);
		},
		send: async (targets: AgentInfo[], init: SendInit): Promise<SendResult> => {
			const target = targets[0] as AgentInfo;
			sends.push({ to: target.id, init });
			const taskId = `task-${++tasks}`;
			if (options.delivery === "failed") {
				return {
					messageId: init.messageId ?? "",
					threadId: "t",
					lines: [{ name: target.name, id: target.id, state: "failed", reason: "hub unreachable" }],
				};
			}
			const state = options.delivery ?? "queued";
			const working = () => {
				const known = rows.get(target.id);
				if (known) rows.set(target.id, { ...known, online: true, lastSeenAt: new Date().toISOString() });
				for (const handler of updates)
					handler({
						taskId,
						contextId: "t",
						state: "working",
						from: { agent: target.id, name: target.name },
					} as UpdateEvent);
			};
			const behavior = options.child ?? "join";
			if (behavior === "join") setTimeout(working, 5);
			if (behavior === "early") working();
			return {
				messageId: init.messageId ?? "",
				threadId: "t",
				lines: [
					state === "unconfirmed" && options.reason
						? { name: target.name, id: target.id, state, taskId, reason: options.reason }
						: { name: target.name, id: target.id, state, taskId },
				],
			};
		},
		close: async (agent: string) => {
			events.push(`control ${agent}`);
			if (h.closeError) throw h.closeError;
		},
		onPresence: (handler: (event: PresenceEvent) => void) => {
			presence.add(handler);
			return () => presence.delete(handler);
		},
		onUpdate: (handler: (event: UpdateEvent) => void) => {
			updates.add(handler);
			return () => updates.delete(handler);
		},
		onReady: () => () => {},
		setSpawnIdentity: () => {},
		onFirstTask: () => {},
	} as unknown as BusService;
	const pi = {
		getThinkingLevel: () => "medium",
		getAllTools: () => (options.tools ?? ["read", "bash", "pi_bus", "codemode"]).map((name) => ({ name })),
	} as unknown as ExtensionAPI;
	const cwd = join(root, "work");
	mkdirSync(cwd, { recursive: true });
	const ctx = {
		cwd,
		model: { id: "m", provider: "p", name: "M" },
		modelRegistry: { getAvailable: () => [{ id: "m", provider: "p", name: "M" }] },
		sessionManager: { getSessionId: () => "sess", getSessionFile: () => undefined },
	} as unknown as ExtensionContext;
	const userRolesDir = join(root, "roles");
	mkdirSync(userRolesDir, { recursive: true });
	writeFileSync(join(userRolesDir, "worker.md"), "---\nname: worker\ndescription: works\n---\nYou work.\n");
	writeFileSync(join(userRolesDir, "explorer.md"), "---\nname: explorer\nmcp: false\n---\nYou explore.\n");
	const host: AgentsHost = {
		pi,
		bus,
		paths,
		agentDir: process.env["PI_CODING_AGENT_DIR"] ?? root,
		userRolesDir,
		placer,
		records,
		timing: { spawnWaitMs: 300, killGraceMs: 50 },
		pruneOnce: () => {},
	};
	Object.assign(h, {
		host,
		ctx,
		events,
		rows,
		placed,
		sends,
		open,
		records,
		paths,
		root,
		presence(event: Partial<PresenceEvent> & { agent: string }) {
			const full: PresenceEvent = { name: "worker", online: false, relation: "child", ...event };
			for (const handler of presence) handler(full);
		},
	});
	return h;
}

const spawn = (h: Harness, params: Partial<AgentsToolInput> = {}, callId = "call-1") =>
	spawnAction(h.host, h.ctx, { action: "spawn", role: "worker", task: "Do the thing.", ...params }, callId);

const CHILD = "11111111-1111-7111-8111-111111111111";

function storedRecord(h: Harness, overrides: Partial<ChildRecord> = {}): ChildRecord {
	const record: ChildRecord = {
		spawnId: CHILD,
		name: "worker",
		role: "worker",
		task: "t",
		cwd: "/tmp",
		placement: { kind: "herdr", handle: "w1:p9", tabId: "w1:t9", layout: "tab", detail: "test" },
		launchedAt: Date.now() - 60_000,
		launchedBy: SELF,
		...overrides,
	};
	h.records.save(record);
	return record;
}

describe("spawn", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "agents-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("registers the child, then places it, then queues its task, and confirms once it works on it", async () => {
		const h = setup(root);
		const result = await spawn(h);
		const id = String(result.details["spawnId"]);
		const name = h.rows.get(id)?.name ?? "";
		expect(result.text.split("\n")).toEqual([
			`Started: ${name} (worker, herdr tab).`,
			"Runtime: model p/m (inherited), thinking medium (inherited).",
			"Context: isolated.",
			`Bus: id:${id.replace(/-/g, "").slice(0, 12)}.`,
			"Task delivered.",
		]);
		expect(result.details).toMatchObject({ taskDelivery: "delivered", spawnId: id });
		expect(h.events).toEqual([`addChild ${name}`]);
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.init).toMatchObject({ kind: "task", wake: "now", body: "Task: Do the thing." });
		expect(h.placed[0]?.spawn?.firstTask.messageId).toBe(h.sends[0]?.init.messageId);
		expect(h.records.mine(SELF)).toMatchObject([{ spawnId: id, taskId: "task-1" }]);
	});

	it("keeps the task and the role prompt out of argv and env", async () => {
		const h = setup(root);
		const result = await spawn(h, { task: "--help me" });
		const { request, spawn: data } = h.placed[0] as Harness["placed"][number];
		const visible = JSON.stringify([request.args, request.env, request.title]);
		expect(h.sends[0]?.init.body).toBe("Task: --help me");
		expect(data?.role.prompt).toContain("You work.");
		expect(visible).not.toContain("--append-system-prompt");
		expect(visible).not.toContain("--help me");
		expect(visible).not.toContain("You work.");
		expect(request.args.slice(0, 2)).toEqual(["--session-id", String(result.details["spawnId"])]);
		expect(Object.keys(request.env).sort()).toEqual(["PI_CODING_AGENT_DIR", "TMPDIR"]);
		expect(data?.child.labels).toEqual({ depth: "1" });
		expect(data?.parent).toEqual({ name: "boss", id: SELF });
	});

	it("counts a working update that arrives before the send returns", async () => {
		const h = setup(root, { child: "early" });
		const result = await spawn(h);
		expect(result.text.split("\n").at(-1)).toBe("Task delivered.");
	});

	it("reports a queued task and keeps the pane when the child never links", async () => {
		const h = setup(root, { child: "silent" });
		const result = await spawn(h);
		expect(result.text).toContain("not online after 0s.");
		expect(result.text.split("\n").at(-1)).toBe("Task queued: the hub delivers it when the child links.");
		expect(result.ok).toBe(false);
		expect(h.open.size).toBe(1);
		expect(h.records.mine(SELF)).toHaveLength(1);
	});

	it("reports a task that the hub did not take", async () => {
		const h = setup(root, { child: "silent", delivery: "failed" });
		const result = await spawn(h);
		expect(result.text.split("\n").at(-1)).toBe("Task not sent: hub unreachable. The pane stays open for inspection.");
		expect(result.text).toMatch(/^Bus: id:[0-9a-f]{12}\.$/m);
		expect(result.details["taskDelivery"]).toBe("failed");
	});

	it("says the child did not confirm a stored task, and the hub did not answer only after a client timeout", async () => {
		const stored = await spawn(setup(root, { child: "silent", delivery: "unconfirmed" }));
		expect(stored.text.split("\n").at(-1)).toBe(
			'Task unconfirmed: the child did not confirm it yet. Do not resend; check the child with action="probe".',
		);
		const timedOut = await spawn(setup(root, { child: "silent", delivery: "unconfirmed", reason: NO_ANSWER }));
		expect(timedOut.text.split("\n").at(-1)).toBe(
			'Task unconfirmed: the hub did not answer. Do not resend; check the child with action="probe".',
		);
		const broken = await spawn(
			setup(root, { child: "silent", delivery: "unconfirmed", reason: "the connection to the hub broke" }),
		);
		expect(broken.text.split("\n").at(-1)).toBe(
			'Task unconfirmed: the connection to the hub broke. Do not resend; check the child with action="probe".',
		);
	});

	it("reports a task that the child acked but did not start", async () => {
		const h = setup(root, { child: "silent", delivery: "delivered" });
		const result = await spawn(h);
		expect(result.text).toMatch(/^Bus: id:[0-9a-f]{12}\.$/m);
		expect(result.text.split("\n").at(-1)).toBe("Task delivered; the child has not started it after 0s.");
		expect(result.details["taskDelivery"]).toBe("delivered");
	});

	it("delivers the task to seven children spawned at once with a slow placement", async () => {
		const h = setup(root, { delayMs: 40 });
		const results = await Promise.all(Array.from({ length: 7 }, (_, index) => spawn(h, { name: `w${index}` })));
		expect(results.map((result) => result.text.split("\n").at(-1))).toEqual(Array(7).fill("Task delivered."));
		expect(new Set(h.records.mine(SELF).map((record) => record.spawnId)).size).toBe(7);
	});

	it("closes the pane and forgets a spawn whose record cannot be saved", async () => {
		class FailingSave extends ChildRecords {
			override save(): void {
				throw new Error("disk full");
			}
		}
		const h = setup(root, { records: (paths) => new FailingSave(paths) });
		await expect(spawn(h)).rejects.toThrow("Could not persist");
		expect(h.events.at(-1)).toBe("close w1:p1");
		expect(h.sends).toEqual([]);
		expect(h.records.all()).toEqual([]);
	});

	it("stops waiting when the tool call is aborted", async () => {
		const h = setup(root, { child: "silent" });
		h.host.timing.spawnWaitMs = 10_000;
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		const started = Date.now();
		const result = await spawnAction(
			h.host,
			h.ctx,
			{ action: "spawn", role: "worker", task: "x" },
			"call-1",
			controller.signal,
		);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(result.ok).toBe(false);
		expect(h.open.size).toBe(1);
	});

	it("refuses to spawn outside Herdr", async () => {
		const h = setup(root, { inside: false });
		await expect(spawn(h)).rejects.toThrow(OUTSIDE_HERDR);
		expect(h.placed).toEqual([]);
	});

	it("refuses to spawn without a hub", async () => {
		const h = setup(root);
		h.host.bus.unavailable = () => "pi_bus: no hub configured.";
		await expect(spawn(h)).rejects.toThrow("pi_bus: no hub configured.");
		expect(h.placed).toEqual([]);
	});

	it("resolves cwd against the session cwd and refuses a missing one before placement", async () => {
		const h = setup(root);
		mkdirSync(join(h.ctx.cwd, "sub"));
		await spawn(h, { cwd: "sub" });
		expect(h.placed[0]?.request.cwd).toBe(join(h.ctx.cwd, "sub"));
		await expect(spawn(h, { cwd: "missing" })).rejects.toThrow("is not an existing directory");
		expect(h.placed).toHaveLength(1);
	});

	it("reports a prefix-resolved role and unknown allowlist tools", async () => {
		const h = setup(root);
		const result = await spawn(h, { role: "wor", tools: "read,ghost" });
		expect(result.text).toContain('Role: "wor" matched worker.');
		expect(result.text).toContain("Warning: these allowlist tools are not registered here: ghost.");
		expect(h.placed[0]?.spawn?.child.tools).toEqual(["read", "ghost", "pi_bus", "codemode"]);
	});

	it("adds --no-mcp for a role that opts out", async () => {
		const h = setup(root);
		await spawn(h, { role: "explorer" });
		expect(h.placed[0]?.request.args).toContain("--no-mcp");
	});

	it("refuses reserved and malformed labels with one parser", async () => {
		const h = setup(root);
		await expect(spawn(h, { labels: "parent=x" })).rejects.toThrow("cannot be overridden: parent");
		await expect(spawn(h, { labels: "oops" })).rejects.toThrow("Not understood: oops");
	});

	it("returns text content from the tool action", async () => {
		const h = setup(root);
		const result = await runToolAction(h.host, h.ctx, { action: "where" }, "call-1");
		expect(result.text).toBe("herdr: test");
	});
});

describe("roles", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "agents-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("accepts name as an alias of role in define_role and names role when both are missing", () => {
		const h = setup(root);
		const created = defineRoleAction(h.host, h.ctx, { action: "define_role", name: "scout", prompt: "You scout." });
		expect(created.text).toContain('Created session role "scout"');
		expect(() => defineRoleAction(h.host, h.ctx, { action: "define_role", prompt: "x" })).toThrow("requires role");
	});
});

describe("child lifecycle", () => {
	const tmuxPane = { kind: "tmux", handle: "%1", layout: "split", detail: "" } as unknown as Placement;
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "agents-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("reports an unknown process state and keeps the record when no pid is known and the pane stays", async () => {
		const h = setup(root);
		storedRecord(h, { placement: tmuxPane });
		const result = await killAction(h.host, "worker", true);
		expect(result.text).toContain("no pid was recorded: process state unknown");
		expect(result.text).toContain("its tmux pane is not managed");
		expect(result.text).toContain("It is still tracked.");
		expect(h.records.mine(SELF)).toHaveLength(1);
	});

	it("forgets a record without a pid once its pane closed", async () => {
		const h = setup(root);
		h.open.add("w1:p9");
		storedRecord(h);
		const result = await killAction(h.host, "worker", true);
		expect(result.text).toContain("Its record is removed.");
		expect(h.records.mine(SELF)).toEqual([]);
	});

	it("keeps a child that went offline while its process is alive", async () => {
		const h = setup(root);
		h.open.add("w1:p9");
		storedRecord(h);
		writePidFile(h.paths, CHILD, { pid: process.pid, birth: pidBirth(process.pid) });
		await cleanupGoneChild(h.host, { agent: CHILD, name: "worker", online: false, relation: "child" });
		expect(h.events).toEqual([]);
		expect(h.records.mine(SELF)).toHaveLength(1);
	});

	it("closes the pane and forgets a child whose process exited", async () => {
		const h = setup(root);
		h.open.add("w1:p9");
		storedRecord(h);
		writePidFile(h.paths, CHILD, { pid: DEAD_PID });
		await cleanupGoneChild(h.host, { agent: CHILD, name: "worker", online: false, relation: "child" });
		expect(h.events).toEqual(["close w1:p9"]);
		expect(h.records.mine(SELF)).toEqual([]);
		expect(existsSync(pidFilePath(h.paths, CHILD))).toBe(false);
	});

	it("lists children with their status text and prunes only confirmed gone ones", async () => {
		const h = setup(root);
		const gone = "33333333-3333-7333-8333-333333333333";
		const live = "55555555-5555-7555-8555-555555555555";
		storedRecord(h, { spawnId: gone, name: "stale-worker" });
		storedRecord(h, { spawnId: live, name: "live-worker" });
		writePidFile(h.paths, gone, { pid: DEAD_PID, birth: "0" });
		writePidFile(h.paths, live, { pid: process.pid });
		const seen = new Date().toISOString();
		h.rows.set(gone, row(gone, { name: "stale-worker", lastSeenAt: seen }));
		h.rows.set(
			live,
			row(live, { name: "live-worker", online: true, lastSeenAt: seen, status: { text: "testing step 3", at: seen } }),
		);
		const result = await listAction(h.host);
		expect(result.text).toContain("live-worker (worker)");
		expect(result.text).toContain('  says: "testing step 3" (0s ago)');
		const long = `${"s".repeat(150)} long tail`;
		h.rows.set(live, { ...(h.rows.get(live) as AgentInfo), status: { text: long, at: seen } });
		expect((await listAction(h.host)).text).toContain(`  says: "${long}" (0s ago)`);
		expect(result.text).toContain("  address: id:555555555555");
		expect(result.text).not.toContain("stale-worker");
		expect(h.records.mine(SELF).map((record) => record.name)).toEqual(["live-worker"]);
	});

	it("says that no child runs after the last child is gone", async () => {
		const h = setup(root);
		const gone = "33333333-3333-7333-8333-333333333333";
		storedRecord(h, { spawnId: gone, name: "done-worker" });
		writePidFile(h.paths, gone, { pid: DEAD_PID, birth: "0" });
		h.rows.set(gone, row(gone, { name: "done-worker", lastSeenAt: new Date().toISOString() }));
		expect((await listAction(h.host)).text).toBe("No child of this session is running.");
		await expect(closeAction(h.host, undefined)).rejects.toThrow("No child of this session is running.");
	});

	it("says the pane is not managed when an offline tmux child cannot be closed", async () => {
		const h = setup(root);
		storedRecord(h, { placement: tmuxPane });
		writePidFile(h.paths, CHILD, { pid: process.pid });
		const result = await closeAction(h.host, "worker");
		expect(result.text).toBe(
			"worker is not online. Its tmux pane is not managed; the record stays for manual resolution.",
		);
		expect(h.events).toEqual([]);
		expect(h.records.mine(SELF)).toHaveLength(1);
	});

	it("expects the offline event of a child that took the close request", async () => {
		const h = setup(root);
		const spawned = await spawn(h);
		const id = String(spawned.details["spawnId"]);
		h.events.length = 0;
		const result = await closeAction(h.host, undefined);
		expect(result.ok).toBe(true);
		expect(h.events).toEqual([`expect ${id}`, `control ${id}`]);
	});

	it("drops the expectation when the close request fails", async () => {
		const h = setup(root);
		const spawned = await spawn(h);
		const id = String(spawned.details["spawnId"]);
		h.closeError = new Error("hub unreachable");
		h.events.length = 0;
		const result = await closeAction(h.host, undefined);
		expect(result.ok).toBe(false);
		expect(result.text).toBe(`Could not deliver the close request to ${h.rows.get(id)?.name}: hub unreachable`);
		expect(h.events).toEqual([`expect ${id}`, `control ${id}`, `cancel ${id}`]);
	});

	it("names the parent check when the hub refuses the close", async () => {
		const h = setup(root);
		await spawn(h);
		h.closeError = new HubHttpError(403, "403 forbidden");
		const result = await closeAction(h.host, undefined);
		expect(result.ok).toBe(false);
		expect(result.text).toMatch(/^Could not close .+: the hub does not list this session as its parent\.$/);
	});

	it.skipIf(process.getuid?.() === 0)("drops the expectation when the killed process survives", async () => {
		const h = setup(root);
		storedRecord(h);
		// pid 1 belongs to another user, so the signals fail and the process stays alive.
		writePidFile(h.paths, CHILD, { pid: 1, birth: pidBirth(1) });
		const result = await killAction(h.host, undefined, false);
		expect(result.text).toContain("survived SIGTERM and SIGKILL");
		expect(h.events).toEqual([`expect ${CHILD}`, `cancel ${CHILD}`]);
		expect(h.records.mine(SELF)).toHaveLength(1);
	});

	it("expects the offline event of a killed child and not of one with an unknown process state", async () => {
		const h = setup(root);
		storedRecord(h);
		writePidFile(h.paths, CHILD, { pid: DEAD_PID });
		expect((await killAction(h.host, undefined, false)).ok).toBe(true);
		expect(h.events).toEqual([`expect ${CHILD}`]);

		const other = setup(join(root, "other"));
		storedRecord(other);
		await killAction(other.host, "worker", false);
		expect(other.events).toEqual([`expect ${CHILD}`, `cancel ${CHILD}`]);
	});

	it("shows a child that linked after the spawn wait", async () => {
		const h = setup(root, { child: "silent" });
		const spawned = await spawn(h);
		const id = String(spawned.details["spawnId"]);
		const known = h.rows.get(id) as AgentInfo;
		h.rows.set(id, { ...known, online: true, lastSeenAt: new Date().toISOString(), state: "busy" });
		const listed = await listAction(h.host);
		expect(listed.text).toContain(`${known.name} (worker)`);
		expect(listed.text).toContain("status: busy");
	});

	it("probes a child through its hub row", async () => {
		const h = setup(root);
		await spawn(h);
		const result = await probeAction(h.host, undefined);
		expect(result.text).toMatch(/  hub: online, seen \d+s ago$/);
		expect(result.details["online"]).toBe(true);
	});

	it("deletes the fork file once the child is online", async () => {
		const h = setup(root, { child: "silent" });
		const fork = join(root, "fork.jsonl");
		writeFileSync(fork, "{}");
		storedRecord(h, { forkFile: fork });
		const { childOnline } = await import("./tool.ts");
		childOnline(h.host, { agent: CHILD, name: "worker", online: true, relation: "child" });
		expect(existsSync(fork)).toBe(false);
		expect(h.records.mine(SELF)[0]?.forkFile).toBeUndefined();
	});

	it("deletes the fork file when it forgets a child that never came online", () => {
		const h = setup(root);
		const fork = join(root, "fork.jsonl");
		writeFileSync(fork, "{}");
		storedRecord(h, { forkFile: fork });
		h.records.forget(CHILD);
		expect(existsSync(fork)).toBe(false);
	});

	it("focuses an open pane and reports a gone or unmanaged one", async () => {
		const h = setup(root);
		const spawned = await spawn(h);
		const name = h.rows.get(String(spawned.details["spawnId"]))?.name;
		expect((await focusAction(h.host, undefined)).text).toBe(`Focused ${name} in its herdr pane.`);
		h.open.clear();
		expect((await focusAction(h.host, undefined)).text).toContain("its pane may be gone");
		storedRecord(h, { name: "old", placement: tmuxPane });
		expect((await focusAction(h.host, "old")).text).toBe("Could not focus old; its tmux pane is not managed.");
	});

	it("prunes old prompt and spawn files, keeps the files of a recorded child, and leaves launchers", async () => {
		const h = setup(root);
		const recorded = storedRecord(h);
		const launchers = join(h.paths.root, "launchers");
		mkdirSync(launchers, { recursive: true });
		mkdirSync(h.paths.prompts, { recursive: true });
		mkdirSync(h.paths.spawn, { recursive: true });
		const files = {
			launcher: join(launchers, "old.sh"),
			keptHook: join(h.paths.prompts, `${recorded.spawnId}-herdr-close.ts`),
			keptPid: pidFilePath(h.paths, recorded.spawnId),
			oldHook: join(h.paths.prompts, "gone-spawn-herdr-close.ts"),
			oldRole: join(h.paths.prompts, `${recorded.spawnId}-role.md`),
			spawn: join(h.paths.spawn, "gone-spawn.json"),
			oldPid: join(h.paths.spawn, "gone-spawn.pid"),
		};
		const dayAgo = (Date.now() - 25 * 60 * 60_000) / 1000;
		for (const file of Object.values(files)) {
			writeFileSync(file, "x");
			utimesSync(file, dayAgo, dayAgo);
		}
		const v1 = (spawnId: string, ageMs: number) =>
			h.records.save({
				...recorded,
				spawnId,
				launchedAt: Date.now() - ageMs,
				launchedBy: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
				controlToken: "x",
			} as ChildRecord);
		const oldV1 = "11111111-2222-4333-8444-555555555555";
		const liveV1 = "11111111-2222-4333-8444-666666666666";
		v1(oldV1, 25 * 60 * 60_000);
		v1(liveV1, 60 * 60_000);
		pruneFiles(h.paths, "sess");
		expect(h.records.all().map((record) => record.spawnId)).toEqual([liveV1, recorded.spawnId]);
		expect(existsSync(files.launcher)).toBe(true);
		expect(existsSync(files.oldHook)).toBe(false);
		expect(existsSync(files.oldRole)).toBe(false);
		expect(existsSync(files.spawn)).toBe(false);
		expect(existsSync(files.oldPid)).toBe(false);
		expect(existsSync(files.keptHook)).toBe(true);
		expect(existsSync(files.keptPid)).toBe(true);
	});

	it("leaves no spawn file behind for a child that read it", async () => {
		const h = setup(root);
		const result = await spawn(h);
		expect(existsSync(spawnFilePath(h.paths, String(result.details["spawnId"])))).toBe(false);
	});
});
