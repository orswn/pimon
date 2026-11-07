// A nonzero exit is evidence. A timeout, spawn failure, abort, signal, or output overflow is not: `failed` marks those.
// Each child gets its own process group, because aborting only the direct child left grandchildren running.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type ExecFailure = "timeout" | "spawn" | "aborted" | "output-limit" | "signal" | "unknown";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	/** Set when the process did not run to completion. Never treat this as a verdict. */
	failed?: ExecFailure;
}

export interface ExecOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	cwd?: string;
	/** Grace between SIGTERM and SIGKILL for the group. */
	killGraceMs?: number;
	maxOutputBytes?: number;
}

export type ExecFn = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;
const GROUPS = process.platform !== "win32";

/** Live groups, so a session shutdown does not leave a verification suite running. */
const live = new Set<number>();

function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		if (GROUPS) process.kill(-pid, signal);
		else process.kill(pid, signal);
	} catch {
		// Already gone, or never ours.
	}
}

/** Kill every process group this module started. Called on session shutdown. */
export function terminateAll(): void {
	for (const pid of live) {
		signalGroup(pid, "SIGTERM");
		signalGroup(pid, "SIGKILL");
	}
	live.clear();
}

export const runProcess: ExecFn = (command, args, options) =>
	new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				cwd: options?.cwd,
				// Own process group, so cancellation reaches descendants too.
				detached: GROUPS,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({
				code: -1,
				stdout: "",
				stderr: error instanceof Error ? error.message : String(error),
				failed: "spawn",
			});
			return;
		}

		const pid = child.pid;
		if (pid) live.add(pid);

		let out = "";
		let err = "";
		let bytes = 0;
		let failure: ExecFailure | undefined;
		let detail: string | undefined;
		let settled = false;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		// Escalation is deliberately independent of the leader's close event. A
		// descendant that ignores SIGTERM and redirects its stdio lets the leader exit
		// immediately, and cancelling the pending SIGKILL there would leave it running
		// and untracked. Measured: it survived and wrote its marker three seconds later.
		let escalating = false;

		const stopTree = (kind: ExecFailure, why?: string) => {
			failure ??= kind;
			detail ??= why;
			if (!pid) {
				child.kill("SIGKILL");
				return;
			}
			signalGroup(pid, "SIGTERM");
			if (escalating) return;
			escalating = true;
			const escalation = setTimeout(() => {
				signalGroup(pid, "SIGKILL");
				live.delete(pid);
			}, options?.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
			// Unref'd so it never holds the process open, but never cleared either.
			escalation.unref?.();
		};

		const onAbort = () => stopTree("aborted", "cancelled");
		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		if (options?.timeoutMs && options.timeoutMs > 0) {
			timeoutTimer = setTimeout(() => stopTree("timeout", `timed out after ${options.timeoutMs}ms`), options.timeoutMs);
			timeoutTimer.unref?.();
		}

		// Chunks stay Buffers and are truncated by bytes, because slicing a decoded
		// string counts UTF-16 units and a chunk of emoji would overshoot the cap. A
		// StringDecoder keeps a rune split across chunks from becoming garbage.
		const cap = options?.maxOutputBytes ?? MAX_OUTPUT_BYTES;
		const collect = (target: "out" | "err", decoder: StringDecoder) => (chunk: Buffer) => {
			const room = cap - bytes;
			if (room > 0) {
				const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
				bytes += kept.length;
				const text = decoder.write(kept);
				if (target === "out") out += text;
				else err += text;
			}
			if (bytes >= cap) stopTree("output-limit", `output exceeded ${cap} bytes`);
		};
		child.stdout?.on("data", collect("out", new StringDecoder("utf8")));
		child.stderr?.on("data", collect("err", new StringDecoder("utf8")));

		const finish = (result: ExecResult) => {
			if (settled) return;
			settled = true;
			// Only drop the group when nothing is pending against it: while escalation is
			// scheduled the group must stay visible to terminateAll().
			if (pid && !escalating) live.delete(pid);
			if (timeoutTimer) clearTimeout(timeoutTimer);
			options?.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};

		child.on("error", (error) => {
			const code = (error as NodeJS.ErrnoException).code;
			finish({
				code: -1,
				stdout: out,
				stderr: err || error.message,
				failed: failure ?? (typeof code === "string" ? "spawn" : "unknown"),
			});
		});

		child.on("close", (code, signal) => {
			if (failure) {
				finish({ code: -1, stdout: out, stderr: err || detail || failure, failed: failure });
				return;
			}
			if (signal) {
				finish({ code: -1, stdout: out, stderr: err || `killed by ${signal}`, failed: "signal" });
				return;
			}
			if (typeof code !== "number") {
				finish({ code: -1, stdout: out, stderr: err || "process ended without an exit code", failed: "unknown" });
				return;
			}
			finish({ code, stdout: out, stderr: err });
		});
	});
