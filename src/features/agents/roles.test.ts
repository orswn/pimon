import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	defineSessionRole,
	deleteSessionRole,
	type DefineResult,
	pruneOld,
	renderRoleFile,
	sessionKey,
	sessionRolesDir,
} from "./adhoc.ts";
import { discoverRoles, findRole, formatRoles, loadRoleDir, parseLabelList, parseRole } from "./roles.ts";

function written(result: DefineResult | { error: string }): DefineResult {
	if ("error" in result) throw new Error(result.error);
	return result;
}
const errorOf = (result: object) => ("error" in result ? String(result.error) : "");

describe("session roles", () => {
	let root: string;
	let dir: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "roles-"));
		dir = sessionRolesDir("owner1234", root);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("keys the session dir by its key", () => {
		expect(dir.endsWith("owner1234")).toBe(true);
	});

	it("writes a role and parses every field back", () => {
		const created = written(
			defineSessionRole(dir, {
				name: "migration-auditor",
				description: "Audits a schema migration",
				prompt: "You audit migrations.\nBe specific.",
				model: "bedrock/us.anthropic.claude-fable-5",
				thinking: "high",
				tools: "read,grep",
				labels: "tier=cheap",
			}),
		);
		expect(created.created).toBe(true);
		const loaded = loadRoleDir(dir, "session");
		expect(loaded.map((role) => role.name)).toEqual(["migration-auditor"]);
		expect(loaded[0]).toMatchObject({
			name: "migration-auditor",
			description: "Audits a schema migration",
			model: "bedrock/us.anthropic.claude-fable-5",
			thinking: "high",
			tools: ["read", "grep"],
			labels: { tier: "cheap" },
			source: "session",
			mcp: true,
		});
		expect(loaded[0]?.prompt).toContain("You audit migrations.");
		expect(loaded[0]?.prompt).toContain("Be specific.");
	});

	it("patches one field and keeps the rest", () => {
		defineSessionRole(dir, {
			name: "migration-auditor",
			prompt: "You audit migrations.",
			model: "bedrock/us.anthropic.claude-fable-5",
			tools: "read,grep",
			labels: "tier=cheap",
		});
		const existing = loadRoleDir(dir, "session")[0];
		const patched = written(defineSessionRole(dir, { name: "migration-auditor", thinking: "max" }, existing));
		expect(patched.created).toBe(false);
		expect(loadRoleDir(dir, "session")[0]).toMatchObject({
			thinking: "max",
			model: "bedrock/us.anthropic.claude-fable-5",
			tools: ["read", "grep"],
			labels: { tier: "cheap" },
		});
		expect(loadRoleDir(dir, "session")[0]?.prompt).toContain("You audit migrations.");
	});

	it("refuses a missing prompt, a bad name, and a bad thinking level", () => {
		expect(errorOf(defineSessionRole(dir, { name: "brand-new" }))).toContain("prompt is required");
		expect(errorOf(defineSessionRole(dir, { name: "Bad Name!", prompt: "x" }))).toContain("Invalid role name");
		expect(errorOf(defineSessionRole(dir, { name: "ok-name", prompt: "x", thinking: "ultra" }))).toContain(
			"Valid values",
		);
		expect(errorOf(defineSessionRole(dir, { name: "-x", prompt: "y" }))).not.toBe("");
	});

	it("deletes only a session role inside the session dir", () => {
		defineSessionRole(dir, { name: "migration-auditor", prompt: "x" });
		expect(deleteSessionRole(dir, "migration-auditor")).toBe(true);
		expect(existsSync(join(dir, "migration-auditor.md"))).toBe(false);
		expect(deleteSessionRole(dir, "migration-auditor")).toBe(false);

		defineSessionRole(dir, { name: "keeper", prompt: "keep me" });
		mkdirSync(join(root, "agents"), { recursive: true });
		writeFileSync(join(root, "agents", "curated.md"), "---\nname: curated\n---\nbody\n");
		expect(deleteSessionRole(dir, "../../agents/curated")).toBe(false);
		expect(existsSync(join(root, "agents", "curated.md"))).toBe(true);
		expect(deleteSessionRole(dir, "/etc/passwd")).toBe(false);
		expect(existsSync(join(dir, "keeper.md"))).toBe(true);
	});

	it("quotes yaml-looking text so the role still parses", () => {
		const tricky = written(
			defineSessionRole(dir, { name: "tricky", description: "has: a colon", prompt: "---\nname: fake\n---\nbody" }),
		);
		expect(readFileSync(tricky.file, "utf8")).toContain('description: "has: a colon"');
		expect(loadRoleDir(dir, "session").find((role) => role.name === "tricky")?.description).toBe("has: a colon");
		expect(renderRoleFile({ name: "n", prompt: "p" }).startsWith("---\nname: n\n---")).toBe(true);
	});

	it("reports a malformed role file and still loads the others", () => {
		defineSessionRole(dir, { name: "tricky", prompt: "fine" });
		writeFileSync(join(dir, "broken.md"), "---\ndescription: has: a colon\n---\nbody\n");
		const problems: string[] = [];
		const survivors = loadRoleDir(dir, "session", problems);
		expect(survivors.map((role) => role.name)).toEqual(["tricky"]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("broken.md");
	});

	it("refuses an ambiguous prefix and reports a completed one", () => {
		defineSessionRole(dir, { name: "reviewer", prompt: "review" });
		defineSessionRole(dir, { name: "reviewer-secure", prompt: "review securely" });
		defineSessionRole(dir, { name: "explorer", prompt: "explore" });
		const sources = { userDir: join(root, "none"), cwd: root, scope: "user" as const, sessionDir: dir };
		expect(() => findRole(sources, "review")).toThrow("ambiguous");
		expect(findRole(sources, "reviewer")).toMatchObject({ role: { name: "reviewer" }, prefix: false });
		expect(findRole(sources, "expl")).toMatchObject({ role: { name: "explorer" }, prefix: true });
	});

	it("lets a session role win the name over a user role", () => {
		const userDir = join(root, "agents");
		mkdirSync(userDir);
		writeFileSync(join(userDir, "worker.md"), "---\nname: worker\ndescription: curated\n---\nuser\n");
		defineSessionRole(dir, { name: "worker", description: "session", prompt: "session" });
		const roles = discoverRoles({ userDir, cwd: root, scope: "user", sessionDir: dir });
		expect(roles.map((role) => [role.name, role.source])).toEqual([["worker", "session"]]);
	});
});

describe("session role keys", () => {
	it("keys by session, not by process", () => {
		expect(sessionKey("sess-a")).not.toBe(sessionKey("sess-b"));
		expect(sessionKey("../../etc")).not.toContain("/");
		expect(sessionKey("")).toBe("unknown");
		expect(sessionKey(undefined)).toBe("unknown");
		expect(sessionKey("x".repeat(200))).toHaveLength(64);
	});
});

describe("pruning old per-session and per-spawn files", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prune-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("removes entries older than a day and keeps fresh ones and the kept key", () => {
		const old = join(root, "deadsession");
		const mine = join(root, "mysession");
		const fresh = join(root, "fresh.json");
		defineSessionRole(old, { name: "leftover", prompt: "x" });
		defineSessionRole(mine, { name: "current", prompt: "y" });
		writeFileSync(fresh, "{}");
		const dayAgo = (Date.now() - 25 * 60 * 60_000) / 1000;
		utimesSync(old, dayAgo, dayAgo);
		utimesSync(mine, dayAgo, dayAgo);
		expect(pruneOld(root, "mysession")).toBe(1);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(mine)).toBe(true);
		expect(existsSync(fresh)).toBe(true);
		expect(pruneOld(join(root, "nope"))).toBe(0);
	});
});

describe("role files", () => {
	it("parses labels with one parser for role files and the spawn parameter", () => {
		expect(parseLabelList("tier=cheap, team = core ,url=a=b")).toEqual({
			labels: { tier: "cheap", team: "core", url: "a=b" },
			invalid: [],
		});
		expect(parseLabelList("bad,=x,y=")).toEqual({ labels: {}, invalid: ["bad", "=x", "y="] });
		const problems: string[] = [];
		const role = parseRole("/r/x.md", "---\nname: x\nlabels: tier=cheap,oops\n---\nbody\n", "user", problems);
		expect(role?.labels).toEqual({ tier: "cheap" });
		expect(problems).toEqual(["/r/x.md: labels need key=value, ignored: oops"]);
	});

	it("reads mcp false and shows it in the roles list", () => {
		const off = parseRole("/r/quiet.md", "---\nname: quiet\nmcp: false\n---\nbody\n", "user");
		const on = parseRole("/r/loud.md", "---\nname: loud\n---\nbody\n", "user");
		expect(off?.mcp).toBe(false);
		expect(on?.mcp).toBe(true);
		const listed = formatRoles(
			[off, on].filter((role) => role !== undefined),
			"/r",
		);
		expect(listed).toContain("quiet (user)\n  mcp: off");
		expect(listed).not.toContain("loud (user)\n  mcp");
	});

	it("warns about a bad mcp value and keeps the default", () => {
		const problems: string[] = [];
		const role = parseRole("/r/odd.md", "---\nname: odd\nmcp: sometimes\n---\nbody\n", "user", problems);
		expect(role?.mcp).toBe(true);
		expect(problems).toEqual(["/r/odd.md: mcp must be true or false, using true"]);
	});

	it("skips a role without a body", () => {
		expect(parseRole("/r/empty.md", "---\nname: empty\n---\n\n", "user")).toBeUndefined();
	});
});
