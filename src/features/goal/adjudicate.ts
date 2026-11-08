// "unverified" means the check never ran to a result. It pauses the goal and never accepts it.
// Only a check command that ran to completion and exited nonzero rejects a claim.
import type { ExecFn } from "../../core/exec.ts";

type Verdict = "accepted" | "rejected" | "unverified";

interface Adjudication {
	verdict: Verdict;
	reason: string;
	/** Exit code and output tail of a rejected check. */
	code?: number;
	tail?: string;
}

const lastLines = (text: string, count: number) => text.trim().split("\n").slice(-count).join("\n");

export async function adjudicateWithCheck(params: {
	check: string;
	exec: ExecFn;
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal | undefined;
}): Promise<Adjudication> {
	try {
		const result = await params.exec("bash", ["-c", params.check], {
			cwd: params.cwd,
			timeoutMs: params.timeoutMs,
			signal: params.signal,
		});
		if (result.failed)
			return {
				verdict: "unverified",
				reason: `check command did not complete (${result.failed}): ${lastLines(result.stderr, 3) || params.check}`,
			};
		if (result.code === 0) return { verdict: "accepted", reason: `check command exited 0: ${params.check}` };
		if (typeof result.code !== "number")
			return { verdict: "unverified", reason: `check command did not report an exit code: ${params.check}` };
		const tail = lastLines(result.stderr || result.stdout || "", 6);
		return {
			verdict: "rejected",
			reason: `check command exited ${result.code}${tail ? `:\n${tail}` : ""}`,
			code: result.code,
			tail,
		};
	} catch (error) {
		return {
			verdict: "unverified",
			reason: `check command could not run: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
