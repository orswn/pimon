import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const featuresDir = join(import.meta.dirname, "..", "features");
const startsTurn = /\btriggerTurn\b(?!\s*:\s*false\b)/;

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
	});
}

describe("model wakes", () => {
	it("flags every triggerTurn that is not triggerTurn: false", () => {
		const flagged = [
			"{ triggerTurn: true }",
			"{ triggerTurn }",
			"{ triggerTurn: wantTurn }",
			"{ triggerTurn : true }",
			"{ triggerTurn: false }",
			"{ triggerTurn:false }",
			"{ triggerTurn: falsey }",
		].filter((source) => startsTurn.test(source));
		expect(flagged).toEqual([
			"{ triggerTurn: true }",
			"{ triggerTurn }",
			"{ triggerTurn: wantTurn }",
			"{ triggerTurn : true }",
			"{ triggerTurn: falsey }",
		]);
	});

	it("features start or steer a model run only through ctx.wake", () => {
		const offenders = sourceFiles(featuresDir)
			.filter((path) => startsTurn.test(readFileSync(path, "utf8")))
			.map((path) => relative(featuresDir, path));
		expect(offenders).toEqual([]);
	});
});
