import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ContextMode } from "./context.ts";
import { closeHookPath, type Placement } from "./placement.ts";
import { type AgentPaths, ensurePrivateDir, pidFilePath, spawnFilePath, writePrivateFile } from "./spawn-file.ts";

/** The on-disk child record. Records that earlier versions wrote must keep loading. */
export interface ChildRecord {
	/** The child's session id. Earlier versions used a separate spawn id. */
	spawnId: string;
	name: string;
	role: string;
	task: string;
	cwd: string;
	placement: Placement;
	launchedAt: number;
	/** Session id of the parent, so a reload keeps its children. */
	launchedBy: string;
	contextMode?: ContextMode | undefined;
	/** The hub task of the first instruction. */
	taskId?: string | undefined;
	/** A temp session file for context=fork, deleted once the child is online. */
	forkFile?: string | undefined;
}

export class ChildRecords {
	/** Records whose file write failed. They stay owned until resolved. */
	private readonly unsaved = new Map<string, ChildRecord>();

	readonly paths: AgentPaths;

	/** Called after a record was saved or forgotten. */
	onChange: (() => void) | undefined;

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
		} finally {
			this.onChange?.();
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

	mine(parent: string): ChildRecord[] {
		return this.all().filter((record) => record.launchedBy === parent);
	}

	/** Deletes the record and every per-spawn file, with the temp fork source of a child that never came online. */
	forget(spawnId: string): void {
		const forkFile = this.all().find((record) => record.spawnId === spawnId)?.forkFile;
		this.unsaved.delete(spawnId);
		for (const path of [
			...(forkFile ? [forkFile] : []),
			this.file(spawnId),
			spawnFilePath(this.paths, spawnId),
			pidFilePath(this.paths, spawnId),
			closeHookPath(this.paths, spawnId),
		]) {
			rmSync(path, { force: true });
		}
		this.onChange?.();
	}
}
