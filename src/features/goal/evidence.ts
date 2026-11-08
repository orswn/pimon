// Built from session messages, never from the claim text. Tool results carry the proof.

interface ContentPart {
	type?: string;
	text?: string;
	name?: string;
}

interface SessionMessage {
	role?: string;
	content?: unknown;
	toolName?: string;
	stopReason?: string;
	timestamp?: string | number;
}

interface BranchEntry {
	type?: string;
	timestamp?: string | number;
	message?: SessionMessage;
}

interface EvidenceLimits {
	maxItems: number;
	maxCharsPerItem: number;
	maxTotalChars: number;
}

export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = {
	maxItems: 24,
	maxCharsPerItem: 2_000,
	maxTotalChars: 24_000,
};

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		const part = raw as ContentPart;
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
		else if (part.type === "toolCall" && part.name) parts.push(`[calls ${part.name}]`);
	}
	return parts.join("\n");
}

function clip(text: string, max: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	const head = Math.floor(max * 0.4);
	const tail = max - head;
	return `${trimmed.slice(0, head)}\n[... ${trimmed.length - max} characters omitted ...]\n${trimmed.slice(-tail)}`;
}

function entryTime(entry: BranchEntry): number | undefined {
	const raw = entry.timestamp ?? entry.message?.timestamp;
	if (typeof raw === "number") return raw;
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

/**
 * Newest first while collecting, oldest first in the output, so it reads as a
 * transcript. `since` scopes it to the current goal: without it, a previous goal's
 * passing test run is available as evidence for a new identical goal that never ran
 * anything.
 */
export function buildEvidence(
	entries: readonly BranchEntry[],
	limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS,
	since?: number,
): string {
	const collected: string[] = [];
	let total = 0;

	for (let index = entries.length - 1; index >= 0 && collected.length < limits.maxItems; index--) {
		const entry = entries[index];
		const message = entry?.message;
		if (!message) continue;
		if (since !== undefined) {
			const when = entryTime(entry);
			// An undated entry is not provably part of this goal, so it is excluded.
			if (when === undefined) continue;
			// The branch is in append order, so every earlier entry is older too.
			if (when < since) break;
		}
		const role = message.role;
		if (role !== "assistant" && role !== "toolResult") continue;
		const text = textOf(message.content);
		if (!text.trim()) continue;
		const label = role === "assistant" ? "assistant" : `tool:${message.toolName ?? "result"}`;
		const item = `<${label}>\n${clip(text, limits.maxCharsPerItem)}\n</${label}>`;
		if (total + item.length > limits.maxTotalChars) break;
		total += item.length;
		collected.push(item);
	}

	return collected.reverse().join("\n\n");
}
