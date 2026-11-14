import { createHash } from "node:crypto";
import { hostname } from "node:os";

/** Values read from the environment once, at the first load in this process. */
export interface LaunchEnv {
	name?: string | undefined;
	labels?: string | undefined;
	role?: string | undefined;
	parent?: string | undefined;
	team?: string | undefined;
	control?: string | undefined;
	wakePolicy?: string | undefined;
	debug?: string | undefined;
}

const SOURCES = {
	name: "PI_BUS_NAME",
	labels: "PI_BUS_LABELS",
	role: "PI_BUS_ROLE",
	parent: "PI_BUS_PARENT",
	team: "PI_BUS_TEAM",
	control: "PI_BUS_CONTROL",
	wakePolicy: "PI_BUS_WAKE_POLICY",
	debug: "PI_BUS_DEBUG",
} as const satisfies Record<keyof LaunchEnv, string>;

/**
 * Identity keys leave the process env, so bash, background jobs, and nested pi do not inherit them.
 * Keys of earlier versions stay in the list, so an old parent's env does not leak into this process's children.
 */
const DELETED_ENV_KEYS = [
	"PI_BUS_OWNER",
	"PI_BUS_NAME",
	"PI_BUS_LABELS",
	"PI_BUS_ROLE",
	"PI_BUS_PARENT",
	"PI_BUS_TEAM",
	"PI_BUS_CONTROL_TOKEN",
	"PI_BUS_DIR",
	"PI_AGENT_LABEL",
	"PI_AGENTS_TOOLS",
	"PIMON_SPAWN_FILE",
] as const;

export function readLaunchEnv(env: NodeJS.ProcessEnv): LaunchEnv {
	const launch: LaunchEnv = {};
	for (const [key, name] of Object.entries(SOURCES) as [keyof LaunchEnv, string][]) {
		const value = env[name];
		if (value !== undefined) launch[key] = value;
	}
	return launch;
}

export function deleteIdentityEnv(env: NodeJS.ProcessEnv): void {
	for (const key of DELETED_ENV_KEYS) delete env[key];
}

export function sanitizeName(raw: string): string {
	const cleaned = (raw || "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 40);
	return cleaned || "pi";
}

export function shortHost(): string {
	return sanitizeName(hostname().split(".")[0] || "host");
}

export function parseLabels(raw: string | undefined): Record<string, string> {
	const labels: Record<string, string> = {};
	if (!raw) return labels;
	for (const pair of raw.split(/[,\s]+/)) {
		if (!pair) continue;
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		const key = pair.slice(0, eq).trim();
		const value = pair.slice(eq + 1).trim();
		if (key && value) labels[key] = value;
	}
	return labels;
}

export function formatLabels(labels: Record<string, string>): string {
	return Object.entries(labels)
		.map(([key, value]) => `${key}=${value}`)
		.join(",");
}

/** First hex of sha256 of the session id. Earlier versions hashed the same id from the session file name. */
export function sessionTag(sessionId: string, width = 6): string {
	return createHash("sha256").update(sessionId).digest("hex").slice(0, width);
}

/** Labels from the env. Role and parent are separate hub fields. */
export function busLabels(launch: LaunchEnv): Record<string, string> {
	const labels: Record<string, string> = { ...parseLabels(launch.labels) };
	if (launch.team) labels["team"] = launch.team;
	return labels;
}

/**
 * `PI_BUS_NAME`, then the session name, then `<role>-<tag>` for a delegated instance, else `<host>-<tag>`.
 * Stable across reload and resume.
 */
export function defaultName(
	options: { name?: string | undefined; sessionName?: string | undefined; role?: string | undefined },
	sessionId: string,
	host = shortHost(),
): string {
	if (options.name) return sanitizeName(options.name);
	if (options.sessionName) return sanitizeName(options.sessionName);
	return `${options.role ? sanitizeName(options.role) : host}-${sessionTag(sessionId)}`;
}

export type WakePolicy = "all" | "parent" | "none";
export type ControlPolicy = "parent" | "none";

export function wakePolicyOf(launch: LaunchEnv): WakePolicy {
	const raw = (launch.wakePolicy || "all").toLowerCase();
	return raw === "parent" || raw === "none" ? raw : "all";
}

/** `any` reads as `parent`: the hub forwards a close only from the parent. */
export function controlPolicyOf(launch: LaunchEnv): ControlPolicy {
	return (launch.control || "parent").toLowerCase() === "none" ? "none" : "parent";
}
