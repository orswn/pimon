import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AnyModel, Api, Credential, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { defineFeature } from "../../core/feature.ts";
import { mapRawItemToModel, type ProviderJsonConfig, type RawModelItem } from "./mapping.ts";

const DEFAULT_TIMEOUT_MS = 5_000;

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** pi does not export its own JSON-with-comments parser, so strip comments here. */
export function parseJsonWithComments<T>(content: string): T {
	const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	const stripped = text.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (match, comment?: string) =>
		comment ? "" : match,
	);
	return JSON.parse(stripped) as T;
}

function readDiscoveryProviders(agentDir: string): [string, ProviderJsonConfig][] {
	let content: string;
	try {
		content = readFileSync(join(agentDir, "models.json"), "utf8");
	} catch {
		return [];
	}
	const parsed = parseJsonWithComments<{ providers?: Record<string, ProviderJsonConfig | null> }>(content);
	return Object.entries(parsed.providers ?? {}).filter((entry): entry is [string, ProviderJsonConfig] =>
		Boolean(entry[1]?.dynamicDiscovery),
	);
}

function oldCachePath(providerId: string): string {
	return join(homedir(), ".cache", "pi", "dynamic-models", `${providerId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelList(value: unknown): ProviderModelConfig[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const valid = value.every((model) => isRecord(model) && typeof model["id"] === "string");
	return valid ? (value as ProviderModelConfig[]) : undefined;
}

function readJson(path: string): unknown {
	const content = readFileSync(path, "utf8");
	return JSON.parse(content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);
}

function readOldCache(providerId: string): ProviderModelConfig[] | undefined {
	try {
		return modelList(readJson(oldCachePath(providerId)));
	} catch {
		return undefined;
	}
}

// TODO(okka): drop the store-file read when pi updates the model snapshot after the offline refresh phase.
function readStoredModels(agentDir: string, providerId: string): ProviderModelConfig[] | undefined {
	try {
		const store = readJson(join(agentDir, "models-store.json"));
		const entry = isRecord(store) ? store[providerId] : undefined;
		return isRecord(entry) ? modelList(entry["models"]) : undefined;
	} catch {
		return undefined;
	}
}

/** The list a provider shows before any refresh: pi's stored list, then the old cache. */
function baselineModels(
	agentDir: string,
	providerId: string,
	config: ProviderJsonConfig,
): ProviderModelConfig[] | undefined {
	// pi validates queued registrations after setup and rejects models without a baseUrl.
	if (!config.baseUrl) return undefined;
	// TODO(okka): remove the old cache read after one release.
	return readStoredModels(agentDir, providerId) ?? readOldCache(providerId);
}

async function builtinCatalog(providerId: string): Promise<Map<string, Model<Api>>> {
	const { getBuiltinModels, getBuiltinProviders } = await import("@earendil-works/pi-ai/providers/all");
	const builtin = getBuiltinProviders().find((id) => id === providerId);
	const models: readonly Model<Api>[] = builtin ? getBuiltinModels(builtin) : [];
	return new Map(models.map((model) => [model.id, model]));
}

function authorization(credential: Credential | undefined): string | undefined {
	if (credential?.type === "api_key") return credential.key ? `Bearer ${credential.key}` : undefined;
	if (credential?.type === "oauth") return `Bearer ${credential.access}`;
	return undefined;
}

export function discoveryEndpoint(config: ProviderJsonConfig, baseUrl: string | undefined): string {
	const options = typeof config.dynamicDiscovery === "object" ? config.dynamicDiscovery : {};
	if (options.endpoint) return options.endpoint;
	const base = (baseUrl ?? config.baseUrl ?? "").replace(/\/+$/, "");
	if (!base) throw new Error("no baseUrl configured");
	return `${base}${options.path ?? "/models"}`;
}

async function fetchModels(
	providerId: string,
	config: ProviderJsonConfig,
	context: Pick<RefreshModelsContext, "baseUrl" | "credential" | "signal">,
): Promise<ProviderModelConfig[]> {
	const options = typeof config.dynamicDiscovery === "object" ? config.dynamicDiscovery : {};
	const endpoint = discoveryEndpoint(config, context.baseUrl);
	const headers: Record<string, string> = { ...config.headers };
	const auth = authorization(context.credential);
	if (auth) headers["Authorization"] = auth;
	const signal = AbortSignal.any([context.signal, AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)]);
	const response = await fetch(endpoint, { method: "GET", headers, signal });
	if (!response.ok) throw new Error(`HTTP ${response.status} from ${endpoint}`);
	const payload: unknown = await response.json();
	const items = Array.isArray(payload) ? payload : isRecord(payload) ? payload["data"] : undefined;
	if (!Array.isArray(items)) throw new Error(`no model array in the response from ${endpoint}`);
	const catalog = await builtinCatalog(providerId);
	return (items as RawModelItem[]).map((item) => mapRawItemToModel(item, config, catalog));
}

function discoveryProvider(
	providerId: string,
	config: ProviderJsonConfig,
	baseline: ProviderModelConfig[] | undefined,
) {
	const offline = (context: RefreshModelsContext): ProviderModelConfig[] => {
		const stored = context.stored?.models;
		if (stored && stored.length > 0) return stored as unknown as ProviderModelConfig[];
		return baseline ?? [];
	};
	return {
		// pi rebuilds providers at the start of a network refresh and updates its snapshot only after the fetch, so the baseline keeps the list visible meanwhile.
		...(baseline ? { models: baseline } : {}),
		name: config.name ?? providerId,
		...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
		...(config.apiKey ? { apiKey: config.apiKey } : {}),
		api: config.api ?? "openai-completions",
		...(config.headers ? { headers: config.headers } : {}),
		...(config.compat ? { compat: config.compat } : {}),
		refreshModels: async (context: RefreshModelsContext): Promise<ProviderModelConfig[]> => {
			if (!context.allowNetwork) return offline(context);
			let models: ProviderModelConfig[];
			try {
				models = await fetchModels(providerId, config, context);
			} catch {
				return offline(context);
			}
			// Stored entries are provider model configs; pi keeps them verbatim and hands them back as `stored`.
			await context.publish({ persist: { models: models as unknown as AnyModel[], checkedAt: Date.now() } });
			return models;
		},
	};
}

export const discovery = defineFeature({
	id: "discovery",
	description: "List models of providers marked with dynamicDiscovery in models.json from their /models endpoint",
	defaultEnabled: true,
	setup(ctx) {
		let providers: [string, ProviderJsonConfig][];
		try {
			providers = readDiscoveryProviders(ctx.agentDir);
		} catch (error) {
			ctx.log.warn(`cannot read models.json: ${describe(error)}`);
			return;
		}
		for (const [providerId, config] of providers) {
			const baseline = baselineModels(ctx.agentDir, providerId, config);
			try {
				ctx.pi.registerProvider(providerId, discoveryProvider(providerId, config, baseline));
			} catch (error) {
				ctx.log.error(`cannot register provider ${providerId}`, error);
			}
		}
	},
});
