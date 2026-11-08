import { join } from "node:path";
import type { ExecFn } from "../../core/exec.ts";
import { type AgentPaths, ensurePrivateDir, writePrivateFile } from "./spawn-file.ts";

/** Old state files can still name tmux, kitty, or terminal. Only Herdr panes are managed. */
export interface Placement {
	// TODO(okka): remove when no pi runs the standalone bus extension
	kind: "herdr" | "tmux" | "kitty" | "terminal";
	handle: string;
	handleBirth?: string | undefined;
	tabId?: string | undefined;
	layout: "split" | "window" | "tab" | "process";
	detail: string;
}

export interface PlacementRequest {
	title: string;
	cwd: string;
	/** Arguments for pi, without the executable. */
	args: string[];
	env: Record<string, string>;
	/** Generated extension that closes the pane after a clean exit. */
	closeHook: string;
}

export interface Placer {
	/** True inside a Herdr pane. */
	inside(): boolean;
	place(request: PlacementRequest, id: string): Promise<Placement>;
	/** Undefined when the pane is not managed. */
	alive(placement: Placement): Promise<boolean | undefined>;
	focus(placement: Placement): Promise<boolean>;
	close(placement: Placement): Promise<boolean>;
	describe(): Promise<string>;
}

export const OUTSIDE_HERDR = "pi_agents needs a Herdr session. Start pi inside Herdr.";
export const HERDR_START_TIMEOUT_MS = 30_000;

interface HerdrOptions {
	exec: ExecFn;
	env?: NodeJS.ProcessEnv;
	/** Herdr returns the tab before its login shell reaches a prompt. */
	shellDelayMs?: number;
	shellTimeoutMs?: number;
	pollMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

interface HerdrPane {
	pane_id: string;
	tab_id?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function herdrAgentName(title: string, id: string): string {
	const base =
		title
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^[^a-z]+/, "")
			.replace(/-+$/, "") || "pi-agent";
	return `${base.slice(0, 23)}-${id.replace(/-/g, "").slice(0, 8)}`;
}

/**
 * Holds no task and no token. Acts only at a clean process exit.
 * CLI extensions run their shutdown handlers first, so closing the pane at quit would kill pi before pimon stops.
 */
export function closeHookSource(): string {
	return `import { execFileSync } from "node:child_process";
let closed = false;
function closePane(code) {
  if (closed || code !== 0) return;
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) return;
  try {
    execFileSync("herdr", ["pane", "close", pane], { stdio: "ignore" });
    closed = true;
  } catch {}
}
export default function () {
  process.on("exit", (code) => closePane(code));
}
`;
}

export function closeHookPath(paths: AgentPaths, spawnId: string): string {
	return join(paths.prompts, `${spawnId}-herdr-close.ts`);
}

export function writeCloseHook(paths: AgentPaths, spawnId: string): string {
	ensurePrivateDir(paths.root);
	ensurePrivateDir(paths.prompts);
	const path = closeHookPath(paths, spawnId);
	writePrivateFile(path, closeHookSource());
	return path;
}

export function createHerdrPlacer(options: HerdrOptions): Placer {
	const env = options.env ?? process.env;
	const sleep = options.sleep ?? defaultSleep;
	const run = async (args: string[]): Promise<string> => {
		const result = await options.exec("herdr", args, { timeoutMs: 45_000 });
		if (result.failed || result.code !== 0) {
			throw new Error(
				`herdr ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.failed || `exit ${result.code}`).trim()}`,
			);
		}
		return result.stdout.trim();
	};
	const json = async <T>(args: string[]): Promise<T> => {
		const value = await run(args);
		try {
			return JSON.parse(value) as T;
		} catch {
			throw new Error(`herdr returned invalid JSON: ${value.slice(0, 240)}`);
		}
	};
	const attempt = async (args: string[]): Promise<boolean> => {
		try {
			await run(args);
			return true;
		} catch {
			return false;
		}
	};
	const inside = () => env["HERDR_ENV"] === "1";

	const shellReady = async (paneId: string): Promise<boolean> => {
		try {
			const response = await json<{
				result?: { process_info?: { foreground_processes?: { argv?: string[] }[] } };
			}>(["pane", "process-info", "--pane", paneId]);
			const processes = response.result?.process_info?.foreground_processes ?? [];
			const executable = processes[0]?.argv?.[0]?.split("/").pop();
			const shell = env["SHELL"]?.split("/").pop();
			return processes.length === 1 && ["bash", "dash", "fish", "sh", "zsh", "nu", shell].includes(executable ?? "");
		} catch {
			return false;
		}
	};

	const close = async (placement: Placement): Promise<boolean> =>
		placement.kind === "herdr" ? attempt(["pane", "close", placement.handle]) : false;

	return {
		inside,
		async place(request, id) {
			if (!inside()) throw new Error(OUTSIDE_HERDR);
			const workspaceId = env["HERDR_WORKSPACE_ID"];
			if (!workspaceId) throw new Error("Herdr placement requires HERDR_WORKSPACE_ID");
			const label =
				request.title
					.replace(/[\r\n\t]+/g, " ")
					.trim()
					.slice(0, 80) || "pi-agent";
			const tabArgs = [
				"tab",
				"create",
				"--workspace",
				workspaceId,
				"--cwd",
				request.cwd,
				"--label",
				label,
				"--no-focus",
			];
			for (const [key, value] of Object.entries(request.env)) tabArgs.push("--env", `${key}=${value}`);
			const created = await json<{ result?: { tab?: { tab_id?: string }; root_pane?: HerdrPane } }>(tabArgs);
			const tabId = created.result?.tab?.tab_id;
			const paneId = created.result?.root_pane?.pane_id;
			if (!tabId || !paneId) throw new Error("Herdr did not return the child tab and root pane");
			const placement: Placement = {
				kind: "herdr",
				handle: paneId,
				tabId,
				layout: "tab",
				detail: "in a dedicated full-size Herdr tab; parent focus preserved",
			};
			try {
				const earliest = Date.now() + (options.shellDelayMs ?? 1_000);
				const deadline = earliest + (options.shellTimeoutMs ?? 9_000);
				let ready = false;
				while (Date.now() < deadline) {
					if (Date.now() >= earliest && (await shellReady(paneId))) {
						ready = true;
						break;
					}
					await sleep(options.pollMs ?? 100);
				}
				if (!ready) throw new Error(`Herdr pane ${paneId} did not reach an interactive shell`);
				await json([
					"agent",
					"start",
					herdrAgentName(request.title, id),
					"--kind",
					"pi",
					"--pane",
					paneId,
					"--timeout",
					String(HERDR_START_TIMEOUT_MS),
					"--",
					"-e",
					request.closeHook,
					...request.args,
				]);
			} catch (error) {
				await close(placement);
				throw error;
			}
			return placement;
		},
		async alive(placement) {
			if (placement.kind !== "herdr") return undefined;
			try {
				const response = await json<{ result?: { pane?: HerdrPane } }>(["pane", "get", placement.handle]);
				return Boolean(response.result?.pane);
			} catch {
				return false;
			}
		},
		focus: async (placement) =>
			placement.kind === "herdr" ? attempt(["pane", "focus", "--pane", placement.handle]) : false,
		close,
		async describe() {
			if (!inside()) return "herdr: not available, this process is not inside Herdr";
			const reachable = await attempt(["status", "client"]);
			const pane = env["HERDR_PANE_ID"] ?? "unknown";
			const workspace = env["HERDR_WORKSPACE_ID"] ?? "unknown";
			return reachable
				? `herdr: available, workspace ${workspace}, pane ${pane}. Each child uses one full tab; the parent keeps its tab.`
				: `herdr: inside workspace ${workspace}, pane ${pane}, but the herdr CLI does not answer`;
		},
	};
}
