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

/** Everything a child needs at start. The file is the only carrier of the task and the control token. */
export interface SpawnFile {
	version: 1;
	spawnId: string;
	role: { name: string; prompt: string };
	parent: { name: string; owner: string };
	child: { name?: string | undefined; labels: Record<string, string>; tools?: string[] | undefined };
	controlToken: string;
	task: string;
	createdAt: number;
}

/** The session entry keeps what a resume needs. The task and the token never reach the session file. */
export type SpawnEntry = Omit<SpawnFile, "controlToken" | "task">;

export interface AgentPaths {
	root: string;
	state: string;
	spawn: string;
	prompts: string;
	roles: string;
}

/** Task text and tokens live here, so the root is private to this user. */
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

/** Exists once the parent's placement returned, so the child's first run cannot fail the placement. */
export function placedMarkerPath(spawnDir: string, spawnId: string): string {
	return join(spawnDir, `${spawnId}.placed`);
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

function parseSpawnFile(raw: unknown): SpawnFile | string {
	if (typeof raw !== "object" || raw === null) return "not a JSON object";
	const data = raw as Partial<Record<keyof SpawnFile, unknown>>;
	if (data.version !== 1) return `unsupported version ${JSON.stringify(data.version)}`;
	const role = data.role as { name?: unknown; prompt?: unknown } | undefined;
	const parent = data.parent as { name?: unknown; owner?: unknown } | undefined;
	const child = data.child as { name?: unknown; labels?: unknown; tools?: unknown } | undefined;
	if (!isString(data.spawnId)) return "spawnId is missing";
	if (!role || !isString(role.name) || typeof role.prompt !== "string") return "role is missing";
	if (!parent || !isString(parent.name) || !isString(parent.owner)) return "parent is missing";
	if (!child || !isRecordOfStrings(child.labels)) return "child labels are missing";
	if (child.name !== undefined && typeof child.name !== "string") return "child name is not a string";
	if (
		child.tools !== undefined &&
		!(Array.isArray(child.tools) && child.tools.every((tool) => typeof tool === "string"))
	)
		return "child tools are not a list of strings";
	if (!isString(data.controlToken)) return "controlToken is missing";
	if (typeof data.task !== "string") return "task is missing";
	return {
		version: 1,
		spawnId: data.spawnId,
		role: { name: role.name, prompt: role.prompt },
		parent: { name: parent.name, owner: parent.owner },
		child: {
			name: child.name || undefined,
			labels: { ...child.labels },
			tools: child.tools as string[] | undefined,
		},
		controlToken: data.controlToken,
		task: data.task,
		createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
	};
}

function removeQuietly(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone. The data is in memory now.
	}
}

/** Reads and deletes the file. The file is deleted even when it is bad, so a token never stays on disk. */
export function takeSpawnFile(path: string): { data: SpawnFile } | { error: string } {
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
	const { controlToken: _token, task: _task, ...entry } = data;
	return entry;
}

export function parseSpawnEntry(raw: unknown): SpawnEntry | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const data = parseSpawnFile({ ...(raw as object), controlToken: "-", task: "" });
	return typeof data === "string" ? undefined : spawnEntry(data);
}
