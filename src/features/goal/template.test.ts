import { describe, expect, it } from "vite-plus/test";
import { expandGoalTemplate, goalTemplateCompletions } from "./template.ts";

const files: Record<string, string> = {
	"/p/deliver.md": '---\ndescription: Deliver\nargument-hint: "[task]"\n---\nDeliver it.\n${@:-no task}\n',
	"/p/plain.md": "Fix $1 in ${2:-core}. All: $@",
};
const commands = [
	{ name: "deliver", source: "prompt", sourceInfo: { path: "/p/deliver.md" } },
	{ name: "plain", source: "prompt", sourceInfo: { path: "/p/plain.md" } },
	{ name: "goal", source: "extension", sourceInfo: { path: "/x/goal.ts" } },
];
const read = (path: string) => files[path] ?? "";

describe("prompt template conditions", () => {
	it("drops the frontmatter and uses the default without args", () => {
		expect(expandGoalTemplate("/deliver", commands, read)).toEqual({
			condition: "Deliver it.\nno task",
			template: "deliver",
		});
	});
	it("fills $@ with the args", () => {
		expect(expandGoalTemplate("/deliver ENG-12 fix login", commands, read).condition).toBe(
			"Deliver it.\nENG-12 fix login",
		);
	});
	it("follows pi for quoted args and positional defaults", () => {
		expect(expandGoalTemplate('/plain "the parser"', commands, read).condition).toBe(
			"Fix the parser in core. All: the parser",
		);
	});
	it("leaves plain text, an unknown /name, and an extension command unchanged", () => {
		expect(expandGoalTemplate("tests pass", commands, read).condition).toBe("tests pass");
		expect(expandGoalTemplate("/tmp/x exists", commands, read).template).toBeUndefined();
		expect(expandGoalTemplate("/goal x", commands, read).condition).toBe("/goal x");
	});
	it("lists only prompt templates for a bare /", () => {
		expect((goalTemplateCompletions("/", commands) ?? []).map((item) => item.value)).toEqual(["/deliver ", "/plain "]);
	});
	it("matches a substring and narrows by prefix", () => {
		expect((goalTemplateCompletions("/ain", commands) ?? []).map((item) => item.label)).toEqual(["plain"]);
		expect((goalTemplateCompletions("/pl", commands) ?? []).map((item) => item.label)).toEqual(["plain"]);
	});
	it("offers no completion after the name, for plain text, or with no match", () => {
		expect(goalTemplateCompletions("/deliver x", commands)).toBeNull();
		expect(goalTemplateCompletions("tests pass", commands)).toBeNull();
		expect(goalTemplateCompletions("/zzz", commands)).toBeNull();
	});
});
