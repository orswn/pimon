// Turns leases back into reservations. Report only: an orphan could be a dev server the user still wants.
import { type Liveness, verifyGroup, verifyOwner } from "./identity.ts";
import { deleteLease, type Lease, leaseDir, pruneTempLeases, readLeases } from "./leases.ts";
import { addOrphan, dropOrphan, orphans, type Registry } from "./registry.ts";

export type LeaseClass = "foreign" | "orphan" | "own" | "gone";

export interface ClassifyDeps {
	selfPid?: number;
	group?: (lease: Lease) => Liveness;
	owner?: (lease: Lease) => Liveness;
}

// A sibling pi that is alive owns its jobs. An unverifiable owner is treated as alive,
// because claiming a live sibling's job is worse than a missed orphan.
export function classifyLease(lease: Lease, tracked: boolean, deps: ClassifyDeps = {}): LeaseClass {
	const selfPid = deps.selfPid ?? process.pid;
	const group = deps.group ?? ((entry: Lease) => verifyGroup(entry.identity));
	const ownerLiveness = deps.owner ?? ((entry: Lease) => (entry.owner ? verifyOwner(entry.owner) : "gone"));

	if (group(lease) === "gone") return "gone";
	if (!lease.owner) return "foreign";
	const ownerState = ownerLiveness(lease);
	if (ownerState !== "gone" && lease.owner.pid !== selfPid) return "foreign";
	if (ownerState !== "gone" && tracked) return "own";
	return "orphan";
}

export function sweepLeases(reg: Registry): string | undefined {
	const dir = leaseDir(reg.agentDir);
	pruneTempLeases(dir);
	refreshOrphans(reg);

	const live: string[] = [];
	const unclear: string[] = [];
	const malformed: string[] = [];
	for (const entry of readLeases(dir)) {
		if (!entry.lease) {
			if (!reg.reportedLeases.has(entry.file)) malformed.push(entry.file);
			reg.reportedLeases.add(entry.file);
			continue;
		}
		const lease = entry.lease;
		if (reg.orphans.has(lease.name)) continue;
		const tracked = reg.active.get(lease.name)?.leaseFile === entry.file;
		const kind = classifyLease(lease, tracked);
		if (kind === "gone") {
			deleteLease(entry.file);
			continue;
		}
		if (kind !== "orphan") continue;

		const liveness = verifyGroup(lease.identity);
		addOrphan(reg, { file: entry.file, lease, liveness });
		if (reg.reportedLeases.has(entry.file)) continue;
		reg.reportedLeases.add(entry.file);
		const label = `${lease.name} (pid ${lease.identity.pid})`;
		if (liveness === "alive") live.push(label);
		else unclear.push(label);
	}

	const parts: string[] = [];
	if (live.length > 0) parts.push(`${live.length} job(s) from an earlier pi are still running: ${live.join(", ")}.`);
	if (unclear.length > 0) parts.push(`${unclear.length} job(s) cannot be verified: ${unclear.join(", ")}.`);
	if (malformed.length > 0)
		parts.push(`${malformed.length} unreadable lease file(s) were left in place for inspection.`);
	if (parts.length === 0) return undefined;
	return `${parts.join(" ")} Nothing was killed. Their names and log paths are reserved; see action=list.`;
}

/** The live sibling pi that owns a job of this name, if there is one. */
export function foreignOwner(reg: Registry, name: string): number | undefined {
	for (const entry of readLeases(leaseDir(reg.agentDir))) {
		const lease = entry.lease;
		if (!lease || lease.name !== name || !lease.owner) continue;
		if (classifyLease(lease, false) === "foreign") return lease.owner.pid;
	}
	return undefined;
}

/** The job of a live sibling pi that holds this log path, if there is one. */
export function foreignLogFile(reg: Registry, file: string): string | undefined {
	for (const entry of readLeases(leaseDir(reg.agentDir))) {
		const lease = entry.lease;
		if (!lease || lease.logFile !== file) continue;
		if (classifyLease(lease, false) !== "foreign") continue;
		return `${lease.name} (running pi ${lease.owner?.pid ?? "unknown"})`;
	}
	return undefined;
}

// Without this a reservation outlives its process: the sweep sees an orphan alive, it exits
// an hour later, and the name stays blocked until pi restarts.
export function refreshOrphans(reg: Registry): void {
	for (const record of orphans(reg)) {
		const liveness = verifyGroup(record.lease.identity);
		if (liveness === "gone") {
			deleteLease(record.file);
			dropOrphan(reg, record.lease.name);
			continue;
		}
		record.liveness = liveness;
	}
}
