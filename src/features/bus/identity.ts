import { randomUUID } from "node:crypto";
import { shortId } from "./protocol.ts";
import { parseLabels, sanitizeName, sessionTag, shortHost } from "./registry.ts";

/** Values read from the environment once, at the first load in this process. */
export interface LaunchEnv {
	owner?: string | undefined;
	name?: string | undefined;
	labels?: string | undefined;
	role?: string | undefined;
	parent?: string | undefined;
	team?: string | undefined;
	controlToken?: string | undefined;
	control?: string | undefined;
	wakePolicy?: string | undefined;
	debug?: string | undefined;
	dir?: string | undefined;
	agentLabel?: string | undefined;
	spawnFile?: string | undefined;
}

const SOURCES = {
	owner: "PI_BUS_OWNER",
	name: "PI_BUS_NAME",
	labels: "PI_BUS_LABELS",
	role: "PI_BUS_ROLE",
	parent: "PI_BUS_PARENT",
	team: "PI_BUS_TEAM",
	controlToken: "PI_BUS_CONTROL_TOKEN",
	control: "PI_BUS_CONTROL",
	wakePolicy: "PI_BUS_WAKE_POLICY",
	debug: "PI_BUS_DEBUG",
	dir: "PI_BUS_DIR",
	agentLabel: "PI_AGENT_LABEL",
	spawnFile: "PIMON_SPAWN_FILE",
} as const satisfies Record<keyof LaunchEnv, string>;

/** Identity keys leave the process env, so bash, background jobs, and nested pi do not inherit them. */
const DELETED_ENV_KEYS = [
	"PI_BUS_OWNER",
	"PI_BUS_NAME",
	"PI_BUS_LABELS",
	"PI_BUS_ROLE",
	"PI_BUS_PARENT",
	"PI_BUS_TEAM",
	"PI_BUS_CONTROL_TOKEN",
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

export function adoptOwner(launch: LaunchEnv): string {
	return launch.owner || randomUUID();
}

export function busLabels(launch: LaunchEnv, cwd: string | undefined): Record<string, string> {
	const labels: Record<string, string> = { ...parseLabels(launch.labels) };
	if (launch.role) labels["role"] = launch.role;
	if (launch.parent) labels["parent"] = launch.parent;
	if (launch.team) labels["team"] = launch.team;
	if (cwd) labels["cwd"] = cwd;
	return labels;
}

/** `<host>-<session tag>`, or `<role>-<session tag>` for a delegated instance. Stable across reload and resume. */
export function defaultName(
	launch: LaunchEnv,
	sessionFile: string | undefined,
	owner: string,
	host = shortHost(),
): string {
	if (launch.name) return sanitizeName(launch.name);
	const tag = sessionTag(sessionFile) || `x${shortId(owner).slice(0, 5)}`;
	return `${launch.role ? sanitizeName(launch.role) : host}-${tag}`;
}

export type WakePolicy = "all" | "parent" | "none";
export type ControlPolicy = "parent" | "any" | "none";

export function wakePolicyOf(launch: LaunchEnv): WakePolicy {
	const raw = (launch.wakePolicy || "all").toLowerCase();
	return raw === "parent" || raw === "none" ? raw : "all";
}

export function controlPolicyOf(launch: LaunchEnv): ControlPolicy {
	const raw = (launch.control || "parent").toLowerCase();
	return raw === "any" || raw === "none" ? raw : "parent";
}
