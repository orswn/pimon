import { describe, expect, it } from "vite-plus/test";
import {
	canonicalModel,
	formatRuntime,
	type ModelChoice,
	type ResolvedRuntime,
	resolveModelSpec,
	resolveRuntime,
	resolveThinkingSpec,
	THINKING_LEVELS,
} from "./runtime.ts";

const AVAILABLE: ModelChoice[] = [
	{ id: "us.anthropic.claude-opus-5", provider: "bedrock", name: "Claude Opus 5" },
	{ id: "us.anthropic.claude-fable-5", provider: "bedrock", name: "Claude Fable 5" },
	{ id: "gpt-5", provider: "openai", name: "GPT-5" },
	{ id: "gpt-5", provider: "azure", name: "GPT-5 (Azure)" },
];
const OPUS = AVAILABLE[0] as ModelChoice;

const model = (spec: string) => resolveModelSpec(AVAILABLE, spec);
const errorOf = (value: object) => ("error" in value ? String(value.error) : "");
function ok(value: ResolvedRuntime | { error: string }): ResolvedRuntime {
	if ("error" in value) throw new Error(value.error);
	return value;
}

describe("model specs", () => {
	it("resolves to a canonical provider/id", () => {
		expect(canonicalModel(OPUS)).toBe("bedrock/us.anthropic.claude-opus-5");
		expect(model("openai:gpt-5")).toEqual({ model: "openai/gpt-5" });
		expect(model("OpenAI:GPT-5")).toEqual({ model: "openai/gpt-5" });
		expect(model("azure/gpt-5")).toEqual({ model: "azure/gpt-5" });
		expect(model("us.anthropic.claude-fable-5")).toEqual({ model: "bedrock/us.anthropic.claude-fable-5" });
		expect(model("fable")).toEqual({ model: "bedrock/us.anthropic.claude-fable-5" });
	});

	it("rejects a canonical spec for a provider that lacks the id", () => {
		expect(errorOf(model("bedrock/gpt-5"))).not.toBe("");
	});

	it("refuses an id on two providers and names both", () => {
		const error = errorOf(model("gpt-5"));
		expect(error).toContain("openai/gpt-5");
		expect(error).toContain("azure/gpt-5");
	});

	it("refuses ambiguous, unknown, and empty specs", () => {
		expect(errorOf(model("claude"))).toContain("ambiguous");
		expect(errorOf(model("llama-9"))).toContain("Unknown model");
		expect(errorOf(model("  "))).not.toBe("");
	});
});

describe("thinking levels", () => {
	it("knows all seven cli levels", () => {
		expect(THINKING_LEVELS).toHaveLength(7);
		expect(THINKING_LEVELS[0]).toBe("off");
		expect(THINKING_LEVELS[6]).toBe("max");
	});

	it("normalizes a valid level and refuses an invalid one", () => {
		expect(resolveThinkingSpec("HIGH")).toEqual({ thinking: "high" });
		expect(errorOf(resolveThinkingSpec("ultra"))).toContain("Valid values");
	});
});

describe("child runtime", () => {
	it("inherits the spawner's model and thinking level", () => {
		const inherited = ok(resolveRuntime({ available: AVAILABLE, currentModel: OPUS, currentThinking: "medium" }));
		expect(inherited).toEqual({
			model: "bedrock/us.anthropic.claude-opus-5",
			modelOrigin: "inherited",
			thinking: "medium",
			thinkingOrigin: "inherited",
		});
		expect(formatRuntime(inherited)).toBe(
			"model bedrock/us.anthropic.claude-opus-5 (inherited), thinking medium (inherited)",
		);
	});

	it("prefers explicit values, then the role, then inheritance", () => {
		const explicit = resolveRuntime({
			available: AVAILABLE,
			currentModel: OPUS,
			currentThinking: "medium",
			model: "fable",
			thinking: "off",
		});
		expect(explicit).toMatchObject({ model: "bedrock/us.anthropic.claude-fable-5", thinking: "off" });
		expect(explicit).toMatchObject({ thinkingOrigin: "explicit" });

		const role = resolveRuntime({
			available: AVAILABLE,
			currentModel: OPUS,
			currentThinking: "high",
			roleModel: "fable",
			roleThinking: "low",
		});
		expect(role).toMatchObject({
			model: "bedrock/us.anthropic.claude-fable-5",
			modelOrigin: "role",
			thinking: "low",
			thinkingOrigin: "role",
		});

		const override = resolveRuntime({ available: AVAILABLE, currentModel: OPUS, roleModel: "fable", model: "opus" });
		expect(override).toMatchObject({ model: "bedrock/us.anthropic.claude-opus-5", modelOrigin: "explicit" });
	});

	it("reports a bad model as an error and names the role file when the role asked for it", () => {
		expect(errorOf(resolveRuntime({ available: AVAILABLE, model: "nope" }))).not.toBe("");
		expect(errorOf(resolveRuntime({ available: AVAILABLE, roleModel: "nope" }))).toContain("role file");
	});

	it("drops an unknown inherited level without an error", () => {
		const odd = resolveRuntime({ available: AVAILABLE, currentModel: OPUS, currentThinking: "sideways" });
		expect(errorOf(odd)).toBe("");
		expect(odd).not.toHaveProperty("thinking");
	});

	it("forces nothing when no model is known", () => {
		const nothing = ok(resolveRuntime({ available: AVAILABLE }));
		expect(nothing).toEqual({});
		expect(formatRuntime(nothing)).toBe("");
	});
});
