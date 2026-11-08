import { existsSync, rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { FeatureLog } from "../../core/feature.ts";
import type { SpawnIdentity } from "../bus/index.ts";
import type { LaunchEnv } from "../bus/identity.ts";
import {
	parseSpawnEntry,
	SPAWN_ENTRY,
	type SpawnEntry,
	type SpawnFile,
	spawnEntry,
	takeSpawnFile,
} from "./spawn-file.ts";

interface ChildState {
	/** The spawn file is read once per process. */
	read: boolean;
	data?: SpawnFile | undefined;
	taskSent: boolean;
}

export function newChildState(): ChildState {
	return { read: false, taskSent: false };
}

export function loadSpawnFile(state: ChildState, launch: Readonly<LaunchEnv>, log: FeatureLog): void {
	if (state.read || !launch.spawnFile) return;
	state.read = true;
	const taken = takeSpawnFile(launch.spawnFile);
	if ("error" in taken) {
		log.error(`spawn data not loaded, joining the bus with a default identity: ${taken.error}`);
		return;
	}
	state.data = taken.data;
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
	controlToken?: string | undefined;
}

/**
 * The file of this process wins. A resumed session has only its entry, which holds no token.
 * A process started with a spawn file never uses an entry: a fork copies the entry of its parent.
 */
export function spawnSource(
	state: ChildState,
	extCtx: ExtensionContext,
	launch: Readonly<LaunchEnv>,
): SpawnSource | undefined {
	if (state.data) return { entry: spawnEntry(state.data), controlToken: state.data.controlToken };
	if (launch.spawnFile) return undefined;
	const entry = entryOnBranch(extCtx);
	return entry ? { entry } : undefined;
}

export function spawnIdentity(source: SpawnSource | undefined): SpawnIdentity | undefined {
	if (!source) return undefined;
	return { name: source.entry.child.name, labels: source.entry.child.labels, controlToken: source.controlToken };
}

/** The first task may meet a run that already started, from a bus digest or from the human in the pane. */
export function sendTask(pi: ExtensionAPI, task: string): void {
	pi.sendUserMessage(task, { deliverAs: "followUp" });
}

/**
 * Herdr's agent start fails when pi is busy past its timeout, and the parent then closes the pane.
 * After the deadline the task goes anyway, so a parent that died after placement does not strand it.
 * Returns a cancel function.
 */
export function awaitPlacement(
	marker: string,
	timing: { pollMs: number; waitMs: number },
	send: () => void,
): () => void {
	const deadline = Date.now() + timing.waitMs;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const check = () => {
		timer = undefined;
		const placed = existsSync(marker);
		if (!placed && Date.now() < deadline) {
			schedule();
			return;
		}
		if (placed) {
			try {
				rmSync(marker, { force: true });
			} catch {
				// The send must not depend on the cleanup. Old spawn files are pruned later.
			}
		}
		send();
	};
	const schedule = () => {
		timer = setTimeout(check, timing.pollMs);
		timer.unref();
	};
	schedule();
	return () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};
}

/** Tools first, so the prompt render that follows sees the allowlist. Returns the task to send once, after the render. */
export function startChildSession(
	pi: ExtensionAPI,
	state: ChildState,
	source: SpawnSource | undefined,
	event: SessionStartEvent,
): string | undefined {
	const tools = source?.entry.child.tools;
	if (tools && tools.length > 0) pi.setActiveTools(tools);
	if (!state.data || state.taskSent || event.reason !== "startup") return undefined;
	state.taskSent = true;
	pi.appendEntry(SPAWN_ENTRY, spawnEntry(state.data));
	return state.data.task;
}
