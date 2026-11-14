import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	type Stats,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export const SPAWN_ENTRY = "pimon-spawn";

/** What a child needs at start. Keyed by the child's session id. The task itself waits in the hub mailbox. */
export interface SpawnFile {
	version: 2;
	/** The child's session id. */
	spawnId: string;
	role: { name: string; prompt: string };
	/** `id` is the parent's session id. */
	parent: { name: string; id: string };
	child: { name?: string | undefined; labels: Record<string, string>; tools?: string[] | undefined };
	firstTask: { messageId: string };
	createdAt: number;
}

/** The session entry keeps what a resume needs. */
export type SpawnEntry = Omit<SpawnFile, "firstTask">;

export interface AgentPaths {
	root: string;
	state: string;
	spawn: string;
	prompts: string;
	roles: string;
}

/** Spawn data and child pids live here, so the root is private to this user. */
export function agentPaths(root = join(tmpdir(), `pi-agents-${userInfo().uid}`)): AgentPaths {
	return {
		root,
		state: join(root, "state"),
		spawn: join(root, "spawn"),
		prompts: join(root, "prompts"),
		roles: join(root, "roles"),
	};
}

function isPrivate(stats: Stats): boolean {
	return stats.uid === process.getuid?.() && (stats.mode & 0o077) === 0;
}

/** `mkdir` keeps an existing dir as it is. The root has a guessable name in shared /tmp, so another user may own it. */
function assertPrivateDir(dir: string): void {
	const stats = lstatSync(dir);
	if (stats.isSymbolicLink() || !stats.isDirectory() || !isPrivate(stats)) {
		throw new Error(`${dir} is not private: it must be a directory, not a symlink, owned by this user, with mode 0700`);
	}
}

export function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	assertPrivateDir(dir);
}

export function writePrivateFile(path: string, content: string): void {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

export function spawnFilePath(paths: AgentPaths, spawnId: string): string {
	return join(paths.spawn, `${spawnId}.json`);
}

export function pidFilePath(paths: AgentPaths, spawnId: string): string {
	return join(paths.spawn, `${spawnId}.pid`);
}

export function writeSpawnFile(paths: AgentPaths, data: SpawnFile): string {
	ensurePrivateDir(paths.root);
	ensurePrivateDir(paths.spawn);
	const path = spawnFilePath(paths, data.spawnId);
	writePrivateFile(path, `${JSON.stringify(data)}\n`);
	return path;
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((item) => typeof item === "string")
	);
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** Version 1 entries name the parent by its process owner id. */
function parseEntryFields(raw: unknown): SpawnEntry | string {
	if (typeof raw !== "object" || raw === null) return "not a JSON object";
	const data = raw as Partial<Record<keyof SpawnFile, unknown>>;
	if (data.version !== 1 && data.version !== 2) return `unsupported version ${JSON.stringify(data.version)}`;
	const role = data.role as { name?: unknown; prompt?: unknown } | undefined;
	const parent = data.parent as { name?: unknown; id?: unknown; owner?: unknown } | undefined;
	const child = data.child as { name?: unknown; labels?: unknown; tools?: unknown } | undefined;
	if (!isString(data.spawnId)) return "spawnId is missing";
	if (!role || !isString(role.name) || typeof role.prompt !== "string") return "role is missing";
	const parentId = parent?.id ?? parent?.owner;
	if (!parent || !isString(parent.name) || !isString(parentId)) return "parent is missing";
	if (!child || !isRecordOfStrings(child.labels)) return "child labels are missing";
	if (child.name !== undefined && typeof child.name !== "string") return "child name is not a string";
	if (
		child.tools !== undefined &&
		!(Array.isArray(child.tools) && child.tools.every((tool) => typeof tool === "string"))
	)
		return "child tools are not a list of strings";
	return {
		version: 2,
		spawnId: data.spawnId,
		role: { name: role.name, prompt: role.prompt },
		parent: { name: parent.name, id: parentId },
		child: {
			name: child.name || undefined,
			labels: { ...child.labels },
			tools: child.tools as string[] | undefined,
		},
		createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
	};
}

function parseSpawnFile(raw: unknown): SpawnFile | string {
	const entry = parseEntryFields(raw);
	if (typeof entry === "string") return entry;
	if ((raw as { version?: unknown }).version !== 2) return "unsupported version 1";
	const firstTask = (raw as { firstTask?: { messageId?: unknown } }).firstTask;
	if (!firstTask || !isString(firstTask.messageId)) return "firstTask is missing";
	return { ...entry, version: 2, firstTask: { messageId: firstTask.messageId } };
}

function removeQuietly(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone. The data is in memory now.
	}
}

/** Reads and deletes the file. Undefined when there is no file. A bad file is deleted too. */
export function takeSpawnFile(path: string): { data: SpawnFile } | { error: string } | undefined {
	let text: string;
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const owned = isPrivate(fstatSync(fd));
		text = owned ? readFileSync(fd, "utf8") : "";
		if (!owned) {
			removeQuietly(path);
			return { error: `spawn file ${path} is not private: it must be owned by this user, with mode 0600` };
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return { error: `cannot read spawn file ${path}: ${(error as Error).message}` };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	removeQuietly(path);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { error: `spawn file ${path} is not valid JSON` };
	}
	const data = parseSpawnFile(raw);
	return typeof data === "string" ? { error: `spawn file ${path}: ${data}` } : { data };
}

export function spawnEntry(data: SpawnFile): SpawnEntry {
	const { firstTask: _task, ...entry } = data;
	return entry;
}

export function parseSpawnEntry(raw: unknown): SpawnEntry | undefined {
	const entry = parseEntryFields(raw);
	return typeof entry === "string" ? undefined : entry;
}

export interface PidData {
	pid: number;
	birth?: string | undefined;
}

/** The parent reads it to signal the child. Only the same host can use it. */
export function writePidFile(paths: AgentPaths, spawnId: string, data: PidData): void {
	ensurePrivateDir(paths.root);
	ensurePrivateDir(paths.spawn);
	writePrivateFile(pidFilePath(paths, spawnId), `${JSON.stringify(data)}\n`);
}

export function readPidFile(paths: AgentPaths, spawnId: string): PidData | undefined {
	try {
		const raw = JSON.parse(readFileSync(pidFilePath(paths, spawnId), "utf8")) as Partial<PidData>;
		if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid)) return undefined;
		return { pid: raw.pid, birth: typeof raw.birth === "string" ? raw.birth : undefined };
	} catch {
		return undefined;
	}
}
