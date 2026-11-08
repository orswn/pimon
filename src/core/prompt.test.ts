import { describe, expect, it } from "vite-plus/test";
import { PromptRegistry } from "./prompt.ts";

const input = (enabled: string[]) => ({ cwd: "/w", enabledFeatures: new Set(enabled) });

describe("PromptRegistry", () => {
	it("rejects pi section names and duplicate owners", () => {
		const registry = new PromptRegistry();
		expect(() => registry.add("a", { name: "addendum", render: () => "x" })).toThrow(/invalid/);
		expect(() => registry.add("a", { name: "Bad Name", render: () => "x" })).toThrow(/invalid/);
		registry.add("a", { name: "jobs", render: () => "x" });
		expect(() => registry.add("b", { name: "jobs", render: () => "y" })).toThrow(/already owned by a/);
	});

	it("renders enabled features in registration order and skips empty text", () => {
		const registry = new PromptRegistry();
		registry.add("a", { name: "first", render: ({ cwd }) => ` A ${cwd} ` });
		registry.add("b", { name: "second", render: () => "B" });
		registry.add("c", { name: "empty", render: () => "  " });
		const errors: string[] = [];
		const rendered = registry.render(input(["a", "c"]), (feature) => errors.push(feature));
		expect(rendered).toEqual([{ name: "first", feature: "a", text: "A /w" }]);
		expect(errors).toEqual([]);
	});

	it("reports a throwing section and keeps the others", () => {
		const registry = new PromptRegistry();
		registry.add("a", {
			name: "bad",
			render: () => {
				throw new Error("boom");
			},
		});
		registry.add("b", { name: "good", render: () => "ok" });
		const errors: string[] = [];
		expect(registry.render(input(["a", "b"]), (feature) => errors.push(feature)).map((s) => s.name)).toEqual(["good"]);
		expect(errors).toEqual(["a"]);
	});

	it("skips a section when none of its required tools is active", () => {
		const registry = new PromptRegistry();
		registry.add("a", { name: "needs_x", requiresTools: ["x"], render: () => "X" });
		registry.add("a", { name: "needs_y_or_z", requiresTools: ["y", "z"], render: () => "YZ" });
		registry.add("a", { name: "plain", render: () => "P" });
		const rendered = registry.render(input(["a"]), () => {}, new Set(["z"]));
		expect(rendered.map((section) => section.name)).toEqual(["needs_y_or_z", "plain"]);
	});

	it("applies the same text on every call", () => {
		const registry = new PromptRegistry();
		let calls = 0;
		registry.add("a", { name: "count", render: () => `call ${++calls}` });
		registry.render(input(["a"]), () => {});
		const first: { sections: Record<string, string> } = { sections: {} };
		const second: { sections: Record<string, string> } = { sections: {} };
		registry.apply(first as never);
		registry.apply(second as never);
		expect(first.sections).toEqual({ count: "call 1" });
		expect(second.sections).toEqual(first.sections);
	});
});
