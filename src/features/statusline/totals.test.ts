import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { type ContextUsage, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vite-plus/test";
import { cacheHitRate, createStatsCache, type StatsSource } from "./totals.ts";

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(u: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: u,
		stopReason: "stop",
		timestamp: 0,
	};
}

function source(manager: SessionManager, model = { provider: "faux", id: "faux-1" }) {
	const getContextUsage = vi.fn((): ContextUsage => ({ tokens: 100, contextWindow: 1000, percent: 10 }));
	const getEntries = vi.spyOn(manager, "getEntries");
	const src: StatsSource = { sessionManager: manager, model, getContextUsage };
	return { src, getEntries, getContextUsage };
}

describe("session stats cache", () => {
	it("walks the session once for two reads with the same leaf", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendMessage(assistant(usage(10, 5)));
		const { src, getEntries, getContextUsage } = source(manager);
		const cache = createStatsCache();
		cache.get(src);
		cache.get(src);
		expect(getEntries).toHaveBeenCalledTimes(1);
		expect(getContextUsage).toHaveBeenCalledTimes(1);
	});

	it("recomputes after a new entry and after a model change", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendMessage(assistant(usage(10, 5)));
		const { src, getEntries } = source(manager);
		const cache = createStatsCache();
		expect(cache.get(src).totals.output).toBe(5);
		manager.appendMessage(assistant(usage(1, 2)));
		expect(cache.get(src).totals.output).toBe(7);
		expect(getEntries).toHaveBeenCalledTimes(2);
		cache.get({ ...src, model: { provider: "other", id: "faux-1" } });
		expect(getEntries).toHaveBeenCalledTimes(3);
	});

	it("sums assistant messages, usage entries, and compaction usage over all entries", () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendMessage(assistant(usage(10, 5, 100, 20, 0.5)));
		manager.appendUsage("cache_warm", "faux", "faux-1", usage(1, 0, 50, 0, 0.25));
		manager.appendCompaction("summary", null, 1000, undefined, false, usage(200, 30, 0, 0, 1));
		const { src } = source(manager);
		const stats = createStatsCache().get(src);
		expect(stats.totals).toEqual({ input: 211, output: 35, cacheRead: 150, cacheWrite: 20, cost: 1.75 });
		expect(stats.context).toEqual({ tokens: 100, contextWindow: 1000, percent: 10 });
	});

	it("counts entries off the current branch", () => {
		const manager = SessionManager.inMemory("/tmp");
		const first = manager.appendMessage(assistant(usage(10, 5)));
		manager.appendMessage(assistant(usage(10, 7)));
		manager.branch(first);
		const { src } = source(manager);
		expect(createStatsCache().get(src).totals.output).toBe(12);
	});
});

describe("cache hit rate", () => {
	it("is the read share of all prompt tokens", () => {
		expect(cacheHitRate(10, 30, 10)).toBe(60);
		expect(cacheHitRate(0, 0, 0)).toBeUndefined();
	});
});
