// Linux reuses pids, and a reused pid can lead an unrelated process group. So every
// liveness answer and every signal is gated on pid plus start ticks plus pgid plus boot id.
import * as fs from "node:fs";

export interface ProcessIdentity {
	pid: number;
	pgid: number;
	startTicks: number;
	state: string;
}

export interface JobIdentity {
	bootId: string | undefined;
	pid: number;
	pgid: number;
	startTicks: number | undefined;
}

/** The pi process that started a job. */
export interface OwnerIdentity {
	pid: number;
	startTicks: number;
	bootId?: string;
}

export type Liveness = "alive" | "gone" | "ambiguous";

const PROC = "/proc";

function procAvailable(): boolean {
	try {
		return fs.statSync(`${PROC}/self/stat`).isFile();
	} catch {
		return false;
	}
}

export function readBootId(): string | undefined {
	try {
		return fs.readFileSync(`${PROC}/sys/kernel/random/boot_id`, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

// comm is field 2 and may hold spaces and parentheses, so fields are parsed after the last ')'.
export function readProcess(pid: number): ProcessIdentity | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(`${PROC}/${pid}/stat`, "utf8");
	} catch {
		return undefined;
	}
	const close = raw.lastIndexOf(")");
	if (close === -1) return undefined;
	const fields = raw
		.slice(close + 2)
		.trim()
		.split(/\s+/);
	const state = fields[0];
	const pgid = Number(fields[2]);
	const startTicks = Number(fields[19]);
	if (!state || !Number.isFinite(pgid) || !Number.isFinite(startTicks)) return undefined;
	return { pid, pgid, startTicks, state };
}

// All or nothing: a half-filled identity can never verify as alive, so its lease would stay ambiguous forever.
export function captureIdentity(pid: number | undefined): JobIdentity | undefined {
	if (pid === undefined) return undefined;
	const proc = readProcess(pid);
	if (!proc) return undefined;
	return { bootId: readBootId(), pid, pgid: proc.pgid, startTicks: proc.startTicks };
}

export function captureOwner(pid: number = process.pid): OwnerIdentity | undefined {
	const proc = readProcess(pid);
	if (!proc) return undefined;
	const bootId = readBootId();
	return bootId === undefined ? { pid, startTicks: proc.startTicks } : { pid, startTicks: proc.startTicks, bootId };
}

export interface VerifyDeps {
	readProcess?: (pid: number) => ProcessIdentity | undefined;
	readBootId?: () => string | undefined;
	available?: () => boolean;
}

/** Anything that cannot be proven is "ambiguous", never "alive": ambiguity must not authorize a signal. */
export function verifyLeader(identity: JobIdentity, deps: VerifyDeps = {}): Liveness {
	const available = (deps.available ?? procAvailable)();
	if (!available) return "ambiguous";

	const currentBootId = (deps.readBootId ?? readBootId)();
	if (identity.bootId && currentBootId && identity.bootId !== currentBootId) return "gone";

	const proc = (deps.readProcess ?? readProcess)(identity.pid);
	if (!proc) return "gone";
	if (identity.startTicks !== undefined && proc.startTicks !== identity.startTicks) return "gone";
	if (identity.startTicks === undefined) return "ambiguous";
	if (proc.pgid !== identity.pgid) return "ambiguous";
	return "alive";
}

export function verifyOwner(owner: OwnerIdentity, deps: VerifyDeps = {}): Liveness {
	if (!(deps.available ?? procAvailable)()) return "ambiguous";
	const currentBootId = (deps.readBootId ?? readBootId)();
	if (owner.bootId && currentBootId && owner.bootId !== currentBootId) return "gone";
	const proc = (deps.readProcess ?? readProcess)(owner.pid);
	if (!proc || proc.startTicks !== owner.startTicks) return "gone";
	return "alive";
}

interface GroupScanDeps {
	listPids?: () => number[];
	readProcess?: (pid: number) => ProcessIdentity | undefined;
	available?: () => boolean;
}

export function listPids(): number[] {
	try {
		return fs
			.readdirSync(PROC)
			.filter((entry) => /^\d+$/.test(entry))
			.map(Number);
	} catch {
		return [];
	}
}

// The shell leader can exit while descendants keep the group. Members that predate the
// lease are ignored, so a reused pgid does not resurrect a dead job.
export function groupMembers(
	pgid: number,
	minStartTicks: number | undefined,
	deps: GroupScanDeps = {},
): ProcessIdentity[] {
	if (!(deps.available ?? procAvailable)()) return [];
	const read = deps.readProcess ?? readProcess;
	const members: ProcessIdentity[] = [];
	for (const pid of (deps.listPids ?? listPids)()) {
		const proc = read(pid);
		if (!proc || proc.pgid !== pgid) continue;
		if (minStartTicks !== undefined && proc.startTicks < minStartTicks) continue;
		members.push(proc);
	}
	return members;
}

export function verifyGroup(identity: JobIdentity, deps: VerifyDeps & GroupScanDeps = {}): Liveness {
	const leader = verifyLeader(identity, deps);
	if (leader === "alive") return "alive";
	const members = groupMembers(identity.pgid, identity.startTicks, deps);
	if (members.length > 0) return "ambiguous";
	return leader;
}

export function describeLiveness(liveness: Liveness): string {
	if (liveness === "alive") return "alive, identity verified";
	if (liveness === "gone") return "gone, identity absent";
	return "ambiguous, identity unverifiable";
}
