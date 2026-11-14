import { parseArgs } from "node:util";
import { parsePushAllow, TEST_AGENT_ALLOW } from "./push-guard.ts";

export interface HubConfig {
	host: string;
	port: number;
	data: string;
	tokensFile: string | undefined;
	/** External A2A agents, such as Hermes, that the hub sends tasks to. */
	externalFile: string | undefined;
	testAgents: boolean;
	publicUrl: string | undefined;
	presenceGraceMs: number;
	heartbeatMs: number;
	/** Host names, addresses, and CIDRs that push webhooks may reach although they are private. */
	pushAllow: string[];
}

export class ConfigError extends Error {}

export function parseListen(value: string): { host: string; port: number } {
	const colon = value.lastIndexOf(":");
	if (colon < 0) throw new ConfigError(`--listen must be host:port, got ${value}`);
	const host = value.slice(0, colon).replace(/^\[(.*)\]$/, "$1");
	const port = Number(value.slice(colon + 1));
	if (!host || !Number.isInteger(port) || port < 0 || port > 65535) {
		throw new ConfigError(`--listen must be host:port, got ${value}`);
	}
	return { host, port };
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new ConfigError(`${name} must be a positive integer`);
	return parsed;
}

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv): HubConfig {
	const { values } = parseArgs({
		args: argv,
		options: {
			listen: { type: "string" },
			data: { type: "string" },
			tokens: { type: "string" },
			external: { type: "string" },
			"test-agents": { type: "boolean" },
			"public-url": { type: "string" },
			"push-allow": { type: "string" },
		},
		strict: true,
	});
	const listen = parseListen(values.listen ?? env["HUB_LISTEN"] ?? "0.0.0.0:8080");
	const publicUrl = values["public-url"] ?? env["HUB_PUBLIC_URL"];
	if (publicUrl !== undefined && publicUrl !== "" && !/^https?:\/\//.test(publicUrl)) {
		throw new ConfigError("--public-url must start with http:// or https://");
	}
	const testAgents = values["test-agents"] === true || env["HUB_TEST_AGENTS"] === "1";
	let pushAllow: string[];
	try {
		pushAllow = parsePushAllow(values["push-allow"] ?? env["HUB_PUSH_ALLOW"]);
	} catch (error) {
		throw new ConfigError(error instanceof Error ? error.message : String(error));
	}
	if (testAgents) pushAllow.push(...TEST_AGENT_ALLOW);
	return {
		...listen,
		data: values.data ?? env["HUB_DATA"] ?? "/data",
		tokensFile: values.tokens ?? (env["HUB_TOKENS_FILE"] || undefined),
		externalFile: values.external ?? (env["HUB_EXTERNAL_FILE"] || undefined),
		testAgents,
		publicUrl: publicUrl ? publicUrl.replace(/\/+$/, "") : undefined,
		presenceGraceMs: positiveInt(env["HUB_PRESENCE_GRACE_MS"], 20_000, "HUB_PRESENCE_GRACE_MS"),
		heartbeatMs: positiveInt(env["HUB_HEARTBEAT_MS"], 15_000, "HUB_HEARTBEAT_MS"),
		pushAllow,
	};
}
