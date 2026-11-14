import { readFileSync } from "node:fs";

export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Process start time from /proc. Two processes that reuse a pid cannot share it. */
export function pidBirth(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// Field 22 is starttime. comm may contain spaces, so cut after the last ')'.
		const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const startTime = tail[19];
		return startTime ? `${startTime}` : undefined;
	} catch {
		return undefined;
	}
}

export function sameProcess(pid: number, birth: string | undefined): boolean {
	if (!pidAlive(pid)) return false;
	if (!birth) return true;
	return pidBirth(pid) === birth;
}

/** Signalling needs a known birth: a recycled pid belongs to an unrelated process. */
export function pidLive(pid: number | undefined, birth: string | undefined): boolean {
	if (!pid || !birth || !pidAlive(pid)) return false;
	return pidBirth(pid) === birth;
}

export function pidGone(pid: number | undefined, birth: string | undefined): boolean {
	if (!pid || !pidAlive(pid)) return true;
	if (!birth) return false;
	const current = pidBirth(pid);
	return !current || current !== birth;
}
