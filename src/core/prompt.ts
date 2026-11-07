import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { FeatureId, PromptInput, PromptSection } from "./feature.ts";

const SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
const RESERVED = new Set(["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"]);

export interface RenderedSection {
	name: string;
	feature: FeatureId;
	text: string;
}

/**
 * Prompt sections are rendered once per session and then reused byte for byte.
 * A section that changed between turns would cost a prompt cache miss on every change.
 */
export class PromptRegistry {
	private readonly entries: { feature: FeatureId; section: PromptSection }[] = [];
	private rendered: readonly RenderedSection[] = [];

	add(feature: FeatureId, section: PromptSection): void {
		if (!SECTION_NAME.test(section.name) || RESERVED.has(section.name)) {
			throw new Error(`invalid prompt section name "${section.name}"`);
		}
		const owner = this.entries.find((entry) => entry.section.name === section.name);
		if (owner) throw new Error(`prompt section "${section.name}" is already owned by ${owner.feature}`);
		this.entries.push({ feature, section });
	}

	render(input: PromptInput, onError: (feature: FeatureId, error: unknown) => void): readonly RenderedSection[] {
		const rendered: RenderedSection[] = [];
		for (const { feature, section } of this.entries) {
			if (!input.enabledFeatures.has(feature)) continue;
			try {
				const text = section.render(input)?.trim();
				if (text) rendered.push({ name: section.name, feature, text });
			} catch (error) {
				onError(feature, error);
			}
		}
		this.rendered = Object.freeze(rendered);
		return this.rendered;
	}

	apply(options: BuildSystemPromptOptions): void {
		options.sections ??= {};
		for (const { name, text } of this.rendered) options.sections[name] = text;
	}

	current(): readonly RenderedSection[] {
		return this.rendered;
	}
}
