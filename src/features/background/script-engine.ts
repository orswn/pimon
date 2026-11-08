// pimon runs scripts in its own sandbox, not in pi's codemode executor: pi shares 2 worker slots
// per process, and a long script job there would block the model's own codemode calls.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodemodeResult, CodemodeTool } from "@earendil-works/pi-codemode";

type Engine = typeof import("@earendil-works/pi-codemode");

const SCRIPT_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
export const CODEMODE_PACKAGE = "@earendil-works/pi-codemode";

export interface LoadedEngine {
	module: Pick<Engine, "CodemodeSandbox">;
	wasm: Promise<object>;
}

/** Lives in reload state, so a reload does not import the module or compile the wasm again. */
export interface EngineCache {
	engine: Promise<LoadedEngine> | undefined;
	loaded: boolean;
}

export function createEngineCache(): EngineCache {
	return { engine: undefined, loaded: false };
}

/** Calls `onFirstLoad` once, when this call loads the engine. A failed load is retried on the next call. */
export async function loadEngine(cache: EngineCache, onFirstLoad?: () => void): Promise<LoadedEngine> {
	if (!cache.engine) {
		const engine = import("@earendil-works/pi-codemode").then((module) => {
			const wasm = module.loadQuickJSWasm();
			cache.loaded = true;
			onFirstLoad?.();
			return { module, wasm };
		});
		cache.engine = engine;
		engine.catch(() => {
			if (cache.engine === engine) cache.engine = undefined;
		});
	}
	return cache.engine;
}

interface ScriptRun {
	code: string;
	tools: CodemodeTool[];
	globals: CodemodeTool[];
	signal: AbortSignal;
	/** 0 means no deadline. */
	timeoutMs: number;
}

export async function runScript(engine: LoadedEngine, run: ScriptRun): Promise<CodemodeResult> {
	const sandbox = new engine.module.CodemodeSandbox({
		tools: run.tools,
		globals: run.globals,
		timeoutMs: run.timeoutMs > 0 ? run.timeoutMs : Number.POSITIVE_INFINITY,
		memoryLimitBytes: SCRIPT_MEMORY_LIMIT_BYTES,
		wasm: engine.wasm,
	});
	try {
		return await sandbox.execute(run.code, { signal: run.signal });
	} finally {
		await sandbox.close();
	}
}

/** The version in the nearest `node_modules/<name>/package.json` at or above `startDir`. */
export function installedVersion(startDir: string, name: string): string | undefined {
	let dir = startDir;
	for (;;) {
		const file = path.join(dir, "node_modules", name, "package.json");
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
			return typeof parsed.version === "string" ? parsed.version : undefined;
		} catch {
			// Not here: look one level up.
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function ownEngineVersion(): string | undefined {
	return installedVersion(path.dirname(fileURLToPath(import.meta.url)), CODEMODE_PACKAGE);
}

/** A warning when the two versions differ in major or minor. Unknown versions give no warning. */
export function versionSkewWarning(ours: string | undefined, pis: string | undefined): string | undefined {
	if (!ours || !pis) return undefined;
	const majorMinor = (version: string) => version.split(".").slice(0, 2).join(".");
	if (majorMinor(ours) === majorMinor(pis)) return undefined;
	return `Script jobs use ${CODEMODE_PACKAGE} ${ours}, but pi ships ${pis}. Scripts can behave differently from pi's codemode tool. Update pimon's dependency to match pi.`;
}
