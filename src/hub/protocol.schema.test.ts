import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { renderHubSchema, SCHEMA_FILE } from "../../scripts/hub-schema.ts";
import * as S from "./protocol.schema.ts";

const repo = join(import.meta.dirname, "../..");

describe("hub protocol schema", () => {
	it("titles each schema with its export name", () => {
		for (const [name, schema] of Object.entries(S)) expect((schema as { title?: string }).title, name).toBe(name);
	});

	it("matches the committed JSON Schema file", () => {
		expect(readFileSync(SCHEMA_FILE, "utf8"), "run: npm run schema").toBe(renderHubSchema());
	});

	it("resolves each $ref to a definition", () => {
		const document = JSON.parse(renderHubSchema()) as { $defs: Record<string, unknown> };
		const refs = [...JSON.stringify(document).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)].map((match) => match[1]);
		expect(refs.length).toBeGreaterThan(0);
		for (const name of refs) expect(Object.keys(document.$defs)).toContain(name);
	});

	it("finds static, dynamic, and require imports of src/hub", () => {
		const text = [
			'import type { AgentInfo } from "../../src/hub/protocol.ts";',
			'import { HUB_PROTOCOL } from "../../src/hub/protocol.ts";',
			"\timport { startHub } from '../../src/hub/server.ts';",
			'export { startHub } from "../../src/hub/server.ts";',
			'const dyn = () => import("../../src/hub/server.ts");',
			"const req = require('../../src/hub/db.ts');",
			'import { bus } from "../../src/features/bus/index.ts";',
		].join("\n");
		expect(hubValueImports("test/integration/x.test.ts", text)).toEqual([
			"../../src/hub/protocol.ts",
			"../../src/hub/server.ts",
			"../../src/hub/server.ts",
			"../../src/hub/server.ts",
			"../../src/hub/db.ts",
		]);
	});

	it("keeps tests outside the hub free of value imports from src/hub, so they can run against HUB_BIN", () => {
		const ownHubTests = /^src\/hub\//;
		const files = ["src", "test"]
			.flatMap((root) =>
				readdirSync(join(repo, root), { recursive: true, encoding: "utf8" }).map((file) => `${root}/${file}`),
			)
			.filter((file) => file.endsWith(".test.ts") || /^test\/support\/[^/]+\.ts$/.test(file))
			.filter((file) => !ownHubTests.test(file));
		expect(files).toContain("test/support/hub.ts");
		expect(files).toContain("test/integration/bus.test.ts");
		expect(files).toContain("test/process/bus-hub-client.test.ts");
		const found = files.flatMap((file) =>
			hubValueImports(file, readFileSync(join(repo, file), "utf8")).map((source) => `${file}: ${source}`),
		);
		expect(found).toEqual([]);
	});
});

/** Relative sources of value imports that resolve into `src/hub/`: static, re-export, dynamic, and require. */
function hubValueImports(file: string, text: string): string[] {
	const statics = [...text.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm)]
		.filter((match) => !match[1])
		.map((match) => ({ index: match.index, source: match[2] ?? "" }));
	const calls = [...text.matchAll(/\b(?:import|require)\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((match) => ({
		index: match.index,
		source: match[1] ?? "",
	}));
	return [...statics, ...calls]
		.sort((a, b) => a.index - b.index)
		.map((entry) => entry.source)
		.filter(
			(source) => source.startsWith(".") && relative(repo, resolve(repo, dirname(file), source)).startsWith("src/hub/"),
		);
}
