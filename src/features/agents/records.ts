import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ContextMode } from "./context.ts";
import { closeHookPath, type Placement } from "./placement.ts";
import { type AgentPaths, ensurePrivateDir, spawnFilePath, writePrivateFile } from "./spawn-file.ts";

/** The on-disk shape the standalone extension wrote. Old records must keep loading. */
export interface ChildRecord {
	spawnId: string;
	name: string;
	role: string;
	task: string;
	cwd: string;
	placement: Placement;
	launchedAt: number;
	/** Owner id of the spawning process, so a reload keeps its children. */
	launchedBy: string;
	/** Proves this parent may drive the child. Never published. */
	controlToken: string;
	instanceId?: string | undefined;
	pid?: number | undefined;
	/** Process start time, so a recycled pid is never signalled. */
	pidBirth?: string | undefined;
	contextMode?: ContextMode | undefined;
}

export class ChildRecords {
	/** Records whose file write failed. They stay owned until resolved. */
	private readonly unsaved = new Map<string, ChildRecord>();

	readonly paths: AgentPaths;

	constructor(paths: AgentPaths) {
		this.paths = paths;
	}

	private file(spawnId: string): string {
		return join(this.paths.state, `${spawnId}.json`);
	}

	save(record: ChildRecord): void {
		try {
			ensurePrivateDir(this.paths.root);
			ensurePrivateDir(this.paths.state);
			writePrivateFile(this.file(record.spawnId), `${JSON.stringify(record)}\n`);
			this.unsaved.delete(record.spawnId);
		} catch (error) {
			this.unsaved.set(record.spawnId, record);
			throw new Error(`Unable to persist child state at ${this.file(record.spawnId)}: ${(error as Error).message}`);
		}
	}

	all(): ChildRecord[] {
		const bySpawn = new Map<string, ChildRecord>();
		let entries: string[] = [];
		try {
			entries = readdirSync(this.paths.state);
		} catch {
			// No children yet.
		}
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			try {
				const record = JSON.parse(readFileSync(join(this.paths.state, entry), "utf8")) as ChildRecord;
				if (record?.spawnId) bySpawn.set(record.spawnId, record);
			} catch {
				// A torn or foreign file is not a child record.
			}
		}
		for (const record of this.unsaved.values()) bySpawn.set(record.spawnId, record);
		return [...bySpawn.values()].sort((a, b) => a.launchedAt - b.launchedAt);
	}

	mine(owner: string): ChildRecord[] {
		return this.all().filter((record) => record.launchedBy === owner);
	}

	/** Deletes the record and every per-spawn file. A fork session file stays: the human may resume it. */
	forget(spawnId: string): void {
		this.unsaved.delete(spawnId);
		for (const path of [
			this.file(spawnId),
			spawnFilePath(this.paths, spawnId),
			closeHookPath(this.paths, spawnId),
			// TODO(okka): remove when no pi runs the standalone bus extension
			join(this.paths.prompts, `${spawnId}-role.md`),
			join(this.paths.prompts, `${spawnId}-protocol.md`),
		]) {
			rmSync(path, { force: true });
		}
	}
}
