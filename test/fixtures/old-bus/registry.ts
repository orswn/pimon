/**
 * Presence registry for pi-bus: peer files, liveness, reaping, name selection.
 *
 * There is no hub. Discovery is a directory scan, so one wedged instance
 * cannot hide the others.
 *
 * Ownership rules, learned from the previous mesh and from review:
 *  - A live pid's files are never deleted, whatever its heartbeat says.
 *  - pid recycling is detected with the OS process start time, not a timeout.
 *  - A presence file may only cause deletion of resources it demonstrably owns.
 *  - No process ever mutates a file owned by another process. Names are derived
 *    from the live peer set instead of claimed through a lock file, because every
 *    claim protocol needed a cross-process delete to stay correct.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import type { PeerRecord } from "./protocol.ts";
import { fullId, isCanonicalId, PEER_STALE_MS, shortId } from "./protocol.ts";

export interface BusDirs {
	base: string;
	peers: string;
	socks: string;
	history: string;
}

/** Unix socket paths are capped near 108 bytes, so keep a safety margin. */
const MAX_SOCK_PATH_BYTES = 100;

export function busDirs(): BusDirs {
	const override = process.env.PI_BUS_DIR;
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const base = override || join(agentDir, "bus");
	return {
		base,
		peers: join(base, "peers"),
		socks: join(base, "socks"),
		history: join(base, "history"),
	};
}

export function ensureDirs(dirs: BusDirs = busDirs()): BusDirs {
	for (const dir of [dirs.base, dirs.peers, dirs.socks, dirs.history]) {
		mkdirSync(dir, { recursive: true });
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

/**
 * Process start time as reported by the OS. Two processes that reuse a pid
 * cannot share this value, which turns pid recycling into a definite answer
 * instead of a heartbeat guess. Returns undefined where it cannot be read.
 */
export function pidBirth(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// Field 22 is starttime; comm may contain spaces, so cut after the last ')'.
		const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const startTime = tail[19];
		return startTime ? `${startTime}` : undefined;
	} catch {
		return undefined;
	}
}

export function socketPathFor(instanceId: string, dirs: BusDirs = busDirs(), suffix = ""): string {
	// The full id, not a 12-hex prefix: a prefix collision would let one peer's
	// stale record authorize deleting another peer's live listener.
	const leaf = `${fullId(instanceId)}${suffix}.sock`;
	const preferred = join(dirs.socks, leaf);
	if (Buffer.byteLength(preferred, "utf8") <= MAX_SOCK_PATH_BYTES) return preferred;
	const fallbackDir = join(tmpdir(), `pi-bus-${userInfo().uid}`);
	mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
	return join(fallbackDir, leaf);
}

function peerPathFor(instanceId: string, dirs: BusDirs): string {
	return join(dirs.peers, `${instanceId}.json`);
}

export function writePresence(record: PeerRecord, dirs: BusDirs = busDirs()): void {
	const target = peerPathFor(record.instanceId, dirs);
	const temp = `${target}.${process.pid}.${shortId(record.instanceId).slice(0, 6)}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(record)}\n`, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		// Someone removed the bus directory underneath us. Rebuild and retry once.
		ensureDirs(dirs);
		writeFileSync(temp, `${JSON.stringify(record)}\n`, "utf8");
	}
	// Publish atomically: readers never observe a partial record.
	renameSync(temp, target);
}

export type Liveness = "live" | "blocked" | "dead";

/**
 * `blocked` means the pid is alive but the heartbeat is late, which happens when
 * an instance stalls its event loop or is stopped. Blocked peers are kept: a
 * blocked peer is not a dead peer, and deleting its files is what partitioned
 * the old mesh. Only a dead or recycled pid yields `dead`.
 */
export function livenessOf(record: PeerRecord, now = Date.now()): Liveness {
	if (!pidAlive(record.pid)) return "dead";
	if (record.pidBirth) {
		const current = pidBirth(record.pid);
		if (current && current !== record.pidBirth) return "dead"; // pid was recycled
	}
	return now - record.heartbeatAt > PEER_STALE_MS ? "blocked" : "live";
}

function safeUnlink(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone, or being reaped by a racing peer. Either is fine.
	}
}

function isFresh(path: string, maxAgeMs: number): boolean {
	try {
		return Date.now() - statSync(path).mtimeMs < maxAgeMs;
	} catch {
		return false;
	}
}

/**
 * Whether a record proves ownership of its socket path, which is the only
 * condition under which that socket may be deleted. Validity of the record does
 * not depend on this: discarding a live peer is worse than leaking a socket file.
 *
 * The basename must be the full instance id, optionally followed by a short
 * rebind suffix. A prefix match is not proof of ownership.
 */
export function ownsSocketPath(instanceId: string, sock: string): boolean {
	if (!sock) return false;
	// A non-canonical id must never be interpolated into a pattern: ".*" would
	// otherwise match, and authorize deleting another peer's socket.
	if (!isCanonicalId(instanceId)) return false;
	const leaf = basename(sock);
	if (!leaf.endsWith(".sock")) return false;
	const stem = leaf.slice(0, -".sock".length);
	const id = fullId(instanceId);
	if (stem === id) return true;
	if (!stem.startsWith(`${id}-`)) return false;
	return /^[a-z0-9]{1,8}$/.test(stem.slice(id.length + 1));
}

function ownsSocket(record: PeerRecord): boolean {
	return ownsSocketPath(record.instanceId, record.sock);
}

function reap(record: PeerRecord, dirs: BusDirs): void {
	safeUnlink(peerPathFor(record.instanceId, dirs));
	if (ownsSocket(record)) safeUnlink(record.sock);
}

export class ScanError extends Error {}

/**
 * Live and blocked peers. Records for dead or recycled pids are reaped.
 *
 * Throws ScanError when the directory cannot be read, including ENOENT: after
 * startup the directory always exists, so its absence means "I could not look",
 * not "nobody is here". Reporting an empty set there produced false deaths.
 */
export function scanPeers(dirs: BusDirs = busDirs()): PeerRecord[] {
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

		// The filename is the authority for identity, so a corrupt payload cannot
		// point at another peer's resources.
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

/** Convenience wrapper for callers that treat a failed scan as "nobody known". */
export function readPeers(dirs: BusDirs = busDirs()): PeerRecord[] {
	try {
		return scanPeers(dirs);
	} catch {
		return [];
	}
}

export function readPeer(instanceId: string, dirs: BusDirs = busDirs()): PeerRecord | undefined {
	try {
		const record = JSON.parse(readFileSync(peerPathFor(instanceId, dirs), "utf8")) as PeerRecord;
		if (record.instanceId !== instanceId) return undefined;
		return livenessOf(record) === "dead" ? undefined : record;
	} catch {
		return undefined;
	}
}

export function findPeerByName(name: string, dirs: BusDirs = busDirs()): PeerRecord | undefined {
	return readPeers(dirs).find((peer) => peer.name === name);
}

/**
 * Stable short tag for a session, derived from the session file's uuid.
 *
 * Hashed rather than sliced: a uuidv7 starts with a millisecond timestamp, so two
 * sessions created in the same minute share their leading hex digits.
 */
export function sessionTag(sessionFile: string | undefined, width = 6): string | undefined {
	if (!sessionFile) return undefined;
	const leaf = basename(sessionFile).replace(/\.jsonl$/, "");
	const id = leaf.includes("_") ? leaf.slice(leaf.indexOf("_") + 1) : leaf;
	if (!id) return undefined;
	return createHash("sha256").update(id).digest("hex").slice(0, width);
}

/** Host part of the machine name, without any domain suffix. */
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

/**
 * Pick a display name not currently used by a live peer.
 *
 * Names are human labels, never routing identity: every identity-pinned send
 * uses the full instance id. A simultaneous start can therefore hand the same
 * name to two peers for a moment, which `resolveNameConflict` settles without
 * any process touching another process's files.
 */
export function pickName(desired: string, instanceId: string, dirs: BusDirs = busDirs(), peers?: PeerRecord[]): string {
	const base = sanitizeName(desired);
	const taken = new Set((peers || readPeers(dirs)).filter((peer) => peer.instanceId !== instanceId).map((peer) => peer.name));
	if (!taken.has(base)) return base;
	for (let suffix = 2; suffix <= 64; suffix++) {
		const candidate = `${base}-${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
	// Six hex digits are not unique across uuids, so widen until the candidate is
	// demonstrably free. The full id form terminates the search by construction.
	const hex = fullId(instanceId);
	for (const width of [6, 12, 20, 32]) {
		const candidate = `${base}-${hex.slice(0, width)}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${base}-${hex}-${Date.now().toString(36)}`;
}

/**
 * Deterministic tiebreak for a name held by more than one live peer. The peer
 * that started earlier keeps the name; ties fall back to instance id order. The
 * loser renames itself, so the outcome converges without coordination.
 */
export function loserOfNameConflict(self: PeerRecord, peers: PeerRecord[]): boolean {
	for (const peer of peers) {
		if (peer.instanceId === self.instanceId) continue;
		if (peer.name !== self.name) continue;
		if (peer.startedAt < self.startedAt) return true;
		if (peer.startedAt === self.startedAt && peer.instanceId < self.instanceId) return true;
	}
	return false;
}

export function removePresence(instanceId: string, sock: string, dirs: BusDirs = busDirs()): void {
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
