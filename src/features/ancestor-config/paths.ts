import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Pi stops the `.agents/skills` walk at the git repo root and reads `mcp.json` only from the
// cwd. This continues both walks up to but excluding $HOME, so workspace-level skills and MCP
// servers load inside any repo or worktree nested under the workspace.

export type ServerConfig = Parameters<ExtensionAPI["registerMcpServer"]>[1];

// A cwd outside $HOME gets nothing: ancestors such as /tmp can be written by other users.
function ancestorsBelowHome(start: string, home: string): string[] {
	const stop = resolve(home);
	const fromHome = relative(stop, resolve(start));
	if (fromHome === "" || fromHome.startsWith("..") || isAbsolute(fromHome)) return [];
	const dirs: string[] = [];
	for (let dir = resolve(start); dir !== stop && dirname(dir) !== dir; dir = dirname(dir)) dirs.push(dir);
	return dirs;
}

function findGitRepoRoot(start: string): string | undefined {
	for (let dir = start; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return undefined;
	}
}

export function skillDirsAboveRepo(cwd: string, home = homedir()): string[] {
	const repoRoot = findGitRepoRoot(resolve(cwd));
	if (!repoRoot) return [];
	return ancestorsBelowHome(dirname(repoRoot), home)
		.map((dir) => join(dir, ".agents", "skills"))
		.filter(existsSync);
}

// Pi already loads the cwd prompts. A nearer directory loads first, so it wins a name clash.
export function ancestorPromptDirs(cwd: string, home = homedir()): string[] {
	return ancestorsBelowHome(dirname(resolve(cwd)), home)
		.map((dir) => join(dir, CONFIG_DIR_NAME, "prompts"))
		.filter(existsSync);
}

/** Ancestor skills and prompts can steer the model, so both need a trusted project, like pi's own walk. */
export function discoverResources(cwd: string, trusted: boolean, home = homedir()) {
	if (!trusted) return { skillPaths: [], promptPaths: [] };
	return { skillPaths: skillDirsAboveRepo(cwd, home), promptPaths: ancestorPromptDirs(cwd, home) };
}

// A nearer file wins on name clashes, and the cwd `mcp.json` still overrides all of them.
export function ancestorMcpServers(cwd: string, home = homedir()) {
	const servers = new Map<string, { config: ServerConfig; source: string }>();
	const errors: string[] = [];
	const files = ancestorsBelowHome(dirname(resolve(cwd)), home)
		.map((dir) => join(dir, CONFIG_DIR_NAME, "mcp.json"))
		.filter(existsSync);
	for (const file of files) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> };
			for (const [name, config] of Object.entries(parsed?.mcpServers ?? {})) {
				if (servers.has(name)) continue;
				if (!config["command"] && !config["url"] && !config["type"]) {
					errors.push(`${file}: server "${name}" is an override, which only works in the cwd mcp.json`);
					continue;
				}
				servers.set(name, { config: config as unknown as ServerConfig, source: file });
			}
		} catch (error) {
			errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { servers, errors };
}
