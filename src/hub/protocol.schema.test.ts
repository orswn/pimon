import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { renderHubSchema, SCHEMA_FILE } from "../../scripts/hub-schema.ts";
import { PROTOCOL } from "../../test/support/hub-process.ts";
import { HUB_PROTOCOL } from "./protocol.ts";
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

	it("gives the contract suite the protocol of this hub", () => {
		expect(PROTOCOL).toBe(HUB_PROTOCOL);
	});

	it("keeps the contract suite free of value imports from src", () => {
		for (const file of ["test/support/hub-process.ts", "test/contract/hub-contract.test.ts"]) {
			const text = readFileSync(join(repo, file), "utf8");
			const imports = [...text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)];
			expect(imports.length, file).toBeGreaterThan(0);
			const values = imports.filter((match) => !match[1] && /\/src\//.test(match[2] ?? "")).map((match) => match[2]);
			expect(values, file).toEqual([]);
		}
	});
});
