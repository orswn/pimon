// A detached job survives a SIGKILLed pi with no record anywhere. A lease is that record,
// so a later pi can see the orphan, keep its name and log path reserved, and signal it only
// when identity checks out. Leases never live beside a user-chosen log path.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { JobIdentity, OwnerIdentity } from "./identity.ts";
import type { Kind } from "./options.ts";

export interface Lease {
	version: 1;
	name: string;
	kind: Kind;
	command: string;
	cwd: string;
	logFile: string;
	createdAt: number;
	identity: JobIdentity;
	/** Absent in leases written by the standalone background extension. */
	owner?: OwnerIdentity;
}

export interface LeaseFile {
	file: string;
	lease: Lease | undefined;
	error: string | undefined;
}

// Every field is checked: a lease that kept its pid but lost its pgid would be scanned
// against undefined, classified gone, and deleted instead of preserved.
export function validateLease(lease: unknown): string | undefined {
	if (!isRecord(lease)) return "lease is not an object";
	if (lease["version"] !== 1) return `unsupported lease version ${String(lease["version"])}`;
	for (const field of ["name", "command", "cwd", "logFile"] as const) {
		const text = lease[field];
		if (typeof text !== "string" || text.length === 0) return `lease field ${field} is missing or not a string`;
	}
	if (lease["kind"] !== "monitor" && lease["kind"] !== "background")
		return `lease field kind is ${String(lease["kind"])}`;
	if (!isPositiveInt(lease["createdAt"])) return "lease field createdAt is not a positive integer";
	const identity = lease["identity"];
	if (!isRecord(identity)) return "lease identity is missing";
	if (!isPositiveInt(identity["pid"])) return "lease identity.pid is not a positive integer";
	if (!isPositiveInt(identity["pgid"])) return "lease identity.pgid is not a positive integer";
	if (!isNonNegativeInt(identity["startTicks"])) return "lease identity.startTicks is not a non-negative integer";
	if (!isOptionalText(identity["bootId"])) return "lease identity.bootId is not a string";
	const owner = lease["owner"];
	if (owner === undefined) return undefined;
	if (!isRecord(owner)) return "lease owner is not an object";
	if (!isPositiveInt(owner["pid"])) return "lease owner.pid is not a positive integer";
	if (!isNonNegativeInt(owner["startTicks"])) return "lease owner.startTicks is not a non-negative integer";
	if (!isOptionalText(owner["bootId"])) return "lease owner.bootId is not a string";
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): boolean {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOptionalText(value: unknown): boolean {
	return value === undefined || (typeof value === "string" && value.length > 0);
}

export function leaseDir(agentDir: string): string {
	const override = process.env["PI_BACKGROUND_DIR"];
	if (override) return path.join(override, "leases");
	return path.join(agentDir, "background", "leases");
}

export function leasePath(lease: Lease, dir: string): string {
	const safe = lease.name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
	return path.join(dir, `${safe}-${lease.identity.pid}-${lease.createdAt}.json`);
}

// The temp name is unique per write: a fixed .tmp can collide with a crashed writer.
export function writeLease(lease: Lease, dir: string): string | undefined {
	const file = leasePath(lease, dir);
	const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(temp, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
		fs.renameSync(temp, file);
		return file;
	} catch {
		try {
			fs.unlinkSync(temp);
		} catch {
			// Nothing to clean up.
		}
		return undefined;
	}
}

export function deleteLease(file: string | undefined): void {
	if (!file) return;
	try {
		fs.unlinkSync(file);
	} catch {
		// Already gone.
	}
}

// Malformed leases are reported, never deleted: they may be the only trace left.
export function readLeases(dir: string): LeaseFile[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(dir).filter((entry) => entry.endsWith(".json"));
	} catch {
		return [];
	}
	return entries.map((entry) => {
		const file = path.join(dir, entry);
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
			const problem = validateLease(parsed);
			return problem ? { file, lease: undefined, error: problem } : { file, lease: parsed as Lease, error: undefined };
		} catch (error) {
			return { file, lease: undefined, error: error instanceof Error ? error.message : String(error) };
		}
	});
}

export function pruneTempLeases(dir: string, olderThanMs = 60_000): number {
	let removed = 0;
	let entries: string[];
	try {
		entries = fs.readdirSync(dir);
	} catch {
		return removed;
	}
	for (const entry of entries) {
		if (!entry.endsWith(".tmp")) continue;
		const file = path.join(dir, entry);
		try {
			if (Date.now() - fs.statSync(file).mtimeMs < olderThanMs) continue;
			fs.unlinkSync(file);
			removed++;
		} catch {
			// Skip.
		}
	}
	return removed;
}
