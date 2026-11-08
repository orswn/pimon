import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { readTail } from "../../src/features/background/logsink.ts";
import {
	type JobOptions,
	LIMITS,
	type MonitorOptions,
	parseMonitorEdit,
} from "../../src/features/background/options.ts";
import {
	activeJobs,
	createRegistry,
	findJob,
	type JobState,
	logFileTaken,
	nameTaken,
} from "../../src/features/background/registry.ts";
import { runAction } from "../../src/features/background/index.ts";
import { editMonitor, shutdownJobs, startJob, stopJob } from "../../src/features/background/runner.ts";

const root = mkdtempSync(join(tmpdir(), "pimon-bg-jobs-"));
const savedDir = process.env["PI_BACKGROUND_DIR"];
beforeAll(() => {
	process.env["PI_BACKGROUND_DIR"] = join(root, "state");
});

const reg = createRegistry(join(root, "agent"));
const emissions: { name: string; text: string }[] = [];
reg.emit = (state, text) => emissions.push({ name: state.options.name, text });

afterAll(async () => {
	await shutdownJobs(reg);
	if (savedDir === undefined) delete process.env["PI_BACKGROUND_DIR"];
	else process.env["PI_BACKGROUND_DIR"] = savedDir;
	rmSync(root, { recursive: true, force: true });
});

let seq = 0;
function opts(over: Partial<JobOptions> = {}): JobOptions {
	seq += 1;
	return {
		kind: "background",
		name: `job-${seq}`,
		command: "true",
		cwd: root,
		timeoutMs: 0,
		notifyExit: true,
		logFile: join(root, `job-${seq}.log`),
		logMaxBytes: LIMITS.logMaxBytes,
		...over,
	};
}

function monitor(over: Partial<MonitorOptions> & { command: string; matchSource: string }): MonitorOptions {
	return {
		...opts(),
		kind: "monitor",
		mode: "literal",
		ignoreCase: false,
		streams: new Set(["stdout"]),
		once: false,
		debounceMs: LIMITS.defaultDebounceMs,
		maxPerMinute: LIMITS.defaultMaxPerMinute,
		muteCooldownMs: LIMITS.muteCooldownMs,
		...over,
	};
}

function start(options: JobOptions): JobState {
	const started = startJob(reg, options, "session-a");
	if (!started.ok) throw new Error(started.error);
	return started.state;
}

const emitsFor = (name: string) => emissions.filter((entry) => entry.name === name).map((entry) => entry.text);
const heads = (name: string) => emitsFor(name).map((text) => text.split("\n")[0]);

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(25);
	}
	return false;
}

const exited = (state: JobState) => waitFor(() => state.exitedAt !== undefined);

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

describe("background job", () => {
	it("stays silent while running and emits exactly one digest on exit", async () => {
		const options = opts({ command: "echo first; sleep 1; echo second" });
		const state = start(options);
		await sleep(400);
		expect(state.totalLines).toBeGreaterThanOrEqual(1);
		expect(emitsFor(options.name)).toHaveLength(0);
		expect(state.exitedAt).toBeUndefined();
		expect(readTail(options.logFile, 10, LIMITS.logTailBytes).lines.some((line) => line.includes("first"))).toBe(true);

		await waitFor(() => emitsFor(options.name).length > 0);
		const emitted = emitsFor(options.name);
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toContain("exit code 0");
		expect(emitted[0]).toContain("first");
		expect(emitted[0]).toContain("second");
		expect(reg.completed.has(options.name) && !reg.active.has(options.name)).toBe(true);
		expect(findJob(reg, options.name)?.exitStatus).toBe("exit code 0");
	});

	it("keeps a noisy job to one bounded message with the full output on disk", async () => {
		const options = opts({
			command: 'for i in $(seq 1 5000); do echo "noisy line $i with some padding text"; done',
		});
		const state = start(options);
		await waitFor(() => emitsFor(options.name).length > 0, 20_000);
		const text = emitsFor(options.name)[0] ?? "";
		expect(emitsFor(options.name)).toHaveLength(1);
		expect(text.length).toBeLessThan(3_000);
		expect(text).toMatch(/of 5000 line\(s\)/);
		expect(state.tail.length).toBeLessThanOrEqual(LIMITS.memTailLines);
		expect(state.droppedLines).toBeGreaterThan(0);
		expect(readTail(options.logFile, 5_000, 8 * 1024 * 1024).lines.length).toBeGreaterThan(4_000);
	});

	it("reports a non-zero exit, tags stderr, and reports a missing command as exit 127", async () => {
		const failing = opts({ command: "echo to-stderr >&2; exit 7" });
		start(failing);
		await waitFor(() => emitsFor(failing.name).length > 0);
		expect(emitsFor(failing.name)[0]).toContain("exit code 7");
		expect(emitsFor(failing.name)[0]).toContain("[err] to-stderr");

		const missing = opts({ command: "definitely-not-a-real-command-xyz" });
		start(missing);
		await waitFor(() => emitsFor(missing.name).length > 0);
		expect(emitsFor(missing.name)[0]).toContain("exit code 127");
	});

	it("notifyExit=false emits nothing and stays inspectable", async () => {
		const options = opts({ command: "echo quiet", notifyExit: false });
		const state = start(options);
		await exited(state);
		await sleep(200);
		expect(emitsFor(options.name)).toHaveLength(0);
		expect(state.tail.join(" ")).toContain("quiet");
	});

	it("splits carriage returns, strips ANSI in the tail, and keeps raw bytes in the log", async () => {
		const options = opts({ command: "printf 'progress 1\\rprogress 2\\r\\n\\033[31mred\\033[0m\\n'" });
		const state = start(options);
		await exited(state);
		expect(state.tail).toEqual(expect.arrayContaining(["progress 1", "progress 2", "red"]));
		expect(readFileSync(options.logFile, "utf8")).toContain("\u001b[31m");
	});

	it("does not pass PI_BUS_* to the child except PI_BUS_DIR", async () => {
		process.env["PI_BUS_NAME"] = "mars-parent";
		process.env["PI_BUS_OWNER"] = "owner-uuid";
		process.env["PI_BUS_DIR"] = "/tmp/keepme";
		try {
			const state = start(opts({ command: "env | grep '^PI_BUS' | sort" }));
			await exited(state);
			const seen = state.tail.join("\n");
			expect(seen).not.toContain("PI_BUS_NAME");
			expect(seen).not.toContain("PI_BUS_OWNER");
			expect(seen).toContain("PI_BUS_DIR=/tmp/keepme");
		} finally {
			delete process.env["PI_BUS_NAME"];
			delete process.env["PI_BUS_OWNER"];
			delete process.env["PI_BUS_DIR"];
		}
	});

	it("timeout emits one notice, retires the job, and adds no exit digest", async () => {
		const options = opts({ command: "sleep 45", timeoutMs: 400 });
		const state = start(options);
		await waitFor(() => emitsFor(options.name).length > 0, 5_000);
		const text = emitsFor(options.name)[0] ?? "";
		expect(text).toContain("timeout");
		expect(text).toContain("killed");
		expect(await exited(state)).toBe(true);
		await sleep(300);
		expect(emitsFor(options.name)).toHaveLength(1);
	});

	it("a timeout that leaves the job alive after SIGKILL wakes the agent exactly once", async () => {
		const options = opts({ command: "sleep 45", timeoutMs: 300 });
		const state = start(options);
		const realKill = state.kill;
		state.kill = () => {};
		state.liveness = () => "alive";
		try {
			const survived = () => emitsFor(options.name).filter((text) => text.includes("still alive after SIGKILL"));
			expect(await waitFor(() => survived().length > 0, 8_000)).toBe(true);
			const again = await stopJob(reg, state, "stopped by agent");
			expect(again.result).toBe("unkillable");
			await sleep(LIMITS.unkillablePollMs + 300);
			expect(survived()).toHaveLength(1);
			expect(survived()[0]).toContain(`background "${options.name}"`);
			expect(survived()[0]).toContain(options.logFile);
			expect(state.unkillable).toBe(true);
			expect(state.exitedAt).toBeUndefined();
		} finally {
			state.kill = realKill;
			state.kill("SIGKILL");
			await exited(state);
		}
	});

	it("an agent stop that joins a timeout stop reports the survivor only in its result", async () => {
		const options = opts({ command: "sleep 45", timeoutMs: 300 });
		const state = start(options);
		const realKill = state.kill;
		state.kill = () => {};
		state.liveness = () => "alive";
		try {
			expect(await waitFor(() => state.stopping, 5_000)).toBe(true);
			const result = await runAction(reg, "background", { action: "stop", name: options.name }, root);
			expect(result).toContain("still alive after SIGKILL");
			await sleep(LIMITS.unkillablePollMs + 300);
			expect(emitsFor(options.name).filter((text) => text.includes("still alive after SIGKILL"))).toHaveLength(0);
		} finally {
			state.kill = realKill;
			state.kill("SIGKILL");
			await exited(state);
		}
	});
});

describe("monitor matching", () => {
	it("batches nearby matches, excludes other lines, and still reports the exit", async () => {
		const options = monitor({
			command: "echo 'ERROR one'; echo 'ok'; echo 'ERROR two'; sleep 0.6",
			matchSource: "ERROR",
		});
		const state = start(options);
		await waitFor(() => emitsFor(options.name).length > 0);
		const first = emitsFor(options.name)[0] ?? "";
		expect(first).toContain("matched 2 line(s)");
		expect(first).not.toContain("ok\n");
		await exited(state);
		await sleep(150);
		expect(emitsFor(options.name).some((text) => text.includes("ended"))).toBe(true);
	});

	it("names ignoreCase in the pattern line of the match wake", async () => {
		const options = monitor({ command: "echo 'Error one'; sleep 0.3", matchSource: "ERROR", ignoreCase: true });
		const state = start(options);
		await exited(state);
		const wake = emitsFor(options.name).find((text) => text.includes("matched")) ?? "";
		expect(wake.split("\n")).toContain('Pattern: "ERROR" (literal, ignoreCase)');
	});

	it("matches a 1200-char line that ends in DONE", async () => {
		const options = monitor({ command: "printf '%01200d DONE\\n' 0; sleep 0.5", matchSource: "DONE" });
		const state = start(options);
		await exited(state);
		expect(emitsFor(options.name).some((text) => text.includes("matched 1 line(s)"))).toBe(true);
	});

	it("delivers a burst of 21 matching lines in one digest without muting", async () => {
		const options = monitor({ command: "for i in $(seq 1 21); do echo FAIL-$i; done; sleep 0.5", matchSource: "FAIL" });
		const state = start(options);
		await exited(state);
		const digests = emitsFor(options.name).filter((text) => text.includes("matched"));
		expect(digests).toHaveLength(1);
		expect(digests[0]).toContain("matched 21 line(s)");
		expect(digests[0]).toContain("FAIL-2\n");
		expect(digests[0]).toContain("FAIL-21");
		expect(emitsFor(options.name).some((text) => text.includes("muted"))).toBe(false);
		expect(state.muted).toBe(false);
	});

	it("names the command in a match digest only for a monitor with a generated name", async () => {
		const named = monitor({ command: "echo NAMED-HIT; sleep 0.4", matchSource: "NAMED-HIT", debounceMs: 50 });
		const anon = monitor({
			command: "echo ANON-HIT; sleep 0.4",
			matchSource: "ANON-HIT",
			debounceMs: 50,
			generatedName: true,
		});
		start(named);
		start(anon);
		const matched = (name: string) => emitsFor(name).find((text) => text.includes("matched")) ?? "";
		expect(await waitFor(() => matched(named.name) !== "" && matched(anon.name) !== "")).toBe(true);
		expect(matched(named.name)).not.toContain("Command:");
		expect(matched(anon.name).split("\n")[1]).toBe("Command: echo ANON-HIT; sleep 0.4");
	});

	it("names the command in a timeout notice only for a job with a generated name", async () => {
		const named = opts({ command: "sleep 5", timeoutMs: 200 });
		const anon = opts({ command: "sleep 5", timeoutMs: 200, generatedName: true });
		const states = [start(named), start(anon)];
		const notice = (name: string) => emitsFor(name).find((text) => text.includes("timeout")) ?? "";
		expect(await waitFor(() => notice(named.name) !== "" && notice(anon.name) !== "")).toBe(true);
		expect(notice(named.name)).not.toContain("Command:");
		expect(notice(anon.name).split("\n")[1]).toBe("Command: sleep 5");
		for (const state of states) await exited(state);
	});

	it("once stops itself after the first batch and adds no exit digest", async () => {
		const options = monitor({ command: "echo HIT; sleep 10", matchSource: "HIT", once: true, debounceMs: 50 });
		const state = start(options);
		expect(await waitFor(() => state.exitedAt !== undefined, 6_000)).toBe(true);
		expect(emitsFor(options.name).filter((text) => text.includes("ended"))).toHaveLength(0);
		expect(state.exitStatus).toBe("stopped (matched once)");
		const status = await runAction(reg, "monitor", { action: "status", name: options.name }, root);
		if (typeof status !== "string") throw new Error("expected status text");
		expect(status.split("\n")[0]).toMatch(/\] (\(other session\) )?stopped \(matched once\)$/);
		expect(readFileSync(options.logFile, "utf8")).toContain("# pi: stopping (matched once)");
	});
});

describe("monitor edit", () => {
	it("rebuilds the matcher when an edit changes the pattern", async () => {
		const options = monitor({ command: "sleep 0.6; printf '%s-line\\n' AAA BBB; sleep 0.6", matchSource: "AAA" });
		const state = start(options);
		const updates = parseMonitorEdit({ match: "BBB" }, options);
		if (typeof updates === "string") throw new Error(updates);
		editMonitor(reg, state, updates);
		await exited(state);
		const digests = emitsFor(options.name).filter((text) => text.includes("matched"));
		expect(digests).toHaveLength(1);
		expect(digests[0]).toContain("matched 1 line(s)");
		expect(digests[0]).toContain("BBB-line");
		expect(digests[0]).not.toContain("AAA-line");
	});

	it("matches again after a matcher failure and an edit", async () => {
		const options = monitor({
			command: "sleep 1.2; echo READY-now; sleep 0.6",
			mode: "regex",
			matchSource: "([unclosed",
		});
		const state = start(options);
		expect(await waitFor(() => heads(options.name).some((head) => head?.includes("stopped matching")))).toBe(true);
		const updates = parseMonitorEdit({ match: "READY", regex: false }, options);
		if (typeof updates === "string") throw new Error(updates);
		expect(editMonitor(reg, state, updates)).toBe(true);
		await exited(state);
		expect(
			emitsFor(options.name).some((text) => text.includes("matched 1 line(s)") && text.includes("READY-now")),
		).toBe(true);
	});
});

describe("monitor flood control counts notifications", () => {
	it("mutes after too many notifications, keeps the process, and reports the batch", async () => {
		const options = monitor({
			command: 'for i in $(seq 1 6); do echo "BOOM $i"; sleep 0.1; done; sleep 6',
			matchSource: "BOOM",
			debounceMs: 20,
			maxPerMinute: 3,
		});
		const state = start(options);
		await waitFor(() => emitsFor(options.name).some((text) => text.includes("muted")));
		await sleep(600);
		expect(state.muted).toBe(true);
		expect(state.mutePermanent).toBe(false);
		expect(state.mutedUntil).toBeGreaterThan(Date.now());
		expect(state.exitedAt).toBeUndefined();
		expect(state.liveness()).not.toBe("gone");
		const muteMessages = emitsFor(options.name).filter((text) => text.includes("muted"));
		expect(muteMessages).toHaveLength(1);
		expect(muteMessages[0]).toContain("Nothing was killed");
		expect(muteMessages[0]).toContain("BOOM 4");
		expect(emitsFor(options.name).filter((text) => text.includes("matched 1 line(s)"))).toHaveLength(3);
		const before = emitsFor(options.name).length;
		await sleep(500);
		expect(emitsFor(options.name)).toHaveLength(before);
		expect(readTail(options.logFile, 100, LIMITS.logTailBytes).lines.length).toBeGreaterThan(5);
		await stopJob(reg, state, "test cleanup");
	});

	it("a cooldown mute resumes on the next line after it ends and matches again", async () => {
		const options = monitor({
			command: "for i in 1 2 3 4; do echo \"HOT $i\"; sleep 0.1; done; sleep 1.2; echo 'HOT late'; sleep 2",
			matchSource: "HOT",
			debounceMs: 20,
			maxPerMinute: 2,
			muteCooldownMs: 500,
		});
		const state = start(options);
		await waitFor(() => emitsFor(options.name).some((text) => text.includes("muted for")));
		expect(state.muted).toBe(true);
		expect(state.mutePermanent).toBe(false);
		const muted = emitsFor(options.name).find((text) => text.includes("muted for")) ?? "";
		expect(muted).toContain("resumes on its own");
		expect(muted).toMatch(/more flood\(s\)/);

		expect(
			await waitFor(() => emitsFor(options.name).some((text) => text.includes("resumed after its cooldown")), 6_000),
		).toBe(true);
		expect(emitsFor(options.name).find((text) => text.includes("resumed"))).toContain("went unmatched");
		expect(
			await waitFor(
				() => emitsFor(options.name).some((text) => text.includes("matched") && text.includes("HOT late")),
				4_000,
			),
		).toBe(true);
		await stopJob(reg, state, "cooldown test cleanup");
	});

	it("three floods make the mute permanent", async () => {
		const options = monitor({
			command:
				'for r in 1 2 3 4; do for i in 1 2 3 4; do echo "BANG $r.$i"; sleep 0.06; done; sleep 0.35; done; sleep 2',
			matchSource: "BANG",
			debounceMs: 10,
			maxPerMinute: 2,
			muteCooldownMs: 250,
		});
		const state = start(options);
		expect(await waitFor(() => emitsFor(options.name).some((text) => text.includes("muted permanently")), 10_000)).toBe(
			true,
		);
		expect(state.mutePermanent).toBe(true);
		const permanent = emitsFor(options.name).filter((text) => text.includes("muted permanently"));
		expect(permanent).toHaveLength(1);
		expect(permanent[0]).toContain("Nothing was killed");
		const before = emitsFor(options.name).length;
		await sleep(700);
		expect(emitsFor(options.name)).toHaveLength(before);
		if (state.exitedAt === undefined) await stopJob(reg, state, "permanent mute cleanup");
	});
});

describe("stop", () => {
	it("takes the whole process group and suppresses the exit digest", async () => {
		const options = opts({ command: "sleep 45 & echo grandchild=$!; wait" });
		const state = start(options);
		await waitFor(() => state.tail.some((line) => line.includes("grandchild=")));
		const grandchild = Number(state.tail.find((line) => line.includes("grandchild="))?.split("=")[1]);
		expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
		expect(pidAlive(grandchild)).toBe(true);
		await stopJob(reg, state, "stopped by test");
		await sleep(300);
		expect(pidAlive(grandchild)).toBe(false);
		expect(readFileSync(options.logFile, "utf8")).toContain("# pi: stopping");
		expect(emitsFor(options.name)).toHaveLength(0);
	});

	it("confirms a SIGTERM exit inside the call", async () => {
		const state = start(opts({ command: "sleep 30" }));
		await sleep(200);
		const outcome = await stopJob(reg, state, "stopped by agent");
		expect(outcome.result).toBe("exited");
		expect(outcome.text).toMatch(/^exited after SIGTERM in \d+\.\ds$/);
		expect(state.exitedAt).toBeDefined();
	});

	it("escalates past SIGTERM to SIGKILL inside the call and records the signal", async () => {
		const state = start(opts({ command: "trap '' TERM; sleep 45" }));
		await sleep(300);
		const pending = stopJob(reg, state, "stubborn");
		await sleep(600);
		expect(state.exitedAt).toBeUndefined();
		const outcome = await pending;
		expect(outcome.result).toBe("killed");
		expect(outcome.text).toMatch(/^killed with SIGKILL after \d+\.\ds$/);
		expect(state.exitStatus).toContain("SIGKILL");
		expect(state.unkillable).toBe(false);
	});

	it("a second stop does not retire the job twice", async () => {
		const state = start(opts({ command: "sleep 20", name: "holder" }));
		expect(nameTaken(reg, "holder")).toBe("background");
		expect(logFileTaken(reg, state.options.logFile)).toBe("holder");
		expect(nameTaken(reg, "nope")).toBeUndefined();
		expect(activeJobs(reg, "background").some((job) => job.options.name === "holder")).toBe(true);
		expect(activeJobs(reg, "monitor").every((job) => job.options.kind === "monitor")).toBe(true);
		const [first, second] = await Promise.all([stopJob(reg, state, "cleanup"), stopJob(reg, state, "again")]);
		expect(second).toBe(first);
		const exitedAt = state.exitedAt;
		await sleep(200);
		expect(state.exitedAt).toBe(exitedAt);
		expect(nameTaken(reg, "holder")).toBeUndefined();
	});
});

describe("leases of running jobs", () => {
	const leaseFiles = () => {
		try {
			return readdirSync(join(root, "state", "leases")).filter((file) => file.endsWith(".json"));
		} catch {
			return [];
		}
	};

	it("writes a lease with verified identity and an owner, and deletes it on exit", async () => {
		const state = start(opts({ command: "sleep 20", name: "leaseholder" }));
		expect(leaseFiles().length).toBeGreaterThan(0);
		expect(state.identity?.startTicks).toBeDefined();
		expect(state.liveness()).toBe("alive");
		const lease = JSON.parse(readFileSync(state.leaseFile ?? "", "utf8")) as { owner?: { pid: number } };
		expect(lease.owner?.pid).toBe(process.pid);
		const before = leaseFiles().length;
		await stopJob(reg, state, "lease cleanup");
		expect(leaseFiles().length).toBeLessThan(before);
		// A group member can stay in /proc for a moment after the leader exits.
		expect(await waitFor(() => state.liveness() === "gone")).toBe(true);
	});
});

describe("quit", () => {
	it("a job that traps SIGTERM is dead after shutdown resolves, and its lease is removed", async () => {
		const state = start(opts({ command: "trap '' TERM; sleep 45" }));
		await sleep(300);
		const pid = state.pid ?? 0;
		const leaseFile = state.leaseFile ?? "";
		expect(pidAlive(pid)).toBe(true);
		await shutdownJobs(reg);
		expect(pidAlive(pid)).toBe(false);
		expect(state.exitedAt).toBeDefined();
		expect(readdirSync(join(root, "state", "leases"))).not.toContain(leaseFile.split("/").at(-1));
		expect(readFileSync(state.options.logFile, "utf8")).toContain("killed at session teardown");
	});
});
