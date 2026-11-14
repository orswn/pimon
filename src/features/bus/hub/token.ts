import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

export type TokenResult = { token: string } | { error: string; reason: "missing" | "mode" | "empty" | "unreadable" };

/** The token is a bearer secret, so a file that other users can read is refused, like a private spawn file. */
export function readHubToken(path: string): TokenResult {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stats = fstatSync(fd);
		if (!stats.isFile() || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0) {
			return {
				reason: "mode",
				error: `hub token file ${path} must be a regular file owned by this user with mode 0600`,
			};
		}
		const token = readFileSync(fd, "utf8").trim();
		if (!token) return { reason: "empty", error: `hub token file ${path} is empty` };
		return { token };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { reason: "missing", error: `no hub token: create ${path} with mode 0600` };
		return { reason: "unreadable", error: `cannot read hub token file ${path}: ${(error as Error).message}` };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
