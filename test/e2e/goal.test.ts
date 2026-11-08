import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { createSandbox, scrubEnv } from "../support/sandbox.ts";

const root = mkdtempSync(join(tmpdir(), "pimon-goal-e2e-"));
const extension = join(import.meta.dirname, "../../src/index.ts");
const model = process.env["PI_TEST_MODEL"] ?? "openai-codex/gpt-5.4-mini";
// Only PATH stubs and the stub log come from the sandbox. pi still needs the real agent dir for auth.
const sandbox = createSandbox();

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	sandbox.dispose();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Pi {
	work: string;
	send(message: string): void;
	text(): string;
	notices(): string[];
	waitFor(test: RegExp | (() => boolean), timeoutMs: number): Promise<boolean>;
	stubCalls(): string;
	close(): Promise<void>;
}

function startPi(label: string): Pi {
	const work = join(root, label);
	mkdirSync(work, { recursive: true });
	const env: NodeJS.ProcessEnv = { ...process.env };
	scrubEnv(env);
	const stubLog = join(root, `${label}-stub.log`);
	const child: ChildProcessWithoutNullStreams = spawn(
		"pi",
		["--mode", "rpc", "--no-extensions", "-e", extension, "--model", model],
		{
			cwd: work,
			env: {
				...env,
				PATH: sandbox.env["PATH"],
				PIMON_TEST_STUB_LOG: stubLog,
				PI_CODING_AGENT_SESSION_DIR: join(root, "sessions", label),
				PI_BACKGROUND_DIR: join(root, `background-${label}`),
			},
		},
	);
	const records: Record<string, unknown>[] = [];
	let buffer = "";
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			try {
				records.push(JSON.parse(line) as Record<string, unknown>);
			} catch {
				// Not a protocol record.
			}
			newline = buffer.indexOf("\n");
		}
	});
	let id = 0;
	const text = () => JSON.stringify(records);
	return {
		work,
		send(message) {
			child.stdin.write(`${JSON.stringify({ id: `c${++id}`, type: "prompt", message, streamingBehavior: "steer" })}\n`);
		},
		text,
		notices: () =>
			records
				.filter((record) => record["type"] === "extension_ui_request" && record["method"] === "notify")
				.map((record) => String(record["message"])),
		async waitFor(test, timeoutMs) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (typeof test === "function" ? test() : test.test(text())) return true;
				await sleep(250);
			}
			return false;
		},
		stubCalls: () => (existsSync(stubLog) ? readFileSync(stubLog, "utf8") : ""),
		async close() {
			child.stdin.end();
			const exited = new Promise((resolve) => child.on("close", resolve));
			const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
			await exited;
			clearTimeout(timer);
		},
	};
}

const files = (pi: Pi) =>
	readdirSync(pi.work)
		.filter((name) => name.endsWith(".txt"))
		.sort();

describe.concurrent("goal through a real pi", () => {
	it("runs unattended and finishes on an accepted claim", async () => {
		const pi = startPi("done");
		const target = join(pi.work, "artifact.txt");
		pi.send(`/goal create the file ${target} containing exactly the word READY, then verify it with cat`);
		expect(await pi.waitFor(/Goal set/, 20_000)).toBe(true);
		expect(await pi.waitFor(/Goal accepted|Goal achieved/, 180_000)).toBe(true);
		expect(existsSync(target) && readFileSync(target, "utf8")).toContain("READY");

		pi.send("/goal");
		expect(await pi.waitFor(() => pi.notices().some((notice) => notice.startsWith("Goal achieved:")), 20_000)).toBe(
			true,
		);
		expect(pi.stubCalls()).toContain("notify-send");
		expect(pi.stubCalls()).toContain("pi goal: achieved");
		await pi.close();
	});

	it("stops at the rejected-claim budget when the check can never pass", async () => {
		const pi = startPi("rejected");
		pi.send("/goal write the word done into done.txt, then read it back, then append a second line saying checked");
		expect(await pi.waitFor(/Goal set/, 20_000)).toBe(true);
		pi.send("/goal-check false");
		expect(await pi.waitFor(/Check command set/, 20_000)).toBe(true);
		expect(await pi.waitFor(/Goal paused: rejected-claims/, 400_000)).toBe(true);
		expect(pi.stubCalls()).toContain("pi goal: paused");

		pi.send("/goal");
		expect(await pi.waitFor(/paused: rejected-claims/, 20_000)).toBe(true);
		await pi.close();
	});

	it("takes a steering message as guidance instead of a pause", async () => {
		const pi = startPi("steering");
		pi.send("/goal create a.txt containing alpha, then b.txt containing beta. One file per turn, then stop.");
		expect(await pi.waitFor(/Goal set/, 20_000)).toBe(true);
		await sleep(500);
		pi.send("also create c.txt containing gamma before you finish");
		await sleep(8_000);
		expect(pi.text()).not.toMatch(/Goal paused/);
		expect(await pi.waitFor(() => files(pi).includes("c.txt"), 240_000)).toBe(true);
		expect(pi.text()).not.toMatch(/paused: user-input/);
		await pi.close();
	});

	it("resumes a paused goal and does more work", async () => {
		const pi = startPi("resume");
		pi.send(
			"/goal create three files here: a.txt containing alpha, b.txt containing beta, c.txt containing gamma. Exactly one file per turn, and pause for a moment between files.",
		);
		expect(await pi.waitFor(() => files(pi).length >= 1, 180_000)).toBe(true);
		pi.send("/goal pause");
		expect(await pi.waitFor(/Goal paused/, 30_000)).toBe(true);
		const before = files(pi);
		expect(before.length).toBeGreaterThanOrEqual(1);

		pi.send("/goal resume");
		expect(await pi.waitFor(() => files(pi).length > before.length, 120_000)).toBe(true);
		expect(pi.text()).not.toMatch(/paused or replaced before this verdict/);
		await pi.close();
	});

	it("wakes a waiting goal from an armed background job and from steering", async () => {
		const pi = startPi("wait");
		const target = join(pi.work, "wait-done.txt");
		const steered = join(pi.work, "wait-steered.txt");
		pi.send(
			`/goal start a background job named waitjob with command "sleep 2; echo READY" and wait for its exit with goal_wait, then create ${target} containing READY and verify it with cat`,
		);
		expect(await pi.waitFor(/Goal set/, 20_000)).toBe(true);
		expect(await pi.waitFor(/External wait armed/, 60_000)).toBe(true);
		pi.send(`while waiting, also create ${steered} containing STEER`);
		expect(await pi.waitFor(() => existsSync(steered), 90_000)).toBe(true);
		expect(await pi.waitFor(() => existsSync(target), 180_000)).toBe(true);
		await pi.close();
	});

	it("wakes the goal through the wait timeout when no notification comes", async () => {
		const pi = startPi("wait-timeout");
		const target = join(pi.work, "timeout-done.txt");
		pi.send(
			`/goal start a background job named silentjob with command "sleep 30" and notifyExit=false, then call goal_wait with reason "silent job completion" and timeoutMs=3000. When the timeout notice arrives, create ${target} containing TIMEOUT and verify it with cat`,
		);
		expect(await pi.waitFor(/Goal set/, 20_000)).toBe(true);
		expect(await pi.waitFor(/External wait armed/, 60_000)).toBe(true);
		expect(await pi.waitFor(/The external wait timed out/, 90_000)).toBe(true);
		expect(pi.text()).not.toMatch(/external-wait notice is stale/);
		expect(await pi.waitFor(() => existsSync(target), 120_000)).toBe(true);
		await pi.close();
	});

	it("pauses and clears a running goal from the command", async () => {
		const pi = startPi("lifecycle");
		pi.send("/goal list every file in /usr/share/doc one directory at a time and summarise each");
		expect(await pi.waitFor(/Goal set/, 20_000)).toBe(true);
		await sleep(5_000);
		pi.send("/goal pause");
		expect(await pi.waitFor(/Goal paused/, 30_000)).toBe(true);
		pi.send("/goal clear");
		expect(await pi.waitFor(/Goal cleared/, 30_000)).toBe(true);
		pi.send("/goal");
		expect(await pi.waitFor(/No goal set/, 20_000)).toBe(true);
		await pi.close();
	});
});
