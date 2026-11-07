import * as fs from "node:fs";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { LogSink, readTail } from "./logsink.ts";
import { LIMITS } from "./options.ts";

const root = mkdtempSync(join(tmpdir(), "pimon-logsink-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fill = (sink: LogSink, count: number, text = (i: number) => `line ${i} padding padding\n`) => {
	for (let i = 0; i < count; i++) sink.write(text(i));
};

describe("LogSink rotation", () => {
	it("rotates past the byte cap, keeps one rotated file, and the tail reads across it", () => {
		const file = join(root, "rotate.log");
		const sink = new LogSink(file, 300);
		sink.open("# header");
		fill(sink, 60, (i) => `line ${i} ${"x".repeat(20)}\n`);
		sink.close();
		expect(sink.note()).toContain("rotated");
		expect(existsSync(`${file}.1`)).toBe(true);
		const liveLines = readFileSync(file, "utf8").trimEnd().split("\n").length;
		const rotatedLines = readFileSync(`${file}.1`, "utf8").trimEnd().split("\n").length;
		const tail = readTail(file, 40, LIMITS.logTailBytes).lines;
		expect(tail.length).toBeGreaterThan(liveLines);
		expect(tail.length).toBeLessThanOrEqual(liveLines + rotatedLines);
		expect(tail.at(-1)).toContain("line 59");
		const partial = readTail(file, 3, 64).lines;
		expect(partial.every((line) => !line.startsWith("li ") && line.length > 0)).toBe(true);
	});

	it("leaves no temp rotation files", () => {
		const base = join(root, "rot");
		mkdirSync(base, { recursive: true });
		const happy = new LogSink(join(base, "a.log"), 200);
		happy.open("# h");
		fill(happy, 40);
		expect(happy.note()).toContain("rotated");
		expect(existsSync(join(base, "a.log.1"))).toBe(true);
		expect(readdirSync(base).every((entry) => !entry.includes(".rot-"))).toBe(true);
		happy.close();
	});

	it("a failed open of the new file keeps the original fd and disables rotation", () => {
		const roDir = join(root, "ro");
		mkdirSync(roDir, { recursive: true });
		const blocked = new LogSink(join(roDir, "b.log"), 150);
		blocked.open("# h");
		chmodSync(roDir, 0o500);
		fill(blocked, 30);
		chmodSync(roDir, 0o700);
		expect(blocked.error).toBeUndefined();
		expect(blocked.note()).toContain("rotation unavailable");
		expect(readFileSync(join(roDir, "b.log"), "utf8")).toContain("line 29");
		expect(existsSync(join(roDir, "b.log.1"))).toBe(false);
		blocked.close();
	});

	it("a failed first rename keeps the log usable and leaves no temp file", () => {
		const base = join(root, "c");
		mkdirSync(base);
		const sink = new LogSink(join(base, "c.log"), 150, {
			renameSync: () => {
				throw new Error("injected rename failure");
			},
		});
		sink.open("# h");
		fill(sink, 30);
		expect(sink.error).toBeUndefined();
		expect(sink.note()).toContain("rotation unavailable");
		sink.write("after failure\n");
		expect(readFileSync(join(base, "c.log"), "utf8")).toContain("after failure");
		expect(readdirSync(base).every((entry) => !entry.includes(".rot-"))).toBe(true);
		sink.close();
	});

	it("a failed second rename rolls back", () => {
		const base = join(root, "d");
		mkdirSync(base);
		let renames = 0;
		const sink = new LogSink(join(base, "d.log"), 150, {
			renameSync: (from, to) => {
				renames += 1;
				if (renames === 2) throw new Error("injected second rename failure");
				fs.renameSync(from, to);
			},
		});
		sink.open("# h");
		fill(sink, 30);
		expect(sink.note()).toContain("rolled back");
		expect(existsSync(join(base, "d.log"))).toBe(true);
		expect(existsSync(join(base, "d.log.1"))).toBe(false);
		expect(sink.error).toBeUndefined();
		sink.write("post rollback\n");
		expect(readFileSync(join(base, "d.log"), "utf8")).toContain("post rollback");
		sink.close();
	});

	it("a failed rollback keeps a writable fd and says where output goes", () => {
		const base = join(root, "e");
		mkdirSync(base);
		let calls = 0;
		const sink = new LogSink(join(base, "e.log"), 150, {
			renameSync: (from, to) => {
				calls += 1;
				if (calls === 1) return fs.renameSync(from, to);
				throw new Error(`injected rename failure ${calls}`);
			},
		});
		sink.open("# h");
		fill(sink, 30);
		expect(sink.error).toBeUndefined();
		expect(sink.note()).toContain("output continues in");
		expect(sink.path).not.toBe(join(base, "e.log"));
		expect(existsSync(sink.path)).toBe(true);
		sink.write("still writing\n");
		expect(readFileSync(sink.path, "utf8")).toContain("still writing");
		sink.close();
	});

	it("records a write failure once and does not retry it", () => {
		let writes = 0;
		const sink = new LogSink(join(root, "f.log"), 10_000, {
			writeSync: () => {
				writes += 1;
				throw new Error("injected write failure");
			},
		});
		sink.open("# h");
		sink.write("a\n");
		sink.write("b\n");
		expect(writes).toBe(1);
		expect(sink.note()).toContain("unavailable");
		sink.close();
	});
});

describe("LogSink failures at open", () => {
	it("an unwritable log dir fails soft instead of hanging", () => {
		const blockedRoot = join(root, "readonly");
		mkdirSync(blockedRoot, { recursive: true });
		chmodSync(blockedRoot, 0o500);
		const blocked = new LogSink(join(blockedRoot, "sub", "x.log"), 1_000);
		blocked.open("# header");
		blocked.write("data\n");
		chmodSync(blockedRoot, 0o700);
		expect(blocked.error).toBeDefined();
		expect(blocked.note()).toContain("unavailable");
		blocked.close();
	});

	it("a file in the path position fails soft", () => {
		const file = join(root, "plain.log");
		writeFileSync(file, "x");
		const notADir = new LogSink(join(file, "nested.log"), 1_000);
		notADir.open("# header");
		expect(notADir.error).toBeDefined();
		notADir.close();
	});
});

describe("readTail", () => {
	it("ends with the newest line and never duplicates across generations", () => {
		const file = join(root, "tail.log");
		const sink = new LogSink(file, 400);
		sink.open("# h");
		fill(sink, 60, (i) => `line ${i}\n`);
		sink.close();
		const tail = readTail(file, 40, LIMITS.logTailBytes);
		expect(tail.error).toBeUndefined();
		expect(tail.lines.at(-1)).toBe("line 59");
		expect(new Set(tail.lines).size).toBe(tail.lines.length);
	});

	it("a window starting right after a newline keeps that line whole", () => {
		const exact = join(root, "exact.log");
		writeFileSync(exact, "aaaa\nbbbb\ncccc\n");
		const cut = readTail(exact, 10, 10);
		expect(cut.lines.includes("bbbb") || cut.lines.includes("cccc")).toBe(true);
		expect(cut.lines.every((line) => line.length === 4)).toBe(true);
	});

	it("a missing file is empty, not an error", () => {
		const missing = readTail(join(root, "nope.log"), 5, 1024);
		expect(missing.error).toBeUndefined();
		expect(missing.lines).toHaveLength(0);
	});

	it("a non-ENOENT read failure surfaces instead of looking empty", () => {
		const denied = join(root, "denied.log");
		writeFileSync(denied, "secret\n");
		chmodSync(denied, 0o000);
		const result = readTail(denied, 5, 1024);
		chmodSync(denied, 0o600);
		expect(result.error).toBeDefined();
	});
});
