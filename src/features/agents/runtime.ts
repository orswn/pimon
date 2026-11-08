/** Model and thinking level for a child. Inheritance is the default: a child on the settings default model is a silent downgrade. */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevelSpec = (typeof THINKING_LEVELS)[number];

export interface ModelChoice {
	id: string;
	provider: string;
	name?: string | undefined;
}

export type Origin = "explicit" | "role" | "inherited";

export interface ResolvedRuntime {
	model?: string;
	modelOrigin?: Origin;
	thinking?: string;
	thinkingOrigin?: Origin;
}

export function canonicalModel(model: ModelChoice): string {
	return `${model.provider}/${model.id}`;
}

/** Canonical, provider-qualified, exact id, then a substring. Ambiguity is an error, never a silent first match. */
export function resolveModelSpec(available: ModelChoice[], spec: string): { model: string } | { error: string } {
	const wanted = spec.trim();
	if (!wanted) return { error: "Model spec is empty." };
	const lower = wanted.toLowerCase();

	const canonicalHit = available.find((model) => canonicalModel(model).toLowerCase() === lower);
	if (canonicalHit) return { model: canonicalModel(canonicalHit) };

	const colon = wanted.indexOf(":");
	if (colon > 0) {
		const provider = wanted.slice(0, colon).toLowerCase();
		const id = wanted.slice(colon + 1).toLowerCase();
		const hit = available.find((model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === id);
		if (hit) return { model: canonicalModel(hit) };
	}

	const byId = available.filter((model) => model.id.toLowerCase() === lower);
	if (byId.length === 1 && byId[0]) return { model: canonicalModel(byId[0]) };
	if (byId.length > 1) {
		return {
			error: `Model "${wanted}" exists on several providers: ${byId.map(canonicalModel).join(", ")}. Use one of those.`,
		};
	}

	const fuzzy = available.filter(
		(model) => model.id.toLowerCase().includes(lower) || (model.name ?? "").toLowerCase().includes(lower),
	);
	if (fuzzy.length === 1 && fuzzy[0]) return { model: canonicalModel(fuzzy[0]) };
	if (fuzzy.length > 1) {
		const shown = fuzzy.slice(0, 6).map(canonicalModel).join(", ");
		return { error: `Model "${wanted}" is ambiguous: ${shown}${fuzzy.length > 6 ? ", …" : ""}. Be more specific.` };
	}
	return { error: `Unknown model "${wanted}". It must match one of the models this session can use.` };
}

export function resolveThinkingSpec(spec: string): { thinking: string } | { error: string } {
	const wanted = spec.trim().toLowerCase();
	if (!THINKING_LEVELS.includes(wanted as ThinkingLevelSpec)) {
		return { error: `Unknown thinking level "${spec}". Valid values: ${THINKING_LEVELS.join(", ")}.` };
	}
	return { thinking: wanted };
}

export interface RuntimeRequest {
	model?: string | undefined;
	thinking?: string | undefined;
	roleModel?: string | undefined;
	roleThinking?: string | undefined;
	currentModel?: ModelChoice | undefined;
	currentThinking?: string | undefined;
	available: ModelChoice[];
}

/** Explicit beats the role, the role beats inheritance. A role that names a model states a requirement. */
export function resolveRuntime(request: RuntimeRequest): ResolvedRuntime | { error: string } {
	const resolved: ResolvedRuntime = {};

	const modelSpec = request.model?.trim() || request.roleModel?.trim();
	const modelOrigin: Origin = request.model?.trim() ? "explicit" : "role";
	if (modelSpec) {
		const hit = resolveModelSpec(request.available, modelSpec);
		if ("error" in hit) return { error: `${hit.error}${modelOrigin === "role" ? " The role file requested it." : ""}` };
		resolved.model = hit.model;
		resolved.modelOrigin = modelOrigin;
	} else if (request.currentModel) {
		resolved.model = canonicalModel(request.currentModel);
		resolved.modelOrigin = "inherited";
	}

	const thinkingSpec = request.thinking?.trim() || request.roleThinking?.trim();
	const thinkingOrigin: Origin = request.thinking?.trim() ? "explicit" : "role";
	if (thinkingSpec) {
		const hit = resolveThinkingSpec(thinkingSpec);
		if ("error" in hit) return { error: hit.error };
		resolved.thinking = hit.thinking;
		resolved.thinkingOrigin = thinkingOrigin;
	} else if (request.currentThinking) {
		const hit = resolveThinkingSpec(request.currentThinking);
		// An unknown level from the host is not the caller's fault: inherit nothing.
		if (!("error" in hit)) {
			resolved.thinking = hit.thinking;
			resolved.thinkingOrigin = "inherited";
		}
	}

	return resolved;
}

export function formatRuntime(resolved: ResolvedRuntime): string {
	const parts: string[] = [];
	if (resolved.model) parts.push(`model ${resolved.model} (${resolved.modelOrigin})`);
	if (resolved.thinking) parts.push(`thinking ${resolved.thinking} (${resolved.thinkingOrigin})`);
	return parts.join(", ");
}
