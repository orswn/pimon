/**
 * Session roles that the agent writes itself, keyed by session id under the private root.
 * The file format is the same as a curated role, so promoting one is a single `mv`.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { THINKING_LEVELS } from "./runtime.ts";

/** Names become file names and bus labels. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const DAY_MS = 24 * 60 * 60_000;

interface SessionRolePatch {
	name: string;
	description?: string | undefined;
	prompt?: string | undefined;
	model?: string | undefined;
	thinking?: string | undefined;
	tools?: string | undefined;
	labels?: string | undefined;
}

interface ExistingRole {
	description: string;
	prompt: string;
	model?: string | undefined;
	thinking?: string | undefined;
	tools?: string[] | undefined;
	labels?: Record<string, string> | undefined;
}

/** One key per session, so a new session in the same process gets its own files. */
export function sessionKey(sessionId: string | undefined): string {
	const raw = sessionId?.trim() || "";
	const safe = raw.replace(/[^a-zA-Z0-9._-]/g, "");
	return safe.slice(0, 64) || "unknown";
}

export function sessionRolesDir(key: string, root: string): string {
	return join(root, key);
}

function frontmatterValue(value: string): string {
	// A colon makes the whole file unparseable, and pi's parser throws rather than degrading.
	return /^[\w][\w .,/+-]*$/.test(value) && !value.endsWith(" ") ? value : JSON.stringify(value);
}

export function renderRoleFile(role: SessionRolePatch & { prompt: string }): string {
	const lines = ["---", `name: ${frontmatterValue(role.name)}`];
	if (role.description) lines.push(`description: ${frontmatterValue(role.description)}`);
	if (role.model) lines.push(`model: ${frontmatterValue(role.model)}`);
	if (role.thinking) lines.push(`thinking: ${frontmatterValue(role.thinking)}`);
	if (role.tools) lines.push(`tools: ${frontmatterValue(role.tools)}`);
	if (role.labels) lines.push(`labels: ${frontmatterValue(role.labels)}`);
	lines.push("---", "", role.prompt.trim(), "");
	return lines.join("\n");
}

export interface DefineResult {
	file: string;
	created: boolean;
}

function normalizeRoleName(raw: string): string | undefined {
	const name = raw.trim().toLowerCase();
	return NAME_PATTERN.test(name) ? name : undefined;
}

/** Create or patch: refining one line must not need the whole prompt again. */
export function defineSessionRole(
	dir: string,
	patch: SessionRolePatch,
	existing?: ExistingRole,
): DefineResult | { error: string } {
	const name = normalizeRoleName(patch.name);
	if (!name) {
		return {
			error: `Invalid role name "${patch.name}". Use lower-case letters, digits, dot, dash or underscore, up to 32 characters.`,
		};
	}
	const prompt = patch.prompt?.trim() || existing?.prompt.trim();
	if (!prompt) return { error: `Role "${name}" does not exist yet, so prompt is required.` };
	if (patch.thinking) {
		const level = patch.thinking.trim().toLowerCase();
		if (!THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number])) {
			return { error: `Unknown thinking level "${patch.thinking}". Valid values: ${THINKING_LEVELS.join(", ")}.` };
		}
	}
	const merged = {
		name,
		description: patch.description?.trim() || existing?.description || "",
		model: patch.model?.trim() || existing?.model,
		thinking: patch.thinking?.trim().toLowerCase() || existing?.thinking,
		tools: patch.tools?.trim() || existing?.tools?.join(","),
		labels:
			patch.labels?.trim() ||
			(existing?.labels
				? Object.entries(existing.labels)
						.map(([key, value]) => `${key}=${value}`)
						.join(",")
				: undefined),
		prompt,
	};
	const file = join(dir, `${name}.md`);
	const created = !existsSync(file);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(file, renderRoleFile(merged), { encoding: "utf8", mode: 0o600 });
	return { file, created };
}

export function deleteSessionRole(dir: string, name: string): boolean {
	// The same name check as define: "../reviewer" would resolve outside the session dir.
	const safe = normalizeRoleName(name);
	if (!safe) return false;
	const file = join(dir, `${safe}.md`);
	if (!existsSync(file)) return false;
	rmSync(file, { force: true });
	return true;
}

/** Entries older than `olderThanMs` go, except `keep` and entries that `skip` accepts. Returns the count removed. */
export function pruneOld(
	root: string,
	keep?: string,
	skip?: (entry: string) => boolean,
	olderThanMs = DAY_MS,
	now = Date.now(),
): number {
	let removed = 0;
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (entry === keep || skip?.(entry)) continue;
		const path = join(root, entry);
		try {
			if (statSync(path).mtimeMs >= now - olderThanMs) continue;
			rmSync(path, { recursive: true, force: true });
			removed += 1;
		} catch {
			// Already gone.
		}
	}
	return removed;
}
