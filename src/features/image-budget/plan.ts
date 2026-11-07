// Anthropic rejects Messages API requests above 32 MB. Compaction cannot prevent that: it counts an image as
// 4800 chars while a screenshot is about 1 MB of base64. Each omission is one prompt-cache miss, so act late and in a batch.

export interface Block {
	type: string;
	data?: string;
	text?: string;
	[key: string]: unknown;
}

export interface PlanEntry {
	id: string;
	role: string;
	content: string | Block[];
}

export interface Omission {
	targetId: string;
	content: Block[];
	images: number;
	bytes: number;
}

export interface Plan {
	beforeBytes: number;
	afterBytes: number;
	omissions: Omission[];
	reachedTarget: boolean;
}

export interface Budget {
	triggerBytes: number;
	targetBytes: number;
	keepRecentImages: number;
}

export interface PlanOptions {
	protectedIds?: ReadonlySet<string>;
	paths?: ReadonlyMap<string, string>;
	toolCallIds?: ReadonlyMap<string, string>;
}

export const DEFAULT_BUDGET: Budget = { triggerBytes: 28_000_000, targetBytes: 20_000_000, keepRecentImages: 8 };

const isImage = (block: Block): block is Block & { data: string } =>
	block.type === "image" && typeof block.data === "string";

const withoutData = (content: unknown) =>
	JSON.stringify(content, (key, value: unknown) => (key === "data" ? undefined : value)) ?? "";

function imageBytes(content: PlanEntry["content"]): number {
	if (!Array.isArray(content)) return 0;
	let bytes = 0;
	for (const block of content) if (isImage(block)) bytes += block.data.length;
	return bytes;
}

function imageCount(content: PlanEntry["content"]): number {
	return Array.isArray(content) ? content.filter(isImage).length : 0;
}

/** Request size estimate: base64 image payload plus the JSON of everything else. */
export function estimateBytes(entries: readonly PlanEntry[]): number {
	let bytes = 0;
	for (const entry of entries) bytes += imageBytes(entry.content) + withoutData(entry.content).length;
	return bytes;
}

export function placeholder(path: string | undefined): string {
	const where = path ? ` Path: ${path}.` : "";
	return `[Image omitted from model context to stay under the provider request size limit.${where} Read the file again if you need to see it.]`;
}

export function planOmissions(
	entries: readonly PlanEntry[],
	budget: Budget = DEFAULT_BUDGET,
	options: PlanOptions = {},
): Plan {
	const beforeBytes = estimateBytes(entries);
	if (beforeBytes <= budget.triggerBytes)
		return { beforeBytes, afterBytes: beforeBytes, omissions: [], reachedTarget: true };

	// The newest images are the ones the model is most likely still working with.
	const recent = new Set<string>();
	let seen = 0;
	for (let i = entries.length - 1; i >= 0 && seen < budget.keepRecentImages; i--) {
		const entry = entries[i];
		if (!entry) continue;
		const count = imageCount(entry.content);
		if (count > 0) {
			recent.add(entry.id);
			seen += count;
		}
	}

	let afterBytes = beforeBytes;
	const omissions: Omission[] = [];
	for (const entry of entries) {
		if (afterBytes <= budget.targetBytes) break;
		if (entry.role !== "toolResult" || !Array.isArray(entry.content)) continue;
		if (recent.has(entry.id) || options.protectedIds?.has(entry.id)) continue;
		const bytes = imageBytes(entry.content);
		if (bytes === 0) continue;
		const path = options.paths?.get(options.toolCallIds?.get(entry.id) ?? "");
		const content = entry.content.map((block): Block =>
			isImage(block) ? { type: "text", text: placeholder(path) } : block,
		);
		const saved = bytes + withoutData(entry.content).length - JSON.stringify(content).length;
		omissions.push({ targetId: entry.id, content, images: imageCount(entry.content), bytes: saved });
		afterBytes -= saved;
	}
	return { beforeBytes, afterBytes, omissions, reachedTarget: afterBytes <= budget.targetBytes };
}
