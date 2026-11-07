import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";

const root = mkdtempSync(join(tmpdir(), "pimon-bg-e2e-"));
const extension = join(import.meta.dirname, "../../src/index.ts");
const model = process.env["PI_TEST_MODEL"] ?? "openai-codex/gpt-5.4-mini";

afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Run {
	code: number | null;
	out: string;
	err: string;
}

function runPi(prompt: string, label: string): Promise<Run> {
	const work = join(root, `work-${label}`);
	mkdirSync(work, { recursive: true });
	return new Promise((resolve) => {
		const child = spawn("pi", ["-p", "--no-extensions", "-e", extension, "--model", model, prompt], {
			cwd: work,
			env: {
				...process.env,
				PI_CODING_AGENT_SESSION_DIR: join(root, "sessions", label),
				PI_BUS_DIR: join(root, `bus-${label}`),
				PI_BACKGROUND_DIR: join(root, `state-${label}`),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
		child.on("close", (code) => resolve({ code, out, err }));
	});
}

interface Entry {
	type?: string;
	customType?: string;
	message?: { customType?: string; content?: Array<{ type?: string; name?: string; toolName?: string }> | string };
}

function sessionEntries(label: string): Entry[] {
	const files: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".jsonl")) files.push(full);
		}
	};
	try {
		walk(join(root, "sessions", label));
	} catch {
		return [];
	}
	return files
		.flatMap((file) => readFileSync(file, "utf8").split("\n"))
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Entry];
			} catch {
				return [];
			}
		});
}

describe.concurrent("background and monitor through a real pi", () => {
	it("loads the feature and runs a background job to completion", async () => {
		const run = await runPi(
			[
				"Use the background tool only. Do not use bash for this.",
				'Step 1: background action=start name=e2e1 command="echo MARKER_ALPHA; sleep 2; echo MARKER_OMEGA; exit 3".',
				"Step 2: call background action=status name=e2e1 up to 8 times until it reports it ended. Between calls, call background action=status again; do not sleep with bash.",
				"Step 3: report the exit status and whether MARKER_OMEGA appeared.",
			].join(" "),
			"run1",
		);
		expect(run.code).toBe(0);
		expect(run.err).not.toMatch(/failed to load|extension error/i);

		const entries = sessionEntries("run1");
		const toolCalls = entries.flatMap((entry) =>
			Array.isArray(entry.message?.content)
				? entry.message.content.filter((part) => ["toolCall", "tool_call", "toolUse"].includes(part.type ?? ""))
				: [],
		);
		expect(toolCalls.some((part) => (part.name ?? part.toolName) === "background")).toBe(true);

		const custom = entries.filter(
			(entry) =>
				entry.type === "custom" || entry.customType === "background" || entry.message?.customType === "background",
		);
		const digestText = JSON.stringify(custom);
		expect(digestText).toMatch(/Background job/);
		expect(digestText).toMatch(/exit code 3/);
		expect(digestText).toMatch(/MARKER_OMEGA/);
		expect(digestText).toMatch(/pi-background-logs/);
		expect(custom.every((entry) => JSON.stringify(entry).length < 4_000)).toBe(true);
		expect(run.out).toMatch(/3/);
	});

	it("renders the logs, list, and status actions through the tool layer", async () => {
		const run = await runPi(
			[
				"Do exactly these tool calls in order, then report.",
				'1: background action=start name=e2elogs command="echo ALPHA-LINE; echo BETA-LINE; sleep 1".',
				"2: background action=list.",
				"3: background action=logs name=e2elogs lines=20.",
				"4: background action=status name=e2elogs.",
				"Then quote the last output line you saw.",
			].join(" "),
			"run5",
		);
		expect(run.code).toBe(0);
		const anywhere = JSON.stringify(sessionEntries("run5"));
		expect(anywhere).not.toMatch(/ReferenceError|is not defined/);
		expect(anywhere).toMatch(/```text/);
		expect(anywhere).toMatch(/ALPHA-LINE/);
		expect(anywhere).toMatch(/e2elogs/);
		expect(anywhere).toMatch(/running|ended|exit code/);
		expect(anywhere).not.toMatch(/Unsupported background action|requires name/);
	});

	it("monitor rejects a regex passed as a literal", async () => {
		const run = await runPi(
			'Call the monitor tool exactly once with action=start, name=e2e2, command="sleep 1", match="FAILED|passed". Then report verbatim what the tool returned. Do not retry with different arguments.',
			"run2",
		);
		expect(run.code).toBe(0);
		const anywhere = JSON.stringify(sessionEntries("run2"));
		expect(anywhere).toMatch(/literal substring by default/);
		expect(anywhere).toMatch(/regex=true/);
		expect(anywhere).not.toMatch(/Started monitor/);
	});

	it("monitor accepts a literal and an isolated regex through the real tool", async () => {
		const run = await runPi(
			[
				"Do exactly two tool calls, then report.",
				'First: monitor action=start name=e2elit command="echo READY-NOW; sleep 2" match="READY-NOW".',
				'Second: monitor action=start name=e2ere command="echo done-42; sleep 2" match="done-[0-9]+" regex=true.',
				"Then say which ones started.",
			].join(" "),
			"run4",
		);
		expect(run.code).toBe(0);
		const anywhere = JSON.stringify(sessionEntries("run4"));
		expect(anywhere).toMatch(/as a literal/);
		expect(anywhere).toMatch(/as a regex/);
		expect(anywhere).toMatch(/READY-NOW/);
		expect(anywhere).toMatch(/done-42/);
		expect(anywhere).toMatch(/Only this session is woken by it/);
	});

	it("background refuses match and points at monitor", async () => {
		const run = await runPi(
			'Call the background tool once with action=start, name=e2e3, command="echo hi", match="hi". Report verbatim what it returned.',
			"run3",
		);
		expect(run.code).toBe(0);
		const anywhere = JSON.stringify(sessionEntries("run3"));
		const guarded = /does not match output/.test(anywhere);
		const schemaRejected =
			/match/.test(anywhere) && /Unrecognized|not allowed|additionalProperties|unexpected/i.test(anywhere);
		expect(guarded || schemaRejected).toBe(true);
	});
});
