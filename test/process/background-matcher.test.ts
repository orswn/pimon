import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vite-plus/test";
import { createMatcher, type Matcher } from "../../src/features/background/matcher.ts";
import { LIMITS } from "../../src/features/background/options.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await sleep(10);
	}
	return false;
}

function recorder(mode: "literal" | "regex", source: string, ignoreCase = false) {
	const hits: string[] = [];
	const failures: string[] = [];
	const matcher: Matcher = createMatcher(mode, source, ignoreCase, {
		onMatch: (line) => hits.push(line),
		onFailure: (reason) => failures.push(reason),
	});
	return { hits, failures, matcher };
}

describe("literal matcher", () => {
	it("matches a substring synchronously and is case sensitive by default", () => {
		const { hits, failures, matcher } = recorder("literal", "All checks passed");
		expect(matcher.mode).toBe("literal");
		matcher.push("noise");
		matcher.push("=> All checks passed <=");
		expect(hits).toEqual(["=> All checks passed <="]);
		expect(matcher.stats()).toEqual({ dropped: 0, inflight: 0, queued: 0 });
		matcher.push("ALL CHECKS PASSED");
		expect(hits).toHaveLength(1);
		expect(failures).toHaveLength(0);
		matcher.dispose();
	});

	it("ignoreCase works", () => {
		const { hits, matcher } = recorder("literal", "listening on port", true);
		matcher.push("Server LISTENING ON PORT 3000");
		expect(hits).toHaveLength(1);
	});

	it("a dot is a dot, not a wildcard", () => {
		const { hits, matcher } = recorder("literal", "a.b");
		matcher.push("axb");
		matcher.push("a.b");
		expect(hits).toEqual(["a.b"]);
	});

	it("a disposed literal matcher reports nothing", () => {
		const { hits, matcher } = recorder("literal", "gone");
		matcher.dispose();
		matcher.push("gone");
		expect(hits).toHaveLength(0);
	});
});

describe("regex matcher", () => {
	it("matches through the worker and drains its queue", async () => {
		const { hits, failures, matcher } = recorder("regex", "FAILED|passed");
		expect(matcher.mode).toBe("regex");
		matcher.push("2 tests FAILED");
		matcher.push("nothing here");
		expect(await waitFor(() => hits.length > 0)).toBe(true);
		expect(hits[0]).toBe("2 tests FAILED");
		await sleep(150);
		expect(hits).toHaveLength(1);
		expect(failures).toHaveLength(0);
		expect(matcher.stats()).toMatchObject({ queued: 0, inflight: 0 });
		matcher.dispose();
	});

	it("bounds a catastrophic pattern near the deadline while the host loop keeps running", async () => {
		// Validation rejects this shape. Built directly to prove the last line of defense.
		const { hits, failures, matcher } = recorder("regex", "(a+)+b");
		await sleep(200);
		let ticks = 0;
		const heartbeat = setInterval(() => ticks++, 20);
		const started = Date.now();
		matcher.push("a".repeat(40));
		const failed = await waitFor(() => failures.length > 0, LIMITS.matchDeadlineMs + 6_000);
		const elapsed = Date.now() - started;
		clearInterval(heartbeat);
		expect(failed).toBe(true);
		expect(failures[0]).toContain("terminated");
		expect(elapsed).toBeLessThan(LIMITS.matchDeadlineMs + 2_000);
		expect(ticks).toBeGreaterThan(10);
		expect(hits).toHaveLength(0);
		matcher.push("more lines");
		await sleep(100);
		expect(hits).toHaveLength(0);
		matcher.dispose();
	});

	it("keeps its queue bounded under load and counts drops", async () => {
		const { failures, matcher } = recorder("regex", "^x{0,200}HIT");
		await sleep(200);
		const flood = LIMITS.matchQueueMax * 3;
		for (let i = 0; i < flood; i++) matcher.push(`${"x".repeat(50)} line ${i}`);
		const stats = matcher.stats();
		expect(stats.queued).toBeLessThanOrEqual(LIMITS.matchQueueMax);
		expect(stats.dropped).toBeGreaterThan(0);
		expect(stats.dropped + stats.queued + stats.inflight).toBeLessThanOrEqual(flood);
		expect(failures).toHaveLength(0);
		matcher.dispose();
	});

	it("fails an invalid pattern through onFailure, and another matcher keeps working", async () => {
		const bad = recorder("regex", "([unclosed");
		expect(await waitFor(() => bad.failures.length > 0, 5_000)).toBe(true);
		expect(bad.failures[0]).toMatch(/invalid regex|worker/i);
		bad.matcher.dispose();
		const good = recorder("regex", "STILL WORKS");
		good.matcher.push("STILL WORKS here");
		expect(await waitFor(() => good.hits.length > 0)).toBe(true);
		good.matcher.dispose();
	});

	it("a disposed matcher reports nothing, and disposing twice is harmless", async () => {
		const { hits, matcher } = recorder("regex", "gone");
		await sleep(150);
		matcher.dispose();
		matcher.push("gone");
		await sleep(200);
		expect(hits).toHaveLength(0);
		expect(() => matcher.dispose()).not.toThrow();
	});
});
