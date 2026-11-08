import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type RoleScope = "user" | "project" | "both";
export type RoleSource = "user" | "project" | "session";

export interface Role {
	name: string;
	description: string;
	tools?: string[] | undefined;
	model?: string | undefined;
	thinking?: string | undefined;
	labels?: Record<string, string> | undefined;
	/** False adds `--no-mcp` to the child, so it starts no MCP server. */
	mcp: boolean;
	prompt: string;
	source: RoleSource;
	file: string;
}

/** One parser for role files and the spawn parameter: comma separated `key=value`, split at the first `=`. */
export function parseLabelList(raw: string | undefined): { labels: Record<string, string>; invalid: string[] } {
	const labels: Record<string, string> = {};
	const invalid: string[] = [];
	for (const part of (raw ?? "").split(",")) {
		const pair = part.trim();
		if (!pair) continue;
		const eq = pair.indexOf("=");
		const key = eq > 0 ? pair.slice(0, eq).trim() : "";
		const value = eq > 0 ? pair.slice(eq + 1).trim() : "";
		if (!key || !value) {
			invalid.push(pair);
			continue;
		}
		labels[key] = value;
	}
	return { labels, invalid };
}

function stringValue(file: string, key: string, value: unknown, problems: string[] | undefined): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value;
	if (typeof value === "number") return String(value);
	problems?.push(`${file}: ${key} must be a string`);
	return undefined;
}

export function parseRole(file: string, content: string, source: RoleSource, problems?: string[]): Role | undefined {
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch (error) {
		problems?.push(`${file}: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`);
		return undefined;
	}
	const { frontmatter, body } = parsed;
	if (!body.trim()) return undefined;
	const value = (key: string) => stringValue(file, key, frontmatter[key], problems);
	const name = value("name") || (file.split("/").pop() ?? file).replace(/\.md$/, "");
	const labelText = value("labels");
	const { labels, invalid } = parseLabelList(labelText);
	if (invalid.length > 0) problems?.push(`${file}: labels need key=value, ignored: ${invalid.join(", ")}`);
	let mcp = true;
	if (frontmatter["mcp"] !== undefined) {
		if (typeof frontmatter["mcp"] === "boolean") mcp = frontmatter["mcp"];
		else problems?.push(`${file}: mcp must be true or false, using true`);
	}
	const tools = value("tools")
		?.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	return {
		name,
		description: value("description") ?? "",
		tools,
		model: value("model"),
		thinking: value("thinking"),
		labels: Object.keys(labels).length > 0 ? labels : undefined,
		mcp,
		prompt: body,
		source,
		file,
	};
}

export function loadRoleDir(dir: string, source: RoleSource, problems?: string[]): Role[] {
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const roles: Role[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const file = join(dir, entry);
		let content: string;
		try {
			content = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const role = parseRole(file, content, source, problems);
		if (role) roles.push(role);
	}
	return roles;
}

function projectAgentsDir(cwd: string): string | undefined {
	let current = cwd;
	while (true) {
		const candidate = join(current, ".pi", "agents");
		try {
			if (statSync(candidate).isDirectory()) return candidate;
		} catch {
			// Keep walking up.
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export interface RoleSources {
	/** `<agentDir>/agents`. */
	userDir: string;
	cwd: string;
	/** Project roles are repo-controlled prompts, so they are opt in. */
	scope: RoleScope;
	sessionDir?: string | undefined;
}

export function discoverRoles(sources: RoleSources, problems?: string[]): Role[] {
	const user = sources.scope === "project" ? [] : loadRoleDir(sources.userDir, "user", problems);
	const projectDir = sources.scope === "user" ? undefined : projectAgentsDir(sources.cwd);
	const project = projectDir ? loadRoleDir(projectDir, "project", problems) : [];
	// Session roles are the most specific statement of intent, so they win the name.
	const session = sources.sessionDir ? loadRoleDir(sources.sessionDir, "session", problems) : [];
	const byName = new Map<string, Role>();
	for (const role of [...user, ...project, ...session]) byName.set(role.name, role);
	return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Exact name first, then a unique prefix. `prefix` is true when the name was completed. */
export function findRole(sources: RoleSources, name: string): { role: Role; prefix: boolean } | undefined {
	const roles = discoverRoles(sources);
	const exact = roles.find((role) => role.name === name);
	if (exact) return { role: exact, prefix: false };
	const prefixes = roles.filter((role) => role.name.startsWith(name));
	if (prefixes.length > 1) {
		throw new Error(
			`Role prefix "${name}" is ambiguous: ${prefixes.map((role) => role.name).join(", ")}. Use an exact role name.`,
		);
	}
	return prefixes[0] ? { role: prefixes[0], prefix: true } : undefined;
}

export function formatRoles(roles: Role[], userDir: string): string {
	if (roles.length === 0) return `No roles found. Create ${userDir}/<name>.md with frontmatter name and description.`;
	return roles
		.map((role) =>
			[
				`${role.name} (${role.source})`,
				role.description ? `  ${role.description}` : undefined,
				role.model ? `  model: ${role.model}` : undefined,
				role.thinking ? `  thinking: ${role.thinking}` : undefined,
				role.tools ? `  tools: ${role.tools.join(", ")}` : undefined,
				role.mcp ? undefined : "  mcp: off",
			]
				.filter(Boolean)
				.join("\n"),
		)
		.join("\n");
}
