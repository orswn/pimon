import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { BusService } from "../bus/index.ts";
import type { PeerRecord, SendResult } from "../bus/protocol.ts";
import { pidBirth } from "../bus/registry.ts";
import { OUTSIDE_HERDR, type PlacementRequest, type Placer } from "./placement.ts";
import { type ChildRecord, ChildRecords } from "./records.ts";
import { type AgentPaths, agentPaths, type SpawnFile, takeSpawnFile } from "./spawn-file.ts";
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

const OWNER = "0123456789abcdef0123456789abcdef";
const DEAD_PID = 99_999_999;

interface Harness {
	host: AgentsHost;
	ctx: ExtensionContext;
	events: string[];
	peers: PeerRecord[];
	placed: { request: PlacementRequest; spawn?: SpawnFile }[];
	open: Set<string>;
	records: ChildRecords;
	paths: AgentPaths;
	root: string;
}

type ChildBehavior = "join" | "silent";

interface Options {
	inside?: boolean;
	child?: ChildBehavior;
	delayMs?: number;
	records?: (paths: AgentPaths) => ChildRecords;
	tools?: string[];
}

function peerRecord(spawn: SpawnFile, index: number): PeerRecord {
	return {
		protocol: 1,
		host: "test",
		instanceId: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
		owner: `${String(index).padStart(8, "0")}aaaabbbbccccdddd00000000`,
		name: spawn.child.name ?? `${spawn.role.name}-${index}`,
		pid: process.pid,
		pidBirth: pidBirth(process.pid),
		cwd: "/tmp",
		sock: "/tmp/none.sock",
		labels: spawn.child.labels,
		topics: [],
		state: "idle",
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
	};
}

function setup(root: string, options: Options = {}): Harness {
	const events: string[] = [];
	const peers: PeerRecord[] = [];
	const placed: Harness["placed"] = [];
	const open = new Set<string>();
	const paths = agentPaths(join(root, "agents"));
	const records = options.records?.(paths) ?? new ChildRecords(paths);
	let next = 0;
	const placer: Placer = {
		inside: () => options.inside ?? true,
		async place(request) {
			if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
			const handle = `w1:p${++next}`;
			open.add(handle);
			const entry: Harness["placed"][number] = { request };
			placed.push(entry);
			if ((options.child ?? "join") === "join") {
				const taken = takeSpawnFile(request.env["PIMON_SPAWN_FILE"] ?? "");
				if ("data" in taken) {
					entry.spawn = taken.data;
					peers.push(peerRecord(taken.data, next));
				}
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
	const bus = {
		launch: {},
		owner: OWNER,
		started: true,
		name: "boss",
		instanceId: "ffffffff-0000-4000-8000-000000000000",
		labels: {},
		resolve: (selector: string) => {
			const spawn = selector.replace(/^label:spawn=/, "");
			return peers.filter((peer) => peer.labels["spawn"] === spawn);
		},
		watch: (peer: PeerRecord | string) => {
			events.push(`watch ${typeof peer === "string" ? peer : peer.instanceId}`);
			return true;
		},
		unwatch: (instanceId: string) => events.push(`unwatch ${instanceId}`),
		probe: async (selector: string) => {
			events.push(`probe ${selector}`);
			return [{ name: "w", instanceId: selector.slice(3), alive: true, rttMs: 3 }];
		},
		send: async () => {
			throw new Error("unused");
		},
		sendTo: async (peer: PeerRecord): Promise<SendResult> => {
			events.push(`control ${peer.instanceId}`);
			return { delivered: [peer], unknown: [], failed: [], matched: [peer], acks: [] } as unknown as SendResult;
		},
		expectExit: (owner: string, reasons?: string[]) => {
			events.push(`expect ${owner}${reasons ? ` ${reasons.join(",")}` : ""}`);
			return () => events.push(`cancel ${owner}`);
		},
		onPeerGone: () => () => {},
		onReady: () => () => {},
		setSpawnIdentity: () => {},
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
		timing: { spawnWaitMs: 300, pollMs: 10, killGraceMs: 50 },
		pruneOnce: () => {},
	};
	return { host, ctx, events, peers, placed, open, records, paths, root };
}

const spawn = (h: Harness, params: Partial<AgentsToolInput> = {}, callId = "call-1") =>
	spawnAction(h.host, h.ctx, { action: "spawn", role: "worker", task: "Do the thing.", ...params }, callId);

function storedRecord(h: Harness, overrides: Partial<ChildRecord> = {}): ChildRecord {
	const record: ChildRecord = {
		spawnId: "11111111-1111-1111-1111-111111111111",
		name: "worker",
		role: "worker",
		task: "t",
		cwd: "/tmp",
		placement: { kind: "herdr", handle: "w1:p9", tabId: "w1:t9", layout: "tab", detail: "test" },
		launchedAt: Date.now() - 60_000,
		launchedBy: OWNER,
		controlToken: "tok",
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

	it("confirms the task once the child read its spawn file and joined the bus", async () => {
		const h = setup(root);
		const result = await spawn(h);
		const peer = h.peers[0] as PeerRecord;
		expect(result.text.split("\n")).toEqual([
			`Started: ${peer.name} (worker, herdr tab).`,
			"Runtime: model p/m (inherited), thinking medium (inherited).",
			"Context: isolated.",
			`Bus: owner:${peer.owner.slice(0, 12)}.`,
			"Task delivered.",
		]);
		expect(result.details).toMatchObject({ taskDelivery: "delivered", owner: peer.owner });
		expect(h.events).toEqual([`watch ${peer.instanceId}`]);
		expect(h.records.mine(OWNER)).toMatchObject([{ instanceId: peer.instanceId, pid: process.pid }]);
	});

	it("keeps the task, the token, and the role prompt out of argv and env", async () => {
		const h = setup(root);
		await spawn(h, { task: "--help me" });
		const { request, spawn: data } = h.placed[0] as Harness["placed"][number];
		const visible = JSON.stringify([request.args, request.env, request.title]);
		expect(data?.task).toBe("Task: --help me");
		expect(data?.role.prompt).toContain("You work.");
		expect(visible).not.toContain("--append-system-prompt");
		expect(visible).not.toContain("--help me");
		expect(visible).not.toContain(data?.controlToken);
		expect(visible).not.toContain("You work.");
		expect(Object.keys(request.env)).toEqual(["PIMON_SPAWN_FILE", "PI_CODING_AGENT_DIR"]);
		expect(request.env["PI_CODING_AGENT_DIR"]).toBe(process.env["PI_CODING_AGENT_DIR"]);
		expect(data?.child.labels).toMatchObject({ role: "worker", parent: OWNER, depth: "1" });
		expect(data?.parent).toEqual({ name: "boss", owner: OWNER });
	});

	it("reports an unconfirmed task and keeps the pane when the child never reads its spawn file", async () => {
		const h = setup(root, { child: "silent" });
		const result = await spawn(h);
		expect(result.text).toContain("Bus: not visible after 0s.");
		expect(result.text.split("\n").at(-1)).toBe(
			"Task unconfirmed: the child has not read its spawn file. The pane stays open for inspection.",
		);
		expect(result.ok).toBe(false);
		expect(h.open.size).toBe(1);
		expect(h.records.mine(OWNER)).toHaveLength(1);
		expect(h.events).toEqual([]);
	});

	it("delivers the task to seven children spawned at once with a slow placement", async () => {
		const h = setup(root, { delayMs: 40 });
		const results = await Promise.all(Array.from({ length: 7 }, (_, index) => spawn(h, { name: `w${index}` })));
		expect(results.map((result) => result.text.split("\n").at(-1))).toEqual(Array(7).fill("Task delivered."));
		expect(new Set(h.records.mine(OWNER).map((record) => record.instanceId)).size).toBe(7);
	});

	it("unwinds a spawn whose endpoint record cannot be saved: unwatch, close the pane, forget", async () => {
		let saves = 0;
		class FailingSecondSave extends ChildRecords {
			override save(record: ChildRecord): void {
				if (++saves === 2) throw new Error("disk full");
				super.save(record);
			}
		}
		const h = setup(root, { records: (paths) => new FailingSecondSave(paths) });
		await expect(spawn(h)).rejects.toThrow("Could not persist");
		const instanceId = h.peers[0]?.instanceId;
		expect(h.events).toEqual([`unwatch ${instanceId}`, "close w1:p1"]);
		expect(h.records.all()).toEqual([]);
	});

	it("stops waiting and reports an unconfirmed task when the tool call is aborted", async () => {
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
		expect(result.text.split("\n").at(-1)).toBe(
			"Task unconfirmed: the child has not read its spawn file. The pane stays open for inspection.",
		);
		expect(h.open.size).toBe(1);
	});

	it("refuses to spawn outside Herdr", async () => {
		const h = setup(root, { inside: false });
		await expect(spawn(h)).rejects.toThrow(OUTSIDE_HERDR);
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
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "agents-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("reports an unknown process state and keeps the record when no pid is known and the pane stays", async () => {
		const h = setup(root);
		storedRecord(h, { placement: { kind: "tmux", handle: "%1", layout: "split", detail: "" } });
		const result = await killAction(h.host, "worker", true);
		expect(result.text).toContain("no pid was recorded: process state unknown");
		expect(result.text).toContain("its tmux pane is not managed");
		expect(result.text).toContain("It is still tracked.");
		expect(h.records.mine(OWNER)).toHaveLength(1);
	});

	it("forgets a record without a pid once its pane closed", async () => {
		const h = setup(root);
		h.open.add("w1:p9");
		storedRecord(h);
		const result = await killAction(h.host, "worker", true);
		expect(result.text).toContain("Its record is removed.");
		expect(h.records.mine(OWNER)).toEqual([]);
	});

	it("keeps a child whose endpoint left while its process is alive", async () => {
		const h = setup(root);
		h.open.add("w1:p9");
		const record = storedRecord(h, {
			instanceId: "22222222-2222-4222-8222-222222222222",
			pid: process.pid,
			pidBirth: pidBirth(process.pid),
		});
		await cleanupGoneChild(h.host, {
			record: { instanceId: record.instanceId, pid: process.pid } as PeerRecord,
			reason: "left",
			pending: [],
		});
		expect(h.events).toEqual([]);
		expect(h.records.mine(OWNER)).toHaveLength(1);
	});

	it("closes the pane and forgets a child whose process exited", async () => {
		const h = setup(root);
		h.open.add("w1:p9");
		const record = storedRecord(h, { instanceId: "22222222-2222-4222-8222-222222222222", pid: DEAD_PID });
		await cleanupGoneChild(h.host, {
			record: { instanceId: record.instanceId, pid: DEAD_PID } as PeerRecord,
			reason: "exited",
			pending: [],
		});
		expect(h.events).toEqual(["close w1:p9", "unwatch 22222222-2222-4222-8222-222222222222"]);
		expect(h.records.mine(OWNER)).toEqual([]);
	});

	it("lists children and prunes only confirmed gone ones", async () => {
		const h = setup(root);
		storedRecord(h, {
			spawnId: "33333333-3333-3333-3333-333333333333",
			name: "stale-worker",
			instanceId: "44444444-4444-4444-4444-444444444444",
			pid: DEAD_PID,
			pidBirth: "0",
		});
		storedRecord(h, {
			spawnId: "55555555-5555-5555-5555-555555555555",
			name: "live-worker",
			instanceId: "66666666-6666-6666-6666-666666666666",
			pid: process.pid,
		});
		const result = await listAction(h.host);
		expect(result.text).toContain("live-worker (worker)");
		expect(result.text).not.toContain("stale-worker");
		expect(h.records.mine(OWNER).map((record) => record.name)).toEqual(["live-worker"]);
	});

	it("closes an old tmux child over the bus and says the pane is not managed when it is gone", async () => {
		const h = setup(root);
		storedRecord(h, { placement: { kind: "tmux", handle: "%1", layout: "split", detail: "" }, pid: process.pid });
		const result = await closeAction(h.host, "worker");
		expect(result.text).toBe(
			"worker is not on the bus. Its tmux pane is not managed; the record stays for manual resolution.",
		);
		expect(h.records.mine(OWNER)).toHaveLength(1);
	});

	it("expects the exit of a child that took the close request", async () => {
		const h = setup(root);
		await spawn(h);
		const peer = h.peers[0] as PeerRecord;
		h.events.length = 0;
		await closeAction(h.host, undefined);
		expect(h.events).toEqual([`expect ${peer.owner} left`, `control ${peer.instanceId}`]);
	});

	it("drops the expectation when the close request throws", async () => {
		const h = setup(root);
		await spawn(h);
		const peer = h.peers[0] as PeerRecord;
		h.host.bus.sendTo = async () => {
			throw new Error("no live peer matches");
		};
		h.events.length = 0;
		await expect(closeAction(h.host, undefined)).rejects.toThrow("no live peer matches");
		expect(h.events).toEqual([`expect ${peer.owner} left`, `cancel ${peer.owner}`]);
	});

	it("drops the expectation when the close request is not delivered", async () => {
		const h = setup(root);
		await spawn(h);
		const peer = h.peers[0] as PeerRecord;
		h.host.bus.sendTo = async () =>
			({
				delivered: [],
				unknown: [],
				failed: [{ ...peer, reason: "refused" }],
				matched: [peer],
				acks: [],
			}) as unknown as SendResult;
		h.events.length = 0;
		const result = await closeAction(h.host, undefined);
		expect(result.ok).toBe(false);
		expect(h.events).toEqual([`expect ${peer.owner} left`, `cancel ${peer.owner}`]);
	});

	it.skipIf(process.getuid?.() === 0)("drops the expectation when the killed process survives", async () => {
		const h = setup(root);
		await spawn(h);
		const peer = h.peers[0] as PeerRecord;
		// pid 1 belongs to another user, so the signals fail and the process stays alive.
		h.peers.splice(0, 1, { ...peer, pid: 1, pidBirth: pidBirth(1) });
		storedRecord(h, { spawnId: String(peer.labels["spawn"]), instanceId: peer.instanceId, pidBirth: pidBirth(1) });
		h.events.length = 0;
		const result = await killAction(h.host, undefined, false);
		expect(result.text).toContain("survived SIGTERM and SIGKILL");
		expect(h.events.filter((event) => event.startsWith("expect") || event.startsWith("cancel"))).toEqual([
			`expect ${peer.owner}`,
			`cancel ${peer.owner}`,
		]);
	});

	it("expects the exit of a killed child and not of a child with an unknown process state", async () => {
		const h = setup(root);
		await spawn(h);
		const peer = h.peers[0] as PeerRecord;
		h.peers.splice(0, 1, { ...peer, pid: DEAD_PID });
		h.events.length = 0;
		expect((await killAction(h.host, undefined, false)).ok).toBe(true);
		expect(h.events.filter((event) => event.startsWith("expect") || event.startsWith("cancel"))).toEqual([
			`expect ${peer.owner}`,
		]);

		const other = setup(join(root, "other"));
		storedRecord(other, { spawnId: String(peer.labels["spawn"]), instanceId: peer.instanceId });
		other.peers.push({ ...peer, pid: undefined } as unknown as PeerRecord);
		await killAction(other.host, "worker", false);
		expect(other.events.filter((event) => event.startsWith("expect") || event.startsWith("cancel"))).toEqual([
			`expect ${peer.owner}`,
			`cancel ${peer.owner}`,
		]);
	});

	it("sends the control token when it closes a live child", async () => {
		const h = setup(root);
		await spawn(h);
		const peer = h.peers[0] as PeerRecord;
		const result = await closeAction(h.host, undefined);
		expect(result.text).toContain("Asked");
		expect(h.events.at(-1)).toBe(`control ${peer.instanceId}`);
	});

	it("adopts a child that joined the bus after the spawn wait", async () => {
		const h = setup(root, { child: "silent" });
		const spawned = await spawn(h);
		const spawnId = String(spawned.details["spawnId"]);
		const late = peerRecord(
			{
				role: { name: "worker", prompt: "" },
				child: { name: "late-w", labels: { spawn: spawnId, parent: OWNER } },
			} as unknown as SpawnFile,
			7,
		);
		h.peers.push(late);
		const listed = await listAction(h.host);
		expect(listed.text).toContain("late-w (worker)");
		expect(listed.text).toContain("status: idle");
		expect(h.events).toEqual([`watch ${late.instanceId}`]);
		expect(h.records.mine(OWNER)).toMatchObject([
			{ name: "late-w", instanceId: late.instanceId, pid: process.pid, pidBirth: late.pidBirth },
		]);
	});

	it("refuses to close or kill a child whose endpoint changed", async () => {
		const h = setup(root);
		await spawn(h);
		const first = h.peers[0] as PeerRecord;
		h.peers.splice(0, 1, { ...first, instanceId: "99999999-0000-4000-8000-000000000000" });
		const closed = await closeAction(h.host, undefined);
		const killed = await killAction(h.host, undefined, true);
		for (const result of [closed, killed]) {
			expect(result.ok).toBe(false);
			expect(result.text).toContain("its endpoint changed after a child reload");
		}
		expect(h.events.filter((event) => /^(control|close|expect)/.test(event))).toEqual([]);
		expect(h.records.mine(OWNER)).toHaveLength(1);
	});

	it("probes a live child by its endpoint and hides the token", async () => {
		const h = setup(root);
		await spawn(h);
		const peer = h.peers[0] as PeerRecord;
		const result = await probeAction(h.host, undefined);
		expect(h.events.at(-1)).toBe(`probe id:${peer.instanceId}`);
		expect(result.text).toContain("  probe: answered in 3ms");
		expect(JSON.stringify(result.details)).not.toContain("controlToken");
	});

	it("focuses an open pane and reports a gone or unmanaged one", async () => {
		const h = setup(root);
		await spawn(h);
		expect((await focusAction(h.host, undefined)).text).toBe(`Focused ${h.peers[0]?.name} in its herdr pane.`);
		h.open.clear();
		expect((await focusAction(h.host, undefined)).text).toContain("its pane may be gone");
		storedRecord(h, { name: "old", placement: { kind: "tmux", handle: "%1", layout: "split", detail: "" } });
		expect((await focusAction(h.host, "old")).text).toBe("Could not focus old; its tmux pane is not managed.");
	});

	it("prunes old launchers and spawn files but keeps the close hook of a recorded child", async () => {
		const h = setup(root);
		const recorded = storedRecord(h);
		const launchers = join(h.paths.root, "launchers");
		mkdirSync(launchers, { recursive: true });
		mkdirSync(h.paths.prompts, { recursive: true });
		mkdirSync(h.paths.spawn, { recursive: true });
		const files = {
			launcher: join(launchers, "old.sh"),
			keptHook: join(h.paths.prompts, `${recorded.spawnId}-herdr-close.ts`),
			oldHook: join(h.paths.prompts, "gone-spawn-herdr-close.ts"),
			spawn: join(h.paths.spawn, "gone-spawn.json"),
		};
		const dayAgo = (Date.now() - 25 * 60 * 60_000) / 1000;
		for (const file of Object.values(files)) {
			writeFileSync(file, "x");
			utimesSync(file, dayAgo, dayAgo);
		}
		pruneFiles(h.paths, "sess");
		expect(existsSync(files.launcher)).toBe(false);
		expect(existsSync(files.oldHook)).toBe(false);
		expect(existsSync(files.spawn)).toBe(false);
		expect(existsSync(files.keptHook)).toBe(true);
	});

	it("leaves no spawn file behind for a child that read it", async () => {
		const h = setup(root);
		const result = await spawn(h);
		expect(existsSync(join(h.paths.spawn, `${String(result.details["spawnId"])}.json`))).toBe(false);
	});
});
