import { rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { FeatureLog } from "../../core/feature.ts";
import type { SpawnIdentity } from "../bus/index.ts";
import { pidBirth } from "./pid.ts";
import {
	type AgentPaths,
	parseSpawnEntry,
	pidFilePath,
	SPAWN_ENTRY,
	type SpawnEntry,
	type SpawnFile,
	spawnEntry,
	spawnFilePath,
	takeSpawnFile,
	writePidFile,
} from "./spawn-file.ts";

export interface ChildState {
	/** The spawn file is read once per process. */
	read: boolean;
	data?: SpawnFile | undefined;
	entryWritten: boolean;
	/** The first task from the hub mailbox. Kept here so a reload before the send does not lose it. */
	firstTask?: { text?: string | undefined; sent: boolean } | undefined;
	/** The child id of the pid file that this process wrote. */
	pidFor?: string | undefined;
}

export function newChildState(): ChildState {
	return { read: false, entryWritten: false };
}

/** A spawned child finds its spawn data by its own session id. */
export function loadSpawnFile(state: ChildState, paths: AgentPaths, sessionId: string, log: FeatureLog): void {
	if (state.read) return;
	state.read = true;
	const taken = takeSpawnFile(spawnFilePath(paths, sessionId));
	if (!taken) return;
	if ("error" in taken) {
		log.error(`spawn data not loaded, joining the bus with a default identity: ${taken.error}`);
		return;
	}
	state.data = taken.data;
	state.firstTask = { sent: false };
}

function entryOnBranch(extCtx: ExtensionContext): SpawnEntry | undefined {
	const branch = extCtx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== SPAWN_ENTRY) continue;
		const parsed = parseSpawnEntry(entry.data);
		if (parsed) return parsed;
	}
	return undefined;
}

export interface SpawnSource {
	entry: SpawnEntry;
	/** Set only in the process that the parent started, for its own session. */
	data?: SpawnFile | undefined;
}

/**
 * The spawn data of this process wins for its own session. A resumed session has only its entry.
 * An entry counts only for the session it names: a fork copies the entry of its parent.
 */
export function spawnSource(state: ChildState, extCtx: ExtensionContext): SpawnSource | undefined {
	if (state.data) {
		return state.data.spawnId === extCtx.sessionManager.getSessionId()
			? { entry: spawnEntry(state.data), data: state.data }
			: undefined;
	}
	const entry = entryOnBranch(extCtx);
	return entry?.spawnId === extCtx.sessionManager.getSessionId() ? { entry } : undefined;
}

export function spawnIdentity(state: ChildState, source: SpawnSource | undefined): SpawnIdentity | undefined {
	if (!source) return undefined;
	const waiting = source.data && state.firstTask && !state.firstTask.sent && state.firstTask.text === undefined;
	return {
		name: source.entry.child.name,
		role: source.entry.role.name,
		parent: source.entry.parent.id,
		labels: source.entry.child.labels,
		firstTask: waiting ? source.data?.firstTask.messageId : undefined,
	};
}

/** The first task may meet a run that already started, from the human in the pane. */
export function sendTask(pi: ExtensionAPI, task: string): void {
	pi.sendUserMessage(task, { deliverAs: "followUp" });
}

/** Tools first, so the prompt render that follows sees the allowlist. Writes the pid file, and the session entry once. */
export function startChildSession(
	pi: ExtensionAPI,
	state: ChildState,
	source: SpawnSource | undefined,
	event: SessionStartEvent,
	paths: AgentPaths,
	log: FeatureLog,
): void {
	const tools = source?.entry.child.tools;
	if (tools && tools.length > 0) pi.setActiveTools(tools);
	if (!source) return;
	try {
		writePidFile(paths, source.entry.spawnId, { pid: process.pid, birth: pidBirth(process.pid) });
		state.pidFor = source.entry.spawnId;
	} catch (error) {
		log.error("child pid file not written; the parent cannot kill this process", error);
	}
	if (!source.data || state.entryWritten || event.reason !== "startup") return;
	state.entryWritten = true;
	pi.appendEntry(SPAWN_ENTRY, spawnEntry(source.data));
}

export function removePidFile(state: ChildState, paths: AgentPaths): void {
	if (state.pidFor) rmSync(pidFilePath(paths, state.pidFor), { force: true });
}
