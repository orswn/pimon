import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { ancestorConfig } from "../../src/features/ancestor-config/index.ts";
import { createHarness, type Harness } from "../support/harness.ts";

// The feature reads only directories below $HOME, so the harness root must live there.
let outerTmp: string | undefined;
beforeEach(() => {
	outerTmp = process.env["TMPDIR"];
	process.env["TMPDIR"] = mkdtempSync(join(homedir(), "workspace-"));
});
afterEach(() => {
	const workspaceTmp = process.env["TMPDIR"];
	if (workspaceTmp) rmSync(workspaceTmp, { recursive: true, force: true });
	if (outerTmp === undefined) delete process.env["TMPDIR"];
	else process.env["TMPDIR"] = outerTmp;
});

/** The harness cwd becomes a repo. Its parent holds workspace skills, prompts, and an MCP server. */
function workspace(agentDir: string) {
	const root = dirname(agentDir);
	mkdirSync(join(root, "work", ".git"));
	mkdirSync(join(root, ".agents", "skills"), { recursive: true });
	mkdirSync(join(root, ".pi", "prompts"), { recursive: true });
	writeFileSync(
		join(root, ".pi", "mcp.json"),
		JSON.stringify({ mcpServers: { "workspace-docs": { command: "docs-server", args: ["--stdio"] } } }),
	);
}

describe("ancestor-config wiring", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.dispose();
	});

	const start = async (projectTrusted: boolean) => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			features: [ancestorConfig],
			projectTrusted,
			setupAgentDir: workspace,
			extensions: [
				(pi) => {
					api = pi;
					// Stands in for pi's MCP extension, so registered servers count as handled.
					pi.on("mcp_servers_change", () => undefined);
				},
			],
		});
		harnesses.push(harness);
		if (!api) throw new Error("test extension did not load");
		const discovered = await harness.session.extensionRunner.emitResourcesDiscover(harness.cwd, "startup");
		const servers = api.getMcpServers().map((server) => ({ name: server.name, config: server.config }));
		return { harness, discovered, servers };
	};

	it("an untrusted project gets no ancestor skills, prompts, or MCP servers", async () => {
		const { discovered, servers } = await start(false);
		expect(discovered.skillPaths).toEqual([]);
		expect(discovered.promptPaths).toEqual([]);
		expect(servers).toEqual([]);
	});

	it("a trusted project gets the ancestor skills and prompts and registers the ancestor MCP servers", async () => {
		const { harness, discovered, servers } = await start(true);
		const root = dirname(harness.cwd);
		expect(discovered.skillPaths.map((entry) => entry.path)).toEqual([join(root, ".agents", "skills")]);
		expect(discovered.promptPaths.map((entry) => entry.path)).toEqual([join(root, ".pi", "prompts")]);
		expect(servers).toEqual([{ name: "workspace-docs", config: { command: "docs-server", args: ["--stdio"] } }]);
		expect(harness.extensionErrors).toEqual([]);
	});
});
