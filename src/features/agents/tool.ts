import { randomUUID } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { StringEnum, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PresenceEvent } from "../../hub/protocol.ts";
import { HubHttpError, NO_ANSWER } from "../bus/hub/client.ts";
import { defaultName } from "../bus/identity.ts";
import type { AgentInfo, BusService } from "../bus/index.ts";
import { shortId } from "../bus/protocol.ts";
import { DAY_MS, defineSessionRole, deleteSessionRole, pruneOld, sessionKey, sessionRolesDir } from "./adhoc.ts";
import { buildInitialPrompt, CONTEXT_MODES, createForkSession, resolveContextMode } from "./context.ts";
import { OUTSIDE_HERDR, type Placement, type Placer, writeCloseHook } from "./placement.ts";
import { type ChildRecord, ChildRecords } from "./records.ts";
import { discoverRoles, findRole, formatRoles, parseLabelList, type Role, type RoleSources } from "./roles.ts";
import { formatRuntime, type ResolvedRuntime, resolveRuntime, THINKING_LEVELS } from "./runtime.ts";
import { pidGone, pidLive, sameProcess } from "./pid.ts";
import { type AgentPaths, readPidFile, writeSpawnFile } from "./spawn-file.ts";

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
	timing: { spawnWaitMs: number; killGraceMs: number };
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

function requireHub(bus: BusService): BusService {
	const reason = bus.unavailable();
	if (reason) throw new Error(`${reason} Child ownership cannot be verified, so stored child records are not used.`);
	return bus;
}

function roleSources(host: AgentsHost, ctx: ExtensionContext, projectRoles: boolean | undefined): RoleSources {
	const key = sessionKey(ctx.sessionManager.getSessionId());
	host.pruneOnce(key);
	return {
		userDir: host.userRolesDir,
		cwd: ctx.cwd,
		scope: projectRoles ? "both" : "user",
		sessionDir: sessionRolesDir(key, host.paths.roles),
	};
}

/** Hub rows of this session's children, online or offline, by session id. */
export async function childAgents(host: AgentsHost): Promise<Map<string, AgentInfo>> {
	const self = host.bus.id;
	const agents = await host.bus.agents(true);
	return new Map(agents.filter((agent) => agent.parent === self).map((agent) => [agent.id, agent]));
}

function myChildren(host: AgentsHost): ChildRecord[] {
	return host.records.mine(host.bus.id);
}

function resolveChild(host: AgentsHost, reference: string | undefined): ChildRecord {
	requireHub(host.bus);
	const children = myChildren(host);
	if (children.length === 0) throw new Error("No children have been spawned from this session.");
	if (!reference) {
		if (children.length === 1 && children[0]) return children[0];
		throw new Error(`Name the child. Current children: ${children.map((child) => child.name).join(", ")}`);
	}
	const wanted = reference.replace(/^id:/, "").toLowerCase();
	const hex = wanted.replace(/-/g, "");
	const matches = children.filter(
		(child) =>
			child.name === reference ||
			child.name.toLowerCase().startsWith(wanted) ||
			child.role.toLowerCase() === wanted ||
			child.spawnId.startsWith(wanted) ||
			(hex.length >= 4 && child.spawnId.replace(/-/g, "").startsWith(hex)),
	);
	if (matches.length === 1 && matches[0]) return matches[0];
	if (matches.length === 0) {
		throw new Error(
			`No child matches "${reference}". Children: ${children.map((child) => `${child.name} (role ${child.role})`).join(", ")}`,
		);
	}
	throw new Error(
		`"${reference}" matches ${matches.length} children: ${matches.map((child) => child.name).join(", ")}. Use the exact name or the id from action="list".`,
	);
}

type ChildStatus = "online" | "offline" | "starting" | "never-started";

function childStatus(record: ChildRecord, agent: AgentInfo | undefined): ChildStatus {
	if (agent?.online) return "online";
	// The parent makes the hub row before the child starts, so only a link sets lastSeenAt.
	if (agent?.lastSeenAt) return "offline";
	return Date.now() - record.launchedAt < STARTING_MS ? "starting" : "never-started";
}

/** A child that is starting or online. */
export function isActiveChild(record: ChildRecord, agent: AgentInfo | undefined): boolean {
	const state = childStatus(record, agent);
	return state === "online" || state === "starting";
}

function paneText(placement: Placement, alive: boolean | undefined): string {
	if (alive === undefined) return `${placement.kind} ${placement.layout}, pane not managed`;
	return alive ? `${placement.kind} ${placement.layout}` : `${placement.kind} ${placement.layout}, pane is gone`;
}

function statusText(agent: AgentInfo | undefined): string | undefined {
	if (!agent?.status.text) return undefined;
	const at = agent.status.at ? ` (${ago(Date.parse(agent.status.at))} ago)` : "";
	return `"${agent.status.text}"${at}`;
}

async function describeChild(host: AgentsHost, record: ChildRecord, agent: AgentInfo | undefined): Promise<string> {
	const alive = await host.placer.alive(record.placement);
	const state = childStatus(record, agent);
	const status =
		state === "online"
			? agent?.state || "idle"
			: state === "offline"
				? `offline${alive ? ", its pane is still open" : ""}`
				: state === "starting"
					? "starting, not on the bus yet"
					: "never joined the bus, check its pane for an error";
	const activity = state === "online" ? agent?.activity : undefined;
	const said = statusText(agent);
	return [
		`${record.name} (${record.role})`,
		`  context: ${record.contextMode || "isolated"}`,
		`  status: ${status}${activity ? `, doing "${truncate(activity, 40)}"` : ""}`,
		said ? `  says: ${said}` : undefined,
		`  address: id:${shortId(record.spawnId)}`,
		`  pane: ${paneText(record.placement, alive)}`,
		`  age: ${ago(record.launchedAt)}`,
		`  cwd: ${record.cwd}`,
		`  task: ${truncate(record.task, 100)}`,
	]
		.filter((line) => line !== undefined)
		.join("\n");
}

function childPid(host: AgentsHost, record: ChildRecord): { pid?: number | undefined; birth?: string | undefined } {
	return readPidFile(host.paths, record.spawnId) ?? {};
}

/** Forget records whose child is offline and whose process is confirmed gone. */
function pruneGoneChildren(
	host: AgentsHost,
	agents: ReadonlyMap<string, AgentInfo>,
	includeNeverStarted = false,
): string[] {
	const removed: string[] = [];
	for (const child of myChildren(host)) {
		const state = childStatus(child, agents.get(child.spawnId));
		if (state !== "offline" && !(includeNeverStarted && state === "never-started")) continue;
		const { pid, birth } = childPid(host, child);
		if (!pidGone(pid, birth)) continue;
		host.records.forget(child.spawnId);
		removed.push(child.name);
	}
	return removed;
}

/** A child that went offline: close its pane when its process is gone too. */
export async function cleanupGoneChild(host: AgentsHost, event: PresenceEvent): Promise<void> {
	if (event.online || !host.bus.started) return;
	const record = myChildren(host).find((child) => child.spawnId === event.agent);
	if (!record) return;
	const { pid, birth } = childPid(host, record);
	// Offline is not a stopped process: /new or /resume in the child takes the old session offline first.
	if (pid && sameProcess(pid, birth)) return;
	const closed = await host.placer.close(record.placement);
	const alive = await host.placer.alive(record.placement);
	if (closed || alive === false || pidGone(pid, birth)) host.records.forget(record.spawnId);
}

/** The temp fork file is needed only until the child read it. */
export function childOnline(host: AgentsHost, event: PresenceEvent): void {
	if (!event.online || !host.bus.started) return;
	const record = myChildren(host).find((child) => child.spawnId === event.agent);
	if (!record?.forkFile) return;
	rmSync(record.forkFile, { force: true });
	record.forkFile = undefined;
	try {
		host.records.save(record);
	} catch {
		// The record keeps the path; a later save drops it.
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
	const reason = host.bus.unavailable();
	if (reason) return { text: `${reason} Children cannot be listed or verified.`, details: {}, ok: false };
	const agents = await childAgents(host).catch((error: unknown) => {
		throw new Error(host.bus.errorText(error), { cause: error });
	});
	pruneGoneChildren(host, agents);
	const children = myChildren(host);
	if (children.length === 0) return { text: "No children spawned from this session.", details: { count: 0 } };
	const parts = await Promise.all(children.map((child) => describeChild(host, child, agents.get(child.spawnId))));
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

export function buildChildArgs(options: {
	runtime: ResolvedRuntime;
	role: Role;
	sessionId: string;
	forkFile?: string | undefined;
}) {
	const args: string[] = [];
	if (options.forkFile) args.push("--fork", options.forkFile);
	args.push("--session-id", options.sessionId);
	if (options.runtime.model) args.push("--model", options.runtime.model);
	if (options.runtime.thinking) args.push("--thinking", options.runtime.thinking);
	if (!options.role.mcp) args.push("--no-mcp");
	return args;
}

/** A Herdr pane does not inherit the parent env. Without the agent dir, the child uses another hub config. */
export function buildChildEnv(
	agentDir: string,
	parentEnv: NodeJS.ProcessEnv = process.env,
	tempDir: string = tmpdir(),
): Record<string, string> {
	const env: Record<string, string> = {};
	if (parentEnv["PI_CODING_AGENT_DIR"]) env["PI_CODING_AGENT_DIR"] = resolve(agentDir);
	// A pane gets the env of the Herdr server, not of the parent. The child finds its spawn file under this dir.
	env["TMPDIR"] = tempDir;
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

function firstLine(text: string, max: number): string {
	const line = text.split("\n").find((entry) => entry.trim()) ?? "";
	return truncate(line, max);
}

/**
 * Resolves true once the child set its first task to working. The child can start the task before the send
 * returns its task id, so updates before `known` are kept.
 */
function waitForWorking(
	host: AgentsHost,
	signal: AbortSignal | undefined,
): { done: Promise<boolean>; stop: () => void; known: (taskId: string) => void } {
	let stop = () => {};
	let taskId: string | undefined;
	const started = new Set<string>();
	let known = (id: string) => {
		taskId = id;
	};
	const done = new Promise<boolean>((resolveDone) => {
		const timer = setTimeout(() => finish(false), host.timing.spawnWaitMs);
		const off = host.bus.onUpdate((update) => {
			if (update.state === "submitted") return;
			if (update.taskId === taskId) finish(true);
			else if (taskId === undefined) started.add(update.taskId);
		});
		known = (id) => {
			taskId = id;
			if (started.has(id)) finish(true);
		};
		const onAbort = () => finish(false);
		signal?.addEventListener("abort", onAbort, { once: true });
		function finish(value: boolean) {
			clearTimeout(timer);
			off();
			signal?.removeEventListener("abort", onAbort);
			resolveDone(value);
		}
		stop = () => finish(false);
	});
	return { done, stop: () => stop(), known: (id) => known(id) };
}

export async function spawnAction(
	host: AgentsHost,
	ctx: ExtensionContext,
	params: AgentsToolInput,
	toolCallId: string,
	signal?: AbortSignal,
): Promise<ActionResult> {
	const bus = requireHub(host.bus);
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

	const spawnId = uuidv7();
	const messageId = randomUUID();
	// Depth goes last so nothing can shadow it.
	const labels = { ...merged, depth: String(depth + 1) };
	const tools = childTools(role, params.tools);
	const known = new Set(host.pi.getAllTools().map((tool) => tool.name));
	const unknownTools = (tools ?? []).filter((tool) => !MANDATORY_CHILD_TOOLS.includes(tool) && !known.has(tool));
	const displayName = params.name || role.name;
	const hubName = defaultName({ name: params.name, role: role.name }, spawnId);
	const initialPrompt = buildInitialPrompt(params.task, selectedContext);

	const forkFile =
		selectedContext.mode === "fork"
			? createForkSession(ctx.sessionManager.getSessionFile(), ctx.cwd, toolCallId)
			: undefined;
	const removeFork = () => {
		if (forkFile) rmSync(forkFile, { force: true });
	};

	let closeHook: string;
	let placement: Placement;
	try {
		writeSpawnFile(host.paths, {
			version: 2,
			spawnId,
			role: { name: role.name, prompt: role.prompt },
			parent: { name: bus.name, id: bus.id },
			child: { name: params.name, labels, tools },
			firstTask: { messageId },
			createdAt: Date.now(),
		});
		await bus.addChild({ id: spawnId, name: hubName, role: role.name, labels, cwd });
		closeHook = writeCloseHook(host.paths, spawnId);
		placement = await host.placer.place(
			{
				title: displayName,
				cwd,
				args: buildChildArgs({ runtime, role, sessionId: spawnId, forkFile }),
				env: buildChildEnv(host.agentDir),
				closeHook,
			},
			spawnId,
		);
	} catch (error) {
		host.records.forget(spawnId);
		removeFork();
		throw new Error(bus.errorText(error), { cause: error });
	}

	const record: ChildRecord = {
		spawnId,
		name: hubName,
		role: role.name,
		task: params.task,
		cwd,
		placement,
		launchedAt: Date.now(),
		launchedBy: bus.id,
		contextMode: selectedContext.mode,
		forkFile,
	};
	try {
		host.records.save(record);
	} catch (error) {
		const closed = await host.placer.close(placement);
		if (closed) {
			host.records.forget(spawnId);
			removeFork();
		}
		throw new Error(
			`Could not persist ${record.name} child state: ${(error as Error).message}. ${
				closed
					? "Its pane was closed."
					: `Its ${placement.kind} pane ${placement.tabId ?? placement.handle} remains open; close it manually.`
			}`,
		);
	}

	let taskId: string | undefined;
	const working = waitForWorking(host, signal);
	let delivery: "delivered" | "queued" | "unconfirmed" | "failed";
	let failure: string | undefined;
	let unconfirmedWhy: string | undefined;
	try {
		const sent = await bus.send([childStub(spawnId, hubName)], {
			messageId,
			body: initialPrompt,
			kind: "task",
			wake: "now",
			subject: firstLine(params.task, 80),
		});
		const line = sent.lines[0];
		delivery = line?.state ?? "failed";
		if (line?.state === "failed") failure = line.reason;
		if (line?.state === "unconfirmed") unconfirmedWhy = line.reason;
		taskId = line?.taskId;
	} catch (error) {
		delivery = "failed";
		failure = bus.errorText(error);
	}
	if (taskId) {
		working.known(taskId);
		record.taskId = taskId;
		try {
			host.records.save(record);
		} catch {
			// The task id is only a hint for later views.
		}
	}
	const started = delivery === "failed" ? (working.stop(), false) : await working.done;
	if (started) childOnline(host, { agent: spawnId, name: hubName, online: true, relation: "child" });

	const waitSeconds = Math.round(host.timing.spawnWaitMs / 1000);
	const runtimeNote = formatRuntime(runtime);
	const taskLine = started
		? "Task delivered."
		: delivery === "failed"
			? `Task not sent: ${failure ?? "unknown error"}. The pane stays open for inspection.`
			: delivery === "delivered"
				? `Task delivered; the child has not started it after ${waitSeconds}s.`
				: delivery === "unconfirmed"
					? `Task unconfirmed: ${
							unconfirmedWhy === NO_ANSWER
								? "the hub did not answer"
								: (unconfirmedWhy ?? "the child did not confirm it yet")
						}. Do not resend; check the child with action="probe".`
					: "Task queued: the hub delivers it when the child links.";
	// A child that acked the task was online. A failed send ended the wait before it began.
	const linked = started || delivery === "delivered" || delivery === "failed";
	const lines = [
		`Started: ${record.name} (${role.name}, ${placement.kind} ${placement.layout}).`,
		found.prefix ? `Role: "${params.role}" matched ${role.name}.` : undefined,
		runtimeNote ? `Runtime: ${runtimeNote}.` : "Runtime: default model.",
		`Context: ${selectedContext.mode}.`,
		linked ? `Bus: id:${shortId(spawnId)}.` : `Bus: id:${shortId(spawnId)}, not online after ${waitSeconds}s.`,
		taskLine,
		unknownTools.length > 0
			? `Warning: these allowlist tools are not registered here: ${unknownTools.join(", ")}.`
			: undefined,
	];
	return {
		text: lines.filter((line) => line !== undefined).join("\n"),
		details: {
			spawnId,
			placement,
			contextMode: selectedContext.mode,
			taskDelivery: started ? "delivered" : delivery,
		},
		ok: started,
	};
}

function childStub(id: string, name: string): AgentInfo {
	return {
		id,
		name,
		kind: "pi",
		host: null,
		cwd: null,
		role: null,
		labels: {},
		parent: null,
		topics: [],
		online: false,
		state: "idle",
		activity: null,
		status: { text: "", at: null },
		lastSeenAt: null,
	};
}

export async function probeAction(host: AgentsHost, agent: string | undefined): Promise<ActionResult> {
	const record = resolveChild(host, agent);
	let row: AgentInfo | undefined;
	try {
		row = await host.bus.agent(record.spawnId);
	} catch (error) {
		throw new Error(host.bus.errorText(error), { cause: error });
	}
	const line = row
		? `  hub: ${row.online ? "online" : "offline"}${row.lastSeenAt ? `, seen ${ago(Date.parse(row.lastSeenAt))} ago` : ", never linked"}`
		: "  hub: no row for this child";
	return {
		text: `${await describeChild(host, record, row)}\n${line}`,
		details: { record, online: row?.online ?? false },
	};
}

async function closePaneOnly(host: AgentsHost, record: ChildRecord): Promise<ActionResult> {
	const paneClosed = await host.placer.close(record.placement);
	const managed = record.placement.kind === "herdr";
	const alive = await host.placer.alive(record.placement);
	const { pid, birth } = childPid(host, record);
	const gone = paneClosed || (alive !== true && pidGone(pid, birth));
	if (gone) host.records.forget(record.spawnId);
	const outcome = paneClosed
		? "Closed its pane."
		: gone
			? "It was already gone; removed its stale record."
			: managed
				? "Could not close its pane; the record stays for manual resolution."
				: `Its ${record.placement.kind} pane is not managed; the record stays for manual resolution.`;
	return {
		text: `${record.name} is not online. ${outcome}`,
		details: { spawnId: record.spawnId, closed: gone, paneClosed },
		ok: gone,
	};
}

export async function closeAction(host: AgentsHost, agent: string | undefined): Promise<ActionResult> {
	const bus = requireHub(host.bus);
	const record = resolveChild(host, agent);
	let row: AgentInfo | undefined;
	try {
		row = await bus.agent(record.spawnId);
	} catch (error) {
		throw new Error(bus.errorText(error), { cause: error });
	}
	if (!row?.online) return closePaneOnly(host, record);
	// Marked first: an idle child can stop before the answer returns. Open work still wakes.
	const cancelExpectation = bus.expectOffline(record.spawnId);
	try {
		await bus.close(record.spawnId);
	} catch (error) {
		cancelExpectation();
		if (error instanceof HubHttpError && error.status === 409) return closePaneOnly(host, record);
		if (error instanceof HubHttpError && error.status === 403) {
			return {
				text: `Could not close ${record.name}: the hub does not list this session as its parent.`,
				details: { delivered: false },
				ok: false,
			};
		}
		return {
			text: `Could not deliver the close request to ${record.name}: ${bus.errorText(error)}`,
			details: { delivered: false },
			ok: false,
		};
	}
	return {
		text: `Asked ${record.name} to finish and exit. It shuts down once it is idle, so a final report may still arrive. Use action="kill" if it does not stop.`,
		details: { delivered: true },
		ok: true,
	};
}

/** SIGTERM, then SIGKILL after a grace period. A child that survives stays tracked. */
async function stopChild(
	host: AgentsHost,
	record: ChildRecord,
): Promise<{ state: "dead" | "alive" | "unknown"; notes: string[] }> {
	const notes: string[] = [];
	const { pid, birth } = childPid(host, record);
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
	requireHub(host.bus);
	const record = resolveChild(host, agent);
	// Marked first: SIGTERM takes the child offline during the grace wait.
	const cancelExpectation = host.bus.expectOffline(record.spawnId);
	const { state, notes } = await stopChild(host, record);
	if (state !== "dead") cancelExpectation();
	let paneClosed = false;
	if (force !== false) {
		if (record.placement.kind !== "herdr") notes.push(`its ${String(record.placement.kind)} pane is not managed`);
		else {
			paneClosed = await host.placer.close(record.placement);
			notes.push(paneClosed ? "closed the pane" : "no pane left to close");
		}
	}
	// Forgetting a live child silently ends its offline notices and its ownership record.
	const forget = state === "dead" || (state === "unknown" && paneClosed);
	if (forget) host.records.forget(record.spawnId);
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

export async function pruneAction(host: AgentsHost): Promise<ActionResult> {
	requireHub(host.bus);
	const agents = await childAgents(host).catch((error: unknown) => {
		throw new Error(host.bus.errorText(error), { cause: error });
	});
	const removed = pruneGoneChildren(host, agents, true);
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
	const records = new ChildRecords(paths);
	// pimon 1.x keyed records on a process owner id and stored a control token. No session id matches them.
	// A 1.x parent can still run on this host during an upgrade, so its records get a day.
	const cutoff = Date.now() - DAY_MS;
	for (const record of records.all()) {
		if ("controlToken" in record && record.launchedAt < cutoff) records.forget(record.spawnId);
	}
	// pi loads the close hook again at each session replacement in the child.
	const recorded = new Set(records.all().map((record) => record.spawnId));
	pruneOld(paths.prompts, undefined, (entry) => recorded.has(entry.replace(/-herdr-close\.ts$/, "")));
	// A child's pid file lives as long as the child. Unread spawn data of a never started child goes after a day.
	pruneOld(paths.spawn, undefined, (entry) => entry.endsWith(".pid") && recorded.has(entry.slice(0, -4)));
}
