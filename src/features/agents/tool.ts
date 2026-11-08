import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BusService } from "../bus/index.ts";
import type { PeerGone } from "../bus/node.ts";
import type { SendResult } from "../bus/protocol.ts";
import type { PeerRecord } from "../bus/protocol.ts";
import { shortId } from "../bus/protocol.ts";
import { pidAlive, pidBirth } from "../bus/registry.ts";
import { defineSessionRole, deleteSessionRole, pruneOld, sessionKey, sessionRolesDir } from "./adhoc.ts";
import { buildInitialPrompt, CONTEXT_MODES, createForkSession, resolveContextMode } from "./context.ts";
import { OUTSIDE_HERDR, type Placement, type Placer, writeCloseHook } from "./placement.ts";
import { type ChildRecord, ChildRecords } from "./records.ts";
import { discoverRoles, findRole, formatRoles, parseLabelList, type Role, type RoleSources } from "./roles.ts";
import { formatRuntime, type ResolvedRuntime, resolveRuntime, THINKING_LEVELS } from "./runtime.ts";
import { type AgentPaths, placedMarkerPath, writePrivateFile, writeSpawnFile } from "./spawn-file.ts";

const RESERVED_LABELS = new Set(["spawn", "depth", "parent", "owner", "role"]);
const MAX_DEPTH = 2;
const STARTING_MS = 45_000;
/** A child without the bus cannot report back. codemode reaches MCP tools without listing each in a role. */
const MANDATORY_CHILD_TOOLS = ["pi_bus", "codemode"];

export const AGENTS_TOOL_DESCRIPTION =
	"Start and manage visible child pi instances, each in its own Herdr tab. A child runs a role from the user roles directory or a session role, or a project role with projectRoles, and reports back over pi_bus. Spawning never waits for the child's work.";

export const agentsToolSchema = Type.Object({
	action: StringEnum([
		"spawn",
		"list",
		"probe",
		"close",
		"kill",
		"focus",
		"roles",
		"define_role",
		"delete_role",
		"where",
	] as const),
	role: Type.Optional(
		Type.String({ description: "Role name from the roles list. Required for spawn, define_role, and delete_role." }),
	),
	task: Type.Optional(Type.String({ description: "First instruction for the child. Required for spawn." })),
	context: Type.Optional(
		StringEnum(CONTEXT_MODES, {
			description: "Defaults to isolated.",
		}),
	),
	brief: Type.Optional(
		Type.String({
			description: "Concise parent context for context=handoff. Put large evidence in a temporary file.",
		}),
	),
	name: Type.Optional(
		Type.String({
			description: "For spawn: label for the child, defaults to <role>-<session tag>. For define_role: alias of role.",
		}),
	),
	agent: Type.Optional(
		Type.String({
			description:
				"Which child to act on for probe, close, kill, focus: its name, a unique name prefix, its role, a spawn id prefix, or id:<hex>.",
		}),
	),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the child, relative to this session's cwd. Must exist." }),
	),
	model: Type.Optional(
		Type.String({
			description: "Model for the child. Defaults to the role's model, then to the model this session is using.",
		}),
	),
	thinking: Type.Optional(
		StringEnum(THINKING_LEVELS, {
			description: "Thinking level for the child. Defaults to the role's level, then to this session's level.",
		}),
	),
	description: Type.Optional(Type.String({ description: "For define_role: one line on when to use this role." })),
	prompt: Type.Optional(
		Type.String({ description: "For define_role: the role's system prompt. Required when creating." }),
	),
	tools: Type.Optional(
		Type.String({ description: "Comma separated tool allowlist for the child. pi_bus and codemode are always kept." }),
	),
	labels: Type.Optional(Type.String({ description: "Extra bus labels, key=value separated by commas." })),
	projectRoles: Type.Optional(Type.Boolean({ description: "Also load repo-controlled roles from .pi/agents." })),
	force: Type.Optional(Type.Boolean({ description: "For kill: also close the child's pane. Defaults to true." })),
});

type AgentsAction =
	| "spawn"
	| "list"
	| "probe"
	| "close"
	| "kill"
	| "focus"
	| "roles"
	| "define_role"
	| "delete_role"
	| "where";

export interface AgentsToolInput {
	action: AgentsAction;
	role?: string | undefined;
	task?: string | undefined;
	context?: string | undefined;
	brief?: string | undefined;
	name?: string | undefined;
	agent?: string | undefined;
	cwd?: string | undefined;
	model?: string | undefined;
	thinking?: string | undefined;
	description?: string | undefined;
	prompt?: string | undefined;
	tools?: string | undefined;
	labels?: string | undefined;
	projectRoles?: boolean | undefined;
	force?: boolean | undefined;
}

export interface ActionResult {
	text: string;
	details: Record<string, unknown>;
	/** False when the action did not reach its goal but is not an error. Commands show it as a warning. */
	ok?: boolean;
}

export interface AgentsHost {
	pi: ExtensionAPI;
	bus: BusService;
	paths: AgentPaths;
	/** As pi resolved it, with `~` expanded. */
	agentDir: string;
	/** `<agentDir>/agents`. */
	userRolesDir: string;
	placer: Placer;
	records: ChildRecords;
	timing: { spawnWaitMs: number; pollMs: number; killGraceMs: number; placedPollMs: number; placedWaitMs: number };
	/** Prunes old files once per process. */
	pruneOnce(sessionRoleKey: string): void;
}

function truncate(value: string, max = 120): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function ago(timestamp: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${Math.round(seconds / 3600)}h`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((done) => {
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", finish);
			done();
		};
		const timer = setTimeout(finish, ms);
		signal?.addEventListener("abort", finish, { once: true });
	});
}

function requireBus(bus: BusService): BusService {
	if (!bus.started) {
		throw new Error(
			"pi-bus is not running, so child ownership cannot be verified. Refusing to act on stored child records.",
		);
	}
	return bus;
}

function roleSources(host: AgentsHost, ctx: ExtensionContext, projectRoles: boolean | undefined): RoleSources {
	const key = sessionKey(ctx.sessionManager.getSessionId(), host.bus.owner);
	host.pruneOnce(key);
	return {
		userDir: host.userRolesDir,
		cwd: ctx.cwd,
		scope: projectRoles ? "both" : "user",
		sessionDir: sessionRolesDir(key, host.paths.roles),
	};
}

/** Resolve the one live peer for a record. A foreign parent label is never accepted. */
function matchingPeer(host: AgentsHost, record: ChildRecord): PeerRecord | undefined {
	if (!host.bus.started) return undefined;
	let matches: PeerRecord[];
	try {
		matches = host.bus.resolve(`label:spawn=${record.spawnId}`);
	} catch {
		return undefined;
	}
	const mine = matches.filter((peer) => peer.labels["parent"] === host.bus.owner);
	return mine.length === 1 ? mine[0] : undefined;
}

/** A changed endpoint is not adopted: child reload is unsupported and its control link is stale. */
function peerFor(host: AgentsHost, record: ChildRecord): PeerRecord | undefined {
	const peer = matchingPeer(host, record);
	if (!peer || (record.instanceId && peer.instanceId !== record.instanceId)) return undefined;
	return peer;
}

function endpointChangedPeer(host: AgentsHost, record: ChildRecord): PeerRecord | undefined {
	const peer = matchingPeer(host, record);
	return peer && record.instanceId && peer.instanceId !== record.instanceId ? peer : undefined;
}

/** A child that joined after the spawn wait. Without its endpoint, exit notices and cleanup never match it. */
function adoptLateChild(host: AgentsHost, record: ChildRecord): void {
	if (record.instanceId) return;
	const peer = peerFor(host, record);
	if (!peer) return;
	record.name = peer.name;
	record.instanceId = peer.instanceId;
	record.pid = peer.pid;
	record.pidBirth = peer.pidBirth;
	try {
		host.records.save(record);
	} catch {
		// The record stays owned in memory; the next save retries.
	}
	host.bus.watch(peer);
}

function myChildren(host: AgentsHost): ChildRecord[] {
	const children = host.records.mine(host.bus.owner);
	for (const child of children) adoptLateChild(host, child);
	return children;
}

function resolveChild(host: AgentsHost, reference: string | undefined): ChildRecord {
	requireBus(host.bus);
	const children = myChildren(host);
	if (children.length === 0) throw new Error("No children have been spawned from this session.");
	if (!reference) {
		if (children.length === 1 && children[0]) return children[0];
		throw new Error(`Name the child. Current children: ${children.map((child) => child.name).join(", ")}`);
	}
	const wanted = reference.replace(/^id:/, "").toLowerCase();
	const matches = children.filter(
		(child) =>
			child.name === reference ||
			child.name.toLowerCase().startsWith(wanted) ||
			child.role.toLowerCase() === wanted ||
			child.spawnId.startsWith(wanted) ||
			(child.instanceId ? shortId(child.instanceId).startsWith(wanted) : false),
	);
	if (matches.length === 1 && matches[0]) return matches[0];
	if (matches.length === 0) {
		throw new Error(
			`No child matches "${reference}". Children: ${children.map((child) => `${child.name} (role ${child.role})`).join(", ")}`,
		);
	}
	throw new Error(
		`"${reference}" matches ${matches.length} children: ${matches.map((child) => child.name).join(", ")}. Use the exact name or the spawn id from action="list".`,
	);
}

type ChildStatus = "live" | "blocked" | "exited" | "starting" | "never-started" | "endpoint-changed";

function childStatus(record: ChildRecord, peer: PeerRecord | undefined, changed: PeerRecord | undefined): ChildStatus {
	if (changed) return "endpoint-changed";
	if (peer) return peer.stale ? "blocked" : "live";
	// A pane outlives its child, so having been seen on the bus once separates exited from never started.
	if (record.instanceId) return "exited";
	return Date.now() - record.launchedAt < STARTING_MS ? "starting" : "never-started";
}

/**
 * A child that is starting or on the bus. `leftEndpoints` holds endpoints that announced their exit:
 * their presence stays listed until the child process removes it.
 */
export function isActiveChild(host: AgentsHost, record: ChildRecord, leftEndpoints: ReadonlySet<string>): boolean {
	const left = record.instanceId !== undefined && leftEndpoints.has(record.instanceId);
	const state = childStatus(record, left ? undefined : peerFor(host, record), endpointChangedPeer(host, record));
	return state !== "exited" && state !== "never-started";
}

function paneText(placement: Placement, alive: boolean | undefined): string {
	if (alive === undefined) return `${placement.kind} ${placement.layout}, pane not managed`;
	return alive ? `${placement.kind} ${placement.layout}` : `${placement.kind} ${placement.layout}, pane is gone`;
}

async function describeChild(host: AgentsHost, record: ChildRecord): Promise<string> {
	const peer = peerFor(host, record);
	const changed = endpointChangedPeer(host, record);
	const alive = await host.placer.alive(record.placement);
	const state = childStatus(record, peer, changed);
	const status =
		state === "live"
			? peer?.state || "idle"
			: state === "blocked"
				? "blocked, its event loop is stalled"
				: state === "endpoint-changed"
					? "endpoint changed after child reload, child reload is unsupported"
					: state === "exited"
						? `exited${alive ? ", its pane is still open" : ""}`
						: state === "starting"
							? "starting, not on the bus yet"
							: "never joined the bus, check its pane for an error";
	const activity = peer?.activity || changed?.activity;
	const address = peer
		? `owner:${shortId(peer.owner)}`
		: changed
			? `endpoint changed, new owner:${shortId(changed.owner)}`
			: "not on the bus";
	return [
		`${record.name} (${record.role})`,
		`  context: ${record.contextMode || "isolated"}`,
		`  status: ${status}${activity ? `, doing "${truncate(activity, 40)}"` : ""}`,
		`  address: ${address}`,
		`  spawn id: ${record.spawnId.slice(0, 8)}`,
		`  pane: ${paneText(record.placement, alive)}`,
		`  age: ${ago(record.launchedAt)}`,
		`  cwd: ${record.cwd}`,
		`  task: ${truncate(record.task, 100)}`,
	].join("\n");
}

function sameProcess(pid: number, birth: string | undefined): boolean {
	if (!pidAlive(pid)) return false;
	if (!birth) return true;
	return pidBirth(pid) === birth;
}

/** Signalling needs a known birth: a recycled pid belongs to an unrelated process. */
function pidLive(pid: number | undefined, birth: string | undefined): boolean {
	if (!pid || !birth || !pidAlive(pid)) return false;
	return pidBirth(pid) === birth;
}

function pidGone(pid: number | undefined, birth: string | undefined): boolean {
	if (!pid || !pidAlive(pid)) return true;
	if (!birth) return false;
	const current = pidBirth(pid);
	return !current || current !== birth;
}

function forgetTracked(host: AgentsHost, record: ChildRecord): void {
	host.records.forget(record.spawnId);
	if (record.instanceId && host.bus.started) host.bus.unwatch(record.instanceId);
}

/** Forget records whose endpoint and process are both confirmed gone. */
function pruneGoneChildren(host: AgentsHost, includeNeverStarted = false): string[] {
	if (!host.bus.started) return [];
	const removed: string[] = [];
	for (const child of host.records.mine(host.bus.owner)) {
		const state = childStatus(child, peerFor(host, child), endpointChangedPeer(host, child));
		if (state !== "exited" && !(includeNeverStarted && state === "never-started")) continue;
		if (!pidGone(child.pid, child.pidBirth)) continue;
		forgetTracked(host, child);
		removed.push(child.name);
	}
	return removed;
}

export async function cleanupGoneChild(host: AgentsHost, event: PeerGone): Promise<void> {
	if (!host.bus.started) return;
	const record = host.records.mine(host.bus.owner).find((child) => child.instanceId === event.record.instanceId);
	if (!record) return;
	// A session replacement can retire the old endpoint before its replacement appears.
	const current = matchingPeer(host, record);
	if (current && current.instanceId !== event.record.instanceId) return;
	const pid = record.pid ?? event.record.pid;
	const birth = record.pidBirth ?? event.record.pidBirth;
	// A stopped endpoint is not a stopped process: /new or /resume in the child stops it first.
	if (event.reason === "left" && pid && sameProcess(pid, birth)) return;
	const closed = await host.placer.close(record.placement);
	const alive = await host.placer.alive(record.placement);
	if (closed || alive === false || pidGone(pid, birth)) forgetTracked(host, record);
}

export function rewatchChildren(host: AgentsHost): void {
	if (!host.bus.started) return;
	pruneGoneChildren(host);
	for (const child of host.records.mine(host.bus.owner)) {
		if (!child.instanceId) {
			adoptLateChild(host, child);
			continue;
		}
		const peer = peerFor(host, child);
		if (peer) host.bus.watch(peer);
	}
}

export function rolesAction(host: AgentsHost, ctx: ExtensionContext, params: AgentsToolInput): ActionResult {
	const sources = roleSources(host, ctx, params.projectRoles);
	const problems: string[] = [];
	const roles = discoverRoles(sources, problems);
	const broken = problems.length > 0 ? `\nRole file problems: ${problems.join("; ")}` : "";
	const hint = sources.sessionDir
		? `\nSession roles vanish with this session. Persist one with: mv ${sources.sessionDir}/<name>.md ${host.userRolesDir}/`
		: "";
	return { text: formatRoles(roles, host.userRolesDir) + broken + hint, details: { roles: roles.map((r) => r.name) } };
}

export function defineRoleAction(host: AgentsHost, ctx: ExtensionContext, params: AgentsToolInput): ActionResult {
	const raw = params.role ?? params.name;
	if (!raw) throw new Error('pi_agents action="define_role" requires role, the name to create or patch.');
	const sources = roleSources(host, ctx, false);
	const sessionDir = sources.sessionDir ?? "";
	const name = raw.trim().toLowerCase();
	// A session role that shadows a curated one would make a later spawn use the wrong prompt unnoticed.
	const curated = discoverRoles({ ...sources, scope: "both", sessionDir: undefined }).find(
		(role) => role.name === name,
	);
	if (curated) {
		throw new Error(
			`Role "${name}" already exists as a ${curated.source} role at ${curated.file}. Pick another name, or edit that file directly.`,
		);
	}
	const existing = discoverRoles(sources).find((role) => role.name === name && role.source === "session");
	const written = defineSessionRole(
		sessionDir,
		{
			name,
			description: params.description,
			prompt: params.prompt,
			model: params.model,
			thinking: params.thinking,
			tools: params.tools,
			labels: params.labels,
		},
		existing,
	);
	if ("error" in written) throw new Error(written.error);
	return {
		text: `${written.created ? "Created" : "Updated"} session role "${name}" at ${written.file}. Spawn it with pi_agents action="spawn" role="${name}".`,
		details: { role: name, created: written.created },
	};
}

function deleteRoleAction(host: AgentsHost, ctx: ExtensionContext, params: AgentsToolInput): ActionResult {
	const raw = params.role ?? params.name;
	if (!raw) throw new Error('pi_agents action="delete_role" requires role.');
	const sources = roleSources(host, ctx, false);
	const gone = deleteSessionRole(sources.sessionDir ?? "", raw);
	return {
		text: gone
			? `Deleted session role "${raw}".`
			: `No session role named "${raw}". Curated roles in ${host.userRolesDir} are never deleted by this tool.`,
		details: { deleted: gone },
		ok: gone,
	};
}

export async function whereAction(host: AgentsHost): Promise<ActionResult> {
	return { text: await host.placer.describe(), details: { inside: host.placer.inside() } };
}

export async function listAction(host: AgentsHost): Promise<ActionResult> {
	if (!host.bus.started) {
		return { text: "pi-bus is not running, so children cannot be listed or verified.", details: {}, ok: false };
	}
	myChildren(host);
	pruneGoneChildren(host);
	const children = host.records.mine(host.bus.owner);
	if (children.length === 0) return { text: "No children spawned from this session.", details: { count: 0 } };
	const parts = await Promise.all(children.map((child) => describeChild(host, child)));
	return { text: parts.join("\n\n"), details: { count: children.length } };
}

function childTools(role: Role, tools: string | undefined): string[] | undefined {
	const wanted = (tools || role.tools?.join(",") || "")
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	if (wanted.length === 0) return undefined;
	for (const tool of MANDATORY_CHILD_TOOLS) if (!wanted.includes(tool)) wanted.push(tool);
	return wanted;
}

export function buildChildArgs(options: { runtime: ResolvedRuntime; role: Role; sessionFile?: string | undefined }) {
	const args: string[] = [];
	if (options.sessionFile) args.push("--session", options.sessionFile);
	if (options.runtime.model) args.push("--model", options.runtime.model);
	if (options.runtime.thinking) args.push("--thinking", options.runtime.thinking);
	if (!options.role.mcp) args.push("--no-mcp");
	return args;
}

/** A Herdr pane does not inherit the parent env. Without the agent dir, the child joins another bus. */
export function buildChildEnv(
	spawnFile: string,
	busDir: string | undefined,
	agentDir: string,
	parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = { PIMON_SPAWN_FILE: spawnFile };
	if (busDir) env["PI_BUS_DIR"] = resolve(busDir);
	if (parentEnv["PI_CODING_AGENT_DIR"]) env["PI_CODING_AGENT_DIR"] = resolve(agentDir);
	return env;
}

function resolveCwd(ctx: ExtensionContext, requested: string | undefined): string {
	const cwd = requested ? resolve(ctx.cwd, requested) : ctx.cwd;
	let directory = false;
	try {
		directory = statSync(cwd).isDirectory();
	} catch {
		// Reported below.
	}
	if (!directory) throw new Error(`cwd "${cwd}" is not an existing directory.`);
	return cwd;
}

async function waitForChild(
	host: AgentsHost,
	spawnId: string,
	spawnFile: string,
	signal: AbortSignal | undefined,
): Promise<{ peer?: PeerRecord; taken: boolean }> {
	const deadline = Date.now() + host.timing.spawnWaitMs;
	let peer: PeerRecord | undefined;
	let taken = false;
	while (true) {
		peer = host.bus.resolve(`label:spawn=${spawnId}`).find((found) => found.labels["parent"] === host.bus.owner);
		taken = !existsSync(spawnFile);
		if ((peer && taken) || Date.now() >= deadline || signal?.aborted) break;
		await sleep(host.timing.pollMs, signal);
	}
	return peer ? { peer, taken } : { taken };
}

export async function spawnAction(
	host: AgentsHost,
	ctx: ExtensionContext,
	params: AgentsToolInput,
	toolCallId: string,
	signal?: AbortSignal,
): Promise<ActionResult> {
	const bus = requireBus(host.bus);
	if (!host.placer.inside()) throw new Error(OUTSIDE_HERDR);
	if (!params.role) throw new Error('pi_agents action="spawn" requires role. Use action="roles" to list them.');
	if (!params.task) throw new Error('pi_agents action="spawn" requires task.');
	const selectedContext = resolveContextMode(params.context, params.brief);
	if ("error" in selectedContext) throw new Error(selectedContext.error);

	const parsedDepth = Number(bus.labels["depth"] ?? 0);
	const depth = Number.isFinite(parsedDepth) ? parsedDepth : 0;
	if (depth >= MAX_DEPTH) {
		throw new Error(`Refusing to spawn at depth ${depth + 1}. Delegation is capped at ${MAX_DEPTH} levels.`);
	}

	const sources = roleSources(host, ctx, params.projectRoles);
	const found = findRole(sources, params.role);
	if (!found) {
		const available =
			discoverRoles(sources)
				.map((entry) => entry.name)
				.join(", ") || "none";
		throw new Error(`Unknown role "${params.role}". Available: ${available}. Roles live in ${host.userRolesDir}.`);
	}
	const role = found.role;

	const runtime = resolveRuntime({
		model: params.model,
		thinking: params.thinking,
		roleModel: role.model,
		roleThinking: role.thinking,
		currentModel: ctx.model ? { id: ctx.model.id, provider: ctx.model.provider, name: ctx.model.name } : undefined,
		currentThinking: host.pi.getThinkingLevel(),
		available: ctx.modelRegistry
			.getAvailable()
			.map((model) => ({ id: model.id, provider: model.provider, name: model.name })),
	});
	if ("error" in runtime) throw new Error(runtime.error);

	const cwd = resolveCwd(ctx, params.cwd);
	if (selectedContext.mode === "fork" && cwd !== ctx.cwd) {
		throw new Error(`Context mode "fork" requires cwd "${ctx.cwd}"; received "${cwd}".`);
	}
	const extra = parseLabelList(params.labels);
	if (extra.invalid.length > 0)
		throw new Error(`labels need key=value pairs. Not understood: ${extra.invalid.join(", ")}`);
	const merged = { ...role.labels, ...extra.labels };
	const forbidden = Object.keys(merged).filter((key) => RESERVED_LABELS.has(key));
	if (forbidden.length > 0) {
		throw new Error(
			`These labels are set by the spawner and cannot be overridden: ${forbidden.join(", ")}. They control identity, ownership, and the delegation depth cap.`,
		);
	}

	const spawnId = randomUUID();
	const controlToken = randomUUID();
	// Reserved keys go last so nothing can shadow them.
	const labels = { ...merged, role: role.name, parent: bus.owner, spawn: spawnId, depth: String(depth + 1) };
	const tools = childTools(role, params.tools);
	const known = new Set(host.pi.getAllTools().map((tool) => tool.name));
	const unknownTools = (tools ?? []).filter((tool) => !MANDATORY_CHILD_TOOLS.includes(tool) && !known.has(tool));
	const displayName = params.name || role.name;
	const initialPrompt = buildInitialPrompt(params.task, selectedContext);

	const forkSessionFile =
		selectedContext.mode === "fork"
			? createForkSession(ctx.sessionManager.getSessionFile(), ctx.cwd, toolCallId)
			: undefined;
	const removeFork = () => {
		if (forkSessionFile) rmSync(forkSessionFile, { force: true });
	};

	let spawnFile: string;
	let closeHook: string;
	let placement: Placement;
	try {
		spawnFile = writeSpawnFile(host.paths, {
			version: 1,
			spawnId,
			role: { name: role.name, prompt: role.prompt },
			parent: { name: bus.name, owner: bus.owner },
			child: { name: params.name, labels, tools },
			controlToken,
			task: initialPrompt,
			createdAt: Date.now(),
		});
		closeHook = writeCloseHook(host.paths, spawnId);
		placement = await host.placer.place(
			{
				title: displayName,
				cwd,
				args: buildChildArgs({ runtime, role, sessionFile: forkSessionFile }),
				env: buildChildEnv(spawnFile, bus.launch.dir, host.agentDir),
				closeHook,
			},
			spawnId,
		);
	} catch (error) {
		host.records.forget(spawnId);
		removeFork();
		throw error;
	}

	const record: ChildRecord = {
		spawnId,
		name: displayName,
		role: role.name,
		task: params.task,
		cwd,
		placement,
		launchedAt: Date.now(),
		launchedBy: bus.owner,
		controlToken,
		contextMode: selectedContext.mode,
	};
	const placedMarker = placedMarkerPath(host.paths.spawn, spawnId);
	const unwind = async (stage: string, error: unknown): Promise<never> => {
		rmSync(placedMarker, { force: true });
		// Unwatch first: closing a watched child would report its exit as news.
		if (record.instanceId) bus.unwatch(record.instanceId);
		const closed = await host.placer.close(placement);
		if (closed) {
			host.records.forget(spawnId);
			removeFork();
		}
		throw new Error(
			`Could not persist ${record.name} ${stage} state: ${(error as Error).message}. ${
				closed
					? "Its pane was closed."
					: `Its ${placement.kind} pane ${placement.tabId ?? placement.handle} remains open; close it manually.`
			}`,
		);
	};
	try {
		writePrivateFile(placedMarker, "");
	} catch (error) {
		await unwind("placement", error);
	}
	try {
		host.records.save(record);
	} catch (error) {
		await unwind("child", error);
	}

	const { peer, taken } = await waitForChild(host, spawnId, spawnFile, signal);
	if (peer) {
		// Adopt the name the child claimed, so later lookups match.
		record.name = peer.name;
		record.instanceId = peer.instanceId;
		record.pid = peer.pid;
		record.pidBirth = peer.pidBirth;
		try {
			host.records.save(record);
		} catch (error) {
			await unwind("endpoint", error);
		}
		bus.watch(peer);
	}

	const delivered = Boolean(peer) && taken;
	const waitSeconds = Math.round(host.timing.spawnWaitMs / 1000);
	const runtimeNote = formatRuntime(runtime);
	const lines = [
		`Started: ${record.name} (${role.name}, ${placement.kind} ${placement.layout}).`,
		found.prefix ? `Role: "${params.role}" matched ${role.name}.` : undefined,
		runtimeNote ? `Runtime: ${runtimeNote}.` : "Runtime: default model.",
		`Context: ${selectedContext.mode}.`,
		peer ? `Bus: owner:${shortId(peer.owner)}.` : `Bus: not visible after ${waitSeconds}s.`,
		delivered
			? "Task delivered."
			: "Task unconfirmed: the child has not read its spawn file. The pane stays open for inspection.",
		unknownTools.length > 0
			? `Warning: these allowlist tools are not registered here: ${unknownTools.join(", ")}.`
			: undefined,
	];
	return {
		text: lines.filter((line) => line !== undefined).join("\n"),
		details: {
			spawnId,
			placement,
			owner: peer?.owner,
			instanceId: peer?.instanceId,
			contextMode: selectedContext.mode,
			taskDelivery: delivered ? "delivered" : "unconfirmed",
		},
		ok: delivered,
	};
}

export async function probeAction(host: AgentsHost, agent: string | undefined): Promise<ActionResult> {
	const record = resolveChild(host, agent);
	const peer = peerFor(host, record);
	const probes = peer ? await host.bus.probe(`id:${peer.instanceId}`) : [];
	const probe = probes[0];
	const { controlToken: _token, ...visible } = record;
	const line = probe
		? `  probe: ${probe.alive ? "answered" : "no answer"}${probe.rttMs !== undefined ? ` in ${probe.rttMs}ms` : ""}${probe.reason ? ` (${probe.reason})` : ""}`
		: "  probe: not on the bus";
	return { text: `${await describeChild(host, record)}\n${line}`, details: { record: visible, probe } };
}

function endpointChanged(record: ChildRecord, verb: string, changed: PeerRecord): ActionResult {
	return {
		text: `${record.name} cannot be ${verb} automatically: its endpoint changed after a child reload. Child reload is unsupported; close its ${record.placement.kind} pane manually.`,
		details: { spawnId: record.spawnId, endpointChanged: true, owner: changed.owner },
		ok: false,
	};
}

export async function closeAction(host: AgentsHost, agent: string | undefined): Promise<ActionResult> {
	const bus = requireBus(host.bus);
	const record = resolveChild(host, agent);
	const changed = endpointChangedPeer(host, record);
	if (changed) return endpointChanged(record, "closed", changed);
	const peer = peerFor(host, record);
	if (!peer) {
		const paneClosed = await host.placer.close(record.placement);
		const managed = record.placement.kind === "herdr";
		const alive = await host.placer.alive(record.placement);
		const gone = paneClosed || (alive !== true && pidGone(record.pid, record.pidBirth));
		if (gone) forgetTracked(host, record);
		const outcome = paneClosed
			? "Closed its pane."
			: gone
				? "It was already gone; removed its stale record."
				: managed
					? "Could not close its pane; the record stays for manual resolution."
					: `Its ${record.placement.kind} pane is not managed; the record stays for manual resolution.`;
		return {
			text: `${record.name} is not on the bus. ${outcome}`,
			details: { spawnId: record.spawnId, closed: gone, paneClosed },
			ok: gone,
		};
	}
	// Marked first: an idle child can stop before the delivery result returns. A crash still wakes.
	const cancelExpectation = bus.expectExit(peer.owner, ["left"]);
	let result: SendResult;
	try {
		result = await bus.sendTo(peer, {
			body: "shutdown",
			subject: "shutdown",
			kind: "control",
			wake: "now",
			priority: "urgent",
			data: { token: record.controlToken },
		});
	} catch (error) {
		cancelExpectation();
		throw error;
	}
	const accepted = result.delivered.length > 0;
	if (!accepted) cancelExpectation();
	return {
		text: accepted
			? `Asked ${record.name} to finish and exit. It shuts down once it is idle, so a final report may still arrive. Use action="kill" if it does not stop.`
			: `Could not deliver the close request to ${record.name}: ${[...result.unknown, ...result.failed].map((entry) => entry.reason).join(", ") || "no live target"}.`,
		details: { delivered: accepted },
		ok: accepted,
	};
}

/** SIGTERM, then SIGKILL after a grace period. A child that survives stays tracked. */
async function stopChild(
	host: AgentsHost,
	record: ChildRecord,
	peer: PeerRecord | undefined,
): Promise<{ state: "dead" | "alive" | "unknown"; notes: string[] }> {
	const notes: string[] = [];
	const pid = peer?.pid ?? record.pid;
	const birth = record.pidBirth ?? peer?.pidBirth;
	if (!pid) {
		notes.push("no pid was recorded: process state unknown");
		return { state: "unknown", notes };
	}
	if (!pidLive(pid, birth)) {
		notes.push(`pid ${pid} was already gone`);
		return { state: "dead", notes };
	}
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		if (!pidLive(pid, birth)) break;
		try {
			process.kill(pid, signal);
			notes.push(`sent ${signal} to pid ${pid}`);
		} catch (error) {
			notes.push(`${signal} failed: ${(error as Error).message}`);
			break;
		}
		const deadline = Date.now() + host.timing.killGraceMs;
		while (Date.now() < deadline && pidLive(pid, birth)) await sleep(200);
	}
	const dead = !pidLive(pid, birth);
	notes.push(dead ? "process is confirmed gone" : "process is still running");
	return { state: dead ? "dead" : "alive", notes };
}

export async function killAction(
	host: AgentsHost,
	agent: string | undefined,
	force: boolean | undefined,
): Promise<ActionResult> {
	requireBus(host.bus);
	const record = resolveChild(host, agent);
	const changed = endpointChangedPeer(host, record);
	if (changed) return endpointChanged(record, "killed", changed);
	const peer = peerFor(host, record);
	// Marked first: SIGTERM makes the child stop its endpoint during the grace wait.
	const cancelExpectation = peer ? host.bus.expectExit(peer.owner) : undefined;
	const { state, notes } = await stopChild(host, record, peer);
	if (state !== "dead") cancelExpectation?.();
	let paneClosed = false;
	if (force !== false) {
		if (record.placement.kind !== "herdr") notes.push(`its ${String(record.placement.kind)} pane is not managed`);
		else {
			paneClosed = await host.placer.close(record.placement);
			notes.push(paneClosed ? "closed the pane" : "no pane left to close");
		}
	}
	// Forgetting a live child silently ends its exit notices and its ownership record.
	const forget = state === "dead" || (state === "unknown" && paneClosed);
	if (forget) forgetTracked(host, record);
	const text =
		state === "dead"
			? `Killed ${record.name}: ${notes.join(", ")}.`
			: state === "unknown"
				? `${record.name}: ${notes.join(", ")}. ${forget ? "Its record is removed." : "It is still tracked."}`
				: `${record.name} survived SIGTERM and SIGKILL: ${notes.join(", ")}. It is still tracked; inspect its pane.`;
	return { text, details: { notes, state }, ok: state === "dead" };
}

export async function focusAction(host: AgentsHost, agent: string | undefined): Promise<ActionResult> {
	const record = resolveChild(host, agent);
	const ok = await host.placer.focus(record.placement);
	return {
		text: ok
			? `Focused ${record.name} in its ${record.placement.kind} pane.`
			: record.placement.kind === "herdr"
				? `Could not focus ${record.name}; its pane may be gone.`
				: `Could not focus ${record.name}; its ${String(record.placement.kind)} pane is not managed.`,
		details: { ok },
		ok,
	};
}

export function pruneAction(host: AgentsHost): ActionResult {
	const removed = pruneGoneChildren(host, true);
	return { text: removed.length === 0 ? "Nothing to prune." : `Forgot: ${removed.join(", ")}`, details: { removed } };
}

export async function runToolAction(
	host: AgentsHost,
	ctx: ExtensionContext,
	params: AgentsToolInput,
	toolCallId: string,
	signal?: AbortSignal,
): Promise<ActionResult> {
	switch (params.action) {
		case "roles":
			return rolesAction(host, ctx, params);
		case "define_role":
			return defineRoleAction(host, ctx, params);
		case "delete_role":
			return deleteRoleAction(host, ctx, params);
		case "where":
			return whereAction(host);
		case "list":
			return listAction(host);
		case "spawn":
			return spawnAction(host, ctx, params, toolCallId, signal);
		case "probe":
			return probeAction(host, params.agent);
		case "close":
			return closeAction(host, params.agent);
		case "kill":
			return killAction(host, params.agent, params.force);
		case "focus":
			return focusAction(host, params.agent);
		default:
			throw new Error(`Unknown pi_agents action: ${String(params.action)}`);
	}
}

export function pruneFiles(paths: AgentPaths, keepRoleKey: string): void {
	pruneOld(paths.roles, keepRoleKey);
	// pi loads the close hook again at each session replacement in the child.
	const recorded = new Set(new ChildRecords(paths).all().map((record) => record.spawnId));
	pruneOld(paths.prompts, undefined, (entry) => recorded.has(entry.replace(/-herdr-close\.ts$/, "")));
	pruneOld(paths.spawn);
}
