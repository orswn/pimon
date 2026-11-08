// Presence registry: peer files, liveness, reaping, names.
// A live pid's files are never deleted. pid recycling is detected with the OS process start time.
// No process mutates a file owned by another process. Names come from the live peer set, not a lock file.

import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import type { PeerRecord } from "./protocol.ts";
import { fullId, isCanonicalId, PEER_STALE_MS, shortId } from "./protocol.ts";

export interface BusDirs {
	base: string;
	peers: string;
	socks: string;
	history: string;
}

/** Unix socket paths are capped near 108 bytes. */
const MAX_SOCK_PATH_BYTES = 100;
const DIR_MODE = 0o700;

export function busDirs(agentDir: string, override?: string): BusDirs {
	const base = override || join(agentDir, "bus");
	return { base, peers: join(base, "peers"), socks: join(base, "socks"), history: join(base, "history") };
}

/** Creates the dirs with mode 0700 and tightens existing ones. */
export function ensureDirs(dirs: BusDirs): BusDirs {
	for (const dir of [dirs.base, dirs.peers, dirs.socks, dirs.history]) {
		mkdirSync(dir, { recursive: true, mode: DIR_MODE });
		try {
			chmodSync(dir, DIR_MODE);
		} catch {
			// Another user's dir under an explicit PI_BUS_DIR. Messaging still works.
		}
	}
	return dirs;
}

export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Process start time from /proc. Two processes that reuse a pid cannot share it. */
export function pidBirth(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// Field 22 is starttime. comm may contain spaces, so cut after the last ')'.
		const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const startTime = tail[19];
		return startTime ? `${startTime}` : undefined;
	} catch {
		return undefined;
	}
}

/** Why a shared fallback dir is unsafe for the socket, or undefined when it is safe. Tightens an open mode. */
function fallbackDirProblem(dir: string): string | undefined {
	try {
		mkdirSync(dir, { recursive: true, mode: DIR_MODE });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EEXIST") return `cannot be created: ${code ?? (error as Error).message}`;
	}
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(dir);
	} catch (error) {
		return `cannot be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
	}
	// Another user can create the dir or link first in a shared root, then replace the socket.
	if (stat.isSymbolicLink()) return "is a symlink";
	if (!stat.isDirectory()) return "is not a directory";
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) return `is owned by uid ${stat.uid}`;
	if ((stat.mode & 0o077) !== 0) {
		try {
			chmodSync(dir, DIR_MODE);
		} catch {
			return "cannot be made private";
		}
	}
	return undefined;
}

/** The bus socks dir, then `pi-bus-<uid>` under each fallback root. A path that is too long can never bind. */
export function socketPathFor(
	instanceId: string,
	dirs: BusDirs,
	suffix = "",
	fallbackRoots: readonly string[] = [tmpdir(), "/tmp"],
): string {
	// The full id, not a prefix: a prefix collision would let a stale record authorize deleting a live listener.
	const leaf = `${fullId(instanceId)}${suffix}.sock`;
	const preferred = join(dirs.socks, leaf);
	const fits = (path: string) => Buffer.byteLength(path, "utf8") <= MAX_SOCK_PATH_BYTES;
	if (fits(preferred)) return preferred;
	const rejected: string[] = [];
	for (const root of fallbackRoots) {
		const fallbackDir = join(root, `pi-bus-${userInfo().uid}`);
		const path = join(fallbackDir, leaf);
		if (!fits(path)) continue;
		const problem = fallbackDirProblem(fallbackDir);
		if (!problem) return path;
		rejected.push(`${fallbackDir} ${problem}`);
	}
	if (rejected.length > 0) throw new Error(`no usable bus socket dir: ${rejected.join("; ")}`);
	throw new Error(`bus socket path is too long: ${preferred}`);
}

function peerPathFor(instanceId: string, dirs: BusDirs): string {
	return join(dirs.peers, `${instanceId}.json`);
}

export function writePresence(record: PeerRecord, dirs: BusDirs): void {
	const target = peerPathFor(record.instanceId, dirs);
	const temp = `${target}.${process.pid}.${shortId(record.instanceId).slice(0, 6)}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(record)}\n`, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		// The bus dir was removed underneath us. Rebuild and retry once.
		ensureDirs(dirs);
		writeFileSync(temp, `${JSON.stringify(record)}\n`, "utf8");
	}
	renameSync(temp, target);
}

export type Liveness = "live" | "blocked" | "dead";

/** `blocked`: the pid is alive but the heartbeat is late. Blocked peers are kept. */
export function livenessOf(record: PeerRecord, now = Date.now()): Liveness {
	if (!pidAlive(record.pid)) return "dead";
	if (record.pidBirth) {
		const current = pidBirth(record.pid);
		if (current && current !== record.pidBirth) return "dead";
	}
	return now - record.heartbeatAt > PEER_STALE_MS ? "blocked" : "live";
}

function safeUnlink(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone, or reaped by a racing peer.
	}
}

function isFresh(path: string, maxAgeMs: number): boolean {
	try {
		return Date.now() - statSync(path).mtimeMs < maxAgeMs;
	} catch {
		return false;
	}
}

/** The basename must be the full instance id, optionally with a short rebind suffix. A prefix is no proof. */
export function ownsSocketPath(instanceId: string, sock: string): boolean {
	if (!sock) return false;
	if (!isCanonicalId(instanceId)) return false;
	const leaf = basename(sock);
	if (!leaf.endsWith(".sock")) return false;
	const stem = leaf.slice(0, -".sock".length);
	const id = fullId(instanceId);
	if (stem === id) return true;
	if (!stem.startsWith(`${id}-`)) return false;
	return /^[a-z0-9]{1,8}$/.test(stem.slice(id.length + 1));
}

function reap(record: PeerRecord, dirs: BusDirs): void {
	safeUnlink(peerPathFor(record.instanceId, dirs));
	if (ownsSocketPath(record.instanceId, record.sock)) safeUnlink(record.sock);
}

export class ScanError extends Error {}

/**
 * Live and blocked peers. Records of dead or recycled pids are reaped.
 * Throws ScanError when the dir cannot be read: its absence means "I could not look", not "nobody is here".
 */
export function scanPeers(dirs: BusDirs): PeerRecord[] {
	let entries: string[];
	try {
		entries = readdirSync(dirs.peers);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		throw new ScanError(`peer scan failed: ${code || (error as Error).message}`);
	}

	const now = Date.now();
	const live: PeerRecord[] = [];
	for (const entry of entries) {
		const path = join(dirs.peers, entry);
		if (entry.endsWith(".tmp")) {
			if (!isFresh(path, 60_000)) safeUnlink(path);
			continue;
		}
		if (!entry.endsWith(".json")) continue;

		let record: PeerRecord;
		try {
			record = JSON.parse(readFileSync(path, "utf8")) as PeerRecord;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !isFresh(path, 5_000)) safeUnlink(path);
			continue;
		}

		// The file name is the identity, so a corrupt payload cannot point at another peer's resources.
		const expectedId = entry.slice(0, -".json".length);
		if (
			!record?.instanceId ||
			record.instanceId !== expectedId ||
			!isCanonicalId(record.instanceId) ||
			typeof record.pid !== "number" ||
			!record.sock
		) {
			if (!isFresh(path, 5_000)) safeUnlink(path);
			continue;
		}
		const liveness = livenessOf(record, now);
		if (liveness === "dead") {
			reap(record, dirs);
			continue;
		}
		live.push(liveness === "blocked" ? { ...record, stale: true } : record);
	}

	return live.sort((a, b) => a.startedAt - b.startedAt);
}

export function readPeers(dirs: BusDirs): PeerRecord[] {
	try {
		return scanPeers(dirs);
	} catch {
		return [];
	}
}

export function readPeer(instanceId: string, dirs: BusDirs): PeerRecord | undefined {
	try {
		const record = JSON.parse(readFileSync(peerPathFor(instanceId, dirs), "utf8")) as PeerRecord;
		if (record.instanceId !== instanceId) return undefined;
		return livenessOf(record) === "dead" ? undefined : record;
	} catch {
		return undefined;
	}
}

/** Stable short tag for a session. Hashed: uuidv7 ids of one minute share their leading digits. */
export function sessionTag(sessionFile: string | undefined, width = 6): string | undefined {
	if (!sessionFile) return undefined;
	const leaf = basename(sessionFile).replace(/\.jsonl$/, "");
	const id = leaf.includes("_") ? leaf.slice(leaf.indexOf("_") + 1) : leaf;
	if (!id) return undefined;
	return createHash("sha256").update(id).digest("hex").slice(0, width);
}

export function shortHost(): string {
	return sanitizeName(hostname().split(".")[0] || "host");
}

export function sanitizeName(raw: string): string {
	const cleaned = (raw || "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 40);
	return cleaned || "pi";
}

/** A name not used by another live peer. Names are labels, never routing identity. */
export function pickName(desired: string, instanceId: string, peers: PeerRecord[]): string {
	const base = sanitizeName(desired);
	const taken = new Set(peers.filter((peer) => peer.instanceId !== instanceId).map((peer) => peer.name));
	if (!taken.has(base)) return base;
	for (let suffix = 2; suffix <= 64; suffix++) {
		const candidate = `${base}-${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
	const hex = fullId(instanceId);
	for (const width of [6, 12, 20, 32]) {
		const candidate = `${base}-${hex.slice(0, width)}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base}-${hex}-${Date.now().toString(36)}`;
}

/** The peer that started earlier keeps a shared name. Ties go to instance id order. */
export function loserOfNameConflict(self: PeerRecord, peers: PeerRecord[]): boolean {
	for (const peer of peers) {
		if (peer.instanceId === self.instanceId) continue;
		if (peer.name !== self.name) continue;
		if (peer.startedAt < self.startedAt) return true;
		if (peer.startedAt === self.startedAt && peer.instanceId < self.instanceId) return true;
	}
	return false;
}

export function removePresence(instanceId: string, sock: string, dirs: BusDirs): void {
	safeUnlink(peerPathFor(instanceId, dirs));
	if (ownsSocketPath(instanceId, sock)) safeUnlink(sock);
}

export function parseLabels(raw: string | undefined): Record<string, string> {
	const labels: Record<string, string> = {};
	if (!raw) return labels;
	for (const pair of raw.split(/[,\s]+/)) {
		if (!pair) continue;
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const key = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (key && value) labels[key] = value;
	}
	return labels;
}

export function formatLabels(labels: Record<string, string>): string {
	return Object.entries(labels)
		.map(([key, value]) => `${key}=${value}`)
		.join(",");
}
