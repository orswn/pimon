import type { ExecFn } from "../../core/exec.ts";
import type { GitStatus } from "./segments.ts";

const TIMEOUT_MS = 800;
const MIN_SPACING_MS = 2_000;
const STALE_MS = 30_000;
const FAILURE_PAUSE_MS = 60_000;

export function parseGitStatus(stdout: string): GitStatus | undefined {
	const lines = stdout.split("\n").filter(Boolean);
	const header = lines[0] ?? "";
	if (!header.startsWith("## ")) return undefined;
	let branch = header.slice(3).split("...")[0]?.split(" ")[0] ?? "HEAD";
	if (branch === "HEAD") branch = "detached";
	const ahead = Number(header.match(/ahead (\d+)/)?.[1] ?? 0);
	const behind = Number(header.match(/behind (\d+)/)?.[1] ?? 0);
	return { branch, dirty: Math.max(0, lines.length - 1), ahead, behind };
}

export interface GitWatchOptions {
	run: ExecFn;
	now: () => number;
	onChange: () => void;
}

export interface GitWatch {
	/** An event that can change the status. Starts a check now, or marks one pending. */
	request(cwd: string): void;
	/** Starts a pending or stale check. Never blocks. */
	onRender(cwd: string): void;
	status(cwd: string): GitStatus | undefined;
}

export function createGitWatch(options: GitWatchOptions): GitWatch {
	let current: { cwd: string; status: GitStatus } | undefined;
	let lastStart = Number.NEGATIVE_INFINITY;
	let inFlight = false;
	let pending = false;
	const pausedUntil = new Map<string, number>();

	const start = (cwd: string) => {
		if (inFlight) return;
		const now = options.now();
		if (now < (pausedUntil.get(cwd) ?? 0)) {
			pending = false;
			return;
		}
		if (now - lastStart < MIN_SPACING_MS) return;
		pending = false;
		inFlight = true;
		lastStart = now;
		const args = ["--no-optional-locks", "-C", cwd, "-c", "gc.auto=0", "status", "--porcelain=v1", "--branch"];
		void options
			.run("git", args, { timeoutMs: TIMEOUT_MS })
			.then((result) => {
				const status = result.failed || result.code !== 0 ? undefined : parseGitStatus(result.stdout);
				if (status) current = { cwd, status };
				else {
					current = undefined;
					pausedUntil.set(cwd, options.now() + FAILURE_PAUSE_MS);
				}
			})
			.finally(() => {
				inFlight = false;
				options.onChange();
			});
	};

	return {
		request(cwd) {
			pending = true;
			start(cwd);
		},
		onRender(cwd) {
			if (options.now() - lastStart >= STALE_MS) pending = true;
			if (pending) start(cwd);
		},
		status: (cwd) => (current?.cwd === cwd ? current.status : undefined),
	};
}
