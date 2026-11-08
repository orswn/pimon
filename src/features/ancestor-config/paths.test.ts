import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { ancestorMcpServers, discoverResources, skillDirsAboveRepo } from "./paths.ts";

let root = "";
let home = "";
let ws = "";
let cwd = "";

const write = (path: string, data: unknown) => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify(data));
};

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pimon-ancestor-"));
	home = join(root, "home");
	ws = join(home, "ws");
	cwd = join(ws, "repo", "sub");
	mkdirSync(join(ws, "repo", ".git"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(ws, ".agents", "skills"), { recursive: true });
	mkdirSync(join(ws, ".pi", "prompts"), { recursive: true });
	mkdirSync(join(home, ".agents", "skills"), { recursive: true });
	write(join(ws, ".pi", "mcp.json"), {
		mcpServers: {
			shared: { command: "far" },
			remote: { url: "https://example.invalid/mcp" },
			tweak: { env: { A: "1" } },
		},
	});
	write(join(ws, "repo", ".pi", "mcp.json"), { mcpServers: { shared: { command: "near" } } });
	mkdirSync(join(root, "outside", "repo", ".git"), { recursive: true });
	mkdirSync(join(root, "outside", ".agents", "skills"), { recursive: true });
	mkdirSync(join(root, "outside", ".pi", "prompts"), { recursive: true });
	write(join(root, "outside", ".pi", "mcp.json"), { mcpServers: { planted: { command: "planted" } } });
	mkdirSync(join(root, "homeless", "repo", ".git"), { recursive: true });
	mkdirSync(join(root, "homeless", ".agents", "skills"), { recursive: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ancestor resource walk", () => {
	it("returns workspace skills and prompts above the repo for a trusted project", () => {
		expect(discoverResources(cwd, true, home)).toEqual({
			skillPaths: [join(ws, ".agents", "skills")],
			promptPaths: [join(ws, ".pi", "prompts")],
		});
	});

	it("returns nothing for an untrusted project", () => {
		expect(discoverResources(cwd, false, home)).toEqual({ skillPaths: [], promptPaths: [] });
	});

	it("stops below $HOME and needs a git repo for skills", () => {
		expect(skillDirsAboveRepo(cwd, home)).not.toContain(join(home, ".agents", "skills"));
		expect(skillDirsAboveRepo(ws, home)).toEqual([]);
	});
});

describe("a cwd outside $HOME", () => {
	it("reads no ancestor skills, prompts, or MCP servers", () => {
		const outside = join(root, "outside", "repo");
		expect(discoverResources(outside, true, home)).toEqual({ skillPaths: [], promptPaths: [] });
		expect(ancestorMcpServers(outside, home)).toEqual({ servers: new Map(), errors: [] });
	});

	it("does not treat a sibling directory with the same prefix as inside $HOME", () => {
		expect(discoverResources(join(root, "homeless", "repo"), true, home)).toEqual({ skillPaths: [], promptPaths: [] });
	});
});

describe("ancestorMcpServers", () => {
	it("lets the nearer mcp.json win and rejects override-only entries", () => {
		const { servers, errors } = ancestorMcpServers(cwd, home);
		expect(Object.fromEntries([...servers].map(([name, entry]) => [name, entry.config]))).toEqual({
			shared: { command: "near" },
			remote: { url: "https://example.invalid/mcp" },
		});
		expect(servers.get("shared")?.source).toBe(join(ws, "repo", ".pi", "mcp.json"));
		expect(errors).toEqual([
			`${join(ws, ".pi", "mcp.json")}: server "tweak" is an override, which only works in the cwd mcp.json`,
		]);
	});

	it("does not read the cwd mcp.json, which pi loads itself", () => {
		const { servers } = ancestorMcpServers(join(ws, "repo"), home);
		expect(servers.get("shared")?.config).toEqual({ command: "far" });
	});
});
