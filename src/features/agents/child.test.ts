import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { awaitPlacement, sendTask } from "./child.ts";

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("first task of a spawned child", () => {
	it("queues behind a run that already started instead of failing", () => {
		const calls: unknown[][] = [];
		const pi = { sendUserMessage: (...args: unknown[]) => calls.push(args) } as unknown as ExtensionAPI;
		sendTask(pi, "Task: x");
		expect(calls).toEqual([["Task: x", { deliverAs: "followUp" }]]);
	});
});

describe("wait for the parent's placement", () => {
	let dir: string;
	let marker: string;
	let sent: number;
	const send = () => {
		sent++;
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "placed-"));
		marker = join(dir, "spawn.placed");
		sent = 0;
	});

	afterEach(() => {
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	it("sends nothing before the marker and sends once after it", async () => {
		awaitPlacement(marker, { pollMs: 10, waitMs: 5_000 }, send);
		await pause(80);
		expect(sent).toBe(0);
		writeFileSync(marker, "");
		await pause(80);
		expect(sent).toBe(1);
		expect(existsSync(marker)).toBe(false);
		await pause(50);
		expect(sent).toBe(1);
	});

	it("sends once at the deadline when no marker comes", () => {
		vi.useFakeTimers();
		awaitPlacement(marker, { pollMs: 100, waitMs: 60_000 }, send);
		vi.advanceTimersByTime(59_900);
		expect(sent).toBe(0);
		vi.advanceTimersByTime(200);
		expect(sent).toBe(1);
		vi.advanceTimersByTime(10_000);
		expect(sent).toBe(1);
	});

	it("sends nothing after it is cancelled", () => {
		vi.useFakeTimers();
		const cancel = awaitPlacement(marker, { pollMs: 100, waitMs: 60_000 }, send);
		vi.advanceTimersByTime(500);
		cancel();
		writeFileSync(marker, "");
		vi.advanceTimersByTime(120_000);
		expect(sent).toBe(0);
		expect(existsSync(marker)).toBe(true);
	});
});
