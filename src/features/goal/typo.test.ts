import { describe, expect, it } from "vite-plus/test";
import { typoVerb } from "./index.ts";

describe("typo guard", () => {
	it.each([
		["l resume", "resume"],
		["pause now", "pause"],
		["just stop it", "stop"],
	])("%s looks like a verb", (input, verb) => {
		expect(typoVerb(input)).toBe(verb);
	});
	it.each(["pause the server now please", "ship it", "resumes", "make the tests pass"])("%s is goal text", (input) => {
		expect(typoVerb(input)).toBeUndefined();
	});
});
