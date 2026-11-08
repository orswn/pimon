// Installs a copy of the repo like `pi install` does and checks each runtime import in src:
// its package is a declared dependency and it resolves in that install.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

const HOST_PACKAGES = new Set([
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-tui",
	"@earendil-works/pi-agent-core",
	"typebox",
]);

const IMPORT_PATTERNS = [
	/^\s*(?:import|export)\s+(type\s+)?[^;]*?\sfrom\s*["']([^"']+)["']/gm,
	/^\s*import\s*()["']([^"']+)["']/gm,
	/\bimport\(\s*()["']([^"']+)["']\s*\)/g,
];

interface Problem {
	specifier: string;
	reason: string;
}

const repo = join(import.meta.dirname, "..");

function runtimeFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return runtimeFiles(path);
		return /\.test\.[cm]?[jt]s$/.test(entry.name) ? [] : [path];
	});
}

function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function runtimeImports(): Map<string, string[]> {
	const found = new Map<string, string[]>();
	for (const file of runtimeFiles(join(repo, "src"))) {
		const text = readFileSync(file, "utf8");
		for (const pattern of IMPORT_PATTERNS) {
			for (const match of text.matchAll(pattern)) {
				const typeOnly = match[1];
				const specifier = match[2];
				if (typeOnly || !specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue;
				if (isBuiltin(specifier) || HOST_PACKAGES.has(packageName(specifier))) continue;
				found.set(specifier, [...(found.get(specifier) ?? []), relative(repo, file)]);
			}
		}
	}
	return found;
}

function unresolved(copy: string, specifiers: string[]): Problem[] {
	const probe = join(copy, "resolve-probe.mjs");
	writeFileSync(
		probe,
		`const problems = [];
for (const specifier of ${JSON.stringify(specifiers)}) {
	try {
		const url = import.meta.resolve(specifier);
		if (!url.startsWith(${JSON.stringify(`file://${join(copy, "node_modules")}/`)})) problems.push({ specifier, reason: "resolves outside the install: " + url });
	} catch (error) {
		problems.push({ specifier, reason: error.message });
	}
}
process.stdout.write(JSON.stringify(problems));
`,
	);
	return JSON.parse(execFileSync(process.execPath, [probe], { cwd: copy, encoding: "utf8" })) as Problem[];
}

const imports = runtimeImports();
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
	dependencies?: Record<string, string>;
};
const declared = new Set(Object.keys(manifest.dependencies ?? {}));
const problems: Problem[] = [...imports.keys()]
	.filter((specifier) => !declared.has(packageName(specifier)))
	.map((specifier) => ({ specifier, reason: `${packageName(specifier)} is not in package.json dependencies` }));

const copy = mkdtempSync(join(tmpdir(), "pimon-prod-install-"));
try {
	cpSync(repo, copy, {
		recursive: true,
		filter: (source) => !["node_modules", ".git"].includes(basename(source)),
	});
	execFileSync("npm", ["install", "--omit=dev", "--omit=peer", "--no-audit", "--no-fund"], {
		cwd: copy,
		stdio: ["ignore", "ignore", "inherit"],
	});
	problems.push(...unresolved(copy, [...imports.keys()]));
} finally {
	rmSync(copy, { recursive: true, force: true });
}

if (problems.length > 0) {
	const lines = problems.map(
		({ specifier, reason }) => `- ${specifier}: ${reason}\n  imported by ${(imports.get(specifier) ?? []).join(", ")}`,
	);
	process.stderr.write(`Runtime imports that a production install does not support:\n${lines.join("\n")}\n`);
	process.exitCode = 1;
} else {
	process.stdout.write(
		`Production install resolves ${imports.size} declared runtime import(s): ${[...imports.keys()].join(", ")}\n`,
	);
}
