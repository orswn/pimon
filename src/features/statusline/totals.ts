import type { Usage } from "@earendil-works/pi-ai";
import type { ContextUsage, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface StatsSource {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getLeafId" | "getEntries"> & {
		/** On pi's SessionManager, but not in the read-only type that extensions get. */
		getEntryCount?: () => number;
	};
	model: { provider: string; id: string } | undefined;
	getContextUsage(): ContextUsage | undefined;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface SessionStats {
	totals: UsageTotals;
	context: ContextUsage | undefined;
}

export function cacheHitRate(input: number, cacheRead: number, cacheWrite: number): number | undefined {
	const promptTokens = input + cacheRead + cacheWrite;
	return promptTokens > 0 ? (cacheRead / promptTokens) * 100 : undefined;
}

function add(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

function sumEntries(source: StatsSource): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of source.sessionManager.getEntries()) {
		if (entry.type === "usage") add(totals, entry.usage);
		else if (entry.type === "message" && entry.message.role === "assistant") add(totals, entry.message.usage);
		else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage)
			add(totals, entry.message.usage);
		else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) add(totals, entry.usage);
	}
	return totals;
}

/** Same key as pi's footer: an append and a move back to the old leaf between two renders keep the leaf. */
export function createStatsCache() {
	let key: string | undefined;
	let stats: SessionStats | undefined;
	return {
		get(source: StatsSource): SessionStats {
			const next = JSON.stringify([
				source.sessionManager.getSessionId(),
				source.sessionManager.getLeafId(),
				source.sessionManager.getEntryCount?.(),
				source.model?.provider,
				source.model?.id,
			]);
			if (stats && key === next) return stats;
			stats = { totals: sumEntries(source), context: source.getContextUsage() };
			key = next;
			return stats;
		},
	};
}
