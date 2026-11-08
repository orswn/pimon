import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import type { FeatureId, PromptInput, PromptSection } from "./feature.ts";

const SECTION_NAME = /^[a-z][a-z0-9_-]*$/;
const RESERVED = new Set(["preamble", "tools", "rules", "docs", "addendum", "project_context", "skills", "cwd"]);

export interface RenderedSection {
	name: string;
	feature: FeatureId;
	text: string;
	requiresTools: readonly string[] | undefined;
}

/**
 * Prompt sections are rendered once per session and then reused byte for byte.
 * A section that changed between turns would cost a prompt cache miss on every change.
 * Only the choice of sections follows the active tools. A dropped or re-added section goes in the same system update as the tool change, so it adds no cache miss.
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

	render(input: PromptInput, onError: (feature: FeatureId, error: unknown) => void): void {
		const rendered: RenderedSection[] = [];
		for (const { feature, section } of this.entries) {
			if (!input.enabledFeatures.has(feature)) continue;
			try {
				const text = section.render(input)?.trim();
				if (text) rendered.push({ name: section.name, feature, text, requiresTools: section.requiresTools });
			} catch (error) {
				onError(feature, error);
			}
		}
		this.rendered = Object.freeze(rendered);
	}

	apply(options: BuildSystemPromptOptions, activeTools: ReadonlySet<string>): void {
		options.sections ??= {};
		for (const { name, text } of this.current(activeTools)) options.sections[name] = text;
	}

	/** Sections whose required tools include at least one active tool. */
	current(activeTools: ReadonlySet<string>): readonly RenderedSection[] {
		return this.rendered.filter(
			(section) => !section.requiresTools || section.requiresTools.some((tool) => activeTools.has(tool)),
		);
	}
}
