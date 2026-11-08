import { existsSync, writeFileSync } from "node:fs";
import { type SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export const CONTEXT_MODES = ["isolated", "handoff", "fork"] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];
export const MAX_HANDOFF_BYTES = 16 * 1024;

export interface SpawnContext {
	mode: ContextMode;
	brief?: string;
}

function isContextMode(value: string): value is ContextMode {
	return (CONTEXT_MODES as readonly string[]).includes(value);
}

export function resolveContextMode(
	context: string | undefined,
	brief: string | undefined,
): SpawnContext | { error: string } {
	const mode = (context?.trim() || "isolated").toLowerCase();
	if (!isContextMode(mode)) {
		return { error: `Unknown context mode "${context}". Valid values: ${CONTEXT_MODES.join(", ")}.` };
	}
	const normalizedBrief = brief?.trim();
	if (mode === "handoff" && !normalizedBrief) return { error: 'Context mode "handoff" requires a non-empty brief.' };
	if (mode !== "handoff" && brief !== undefined)
		return { error: 'The brief is only valid with context mode "handoff".' };
	if (normalizedBrief && Buffer.byteLength(normalizedBrief, "utf8") > MAX_HANDOFF_BYTES) {
		return {
			error: `The handoff brief exceeds the ${MAX_HANDOFF_BYTES}-byte limit. Put large evidence in a temporary file and reference its path.`,
		};
	}
	return normalizedBrief ? { mode, brief: normalizedBrief } : { mode };
}

export function buildInitialPrompt(task: string, context: SpawnContext): string {
	if (context.mode !== "handoff") return `Task: ${task}`;
	return `Context handoff:\n${context.brief}\n\nTask:\n${task}`;
}

function containsToolCall(entry: SessionEntry, toolCallId: string): boolean {
	if (entry.type !== "message" || entry.message.role !== "assistant") return false;
	if (!Array.isArray(entry.message.content)) return false;
	return entry.message.content.some((part) => {
		if (!part || typeof part !== "object") return false;
		const candidate = part as { type?: string; id?: string; toolCallId?: string };
		return (
			(candidate.type === "toolCall" || candidate.type === "tool_call") &&
			(candidate.id === toolCallId || candidate.toolCallId === toolCallId)
		);
	});
}

export function safeForkLeaf(manager: Pick<SessionManager, "getBranch">, toolCallId: string): string {
	const branch = manager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (!entry || !containsToolCall(entry, toolCallId)) continue;
		if (!entry.parentId) {
			throw new Error("Cannot fork before the current spawn call because the session has no completed history.");
		}
		return entry.parentId;
	}
	throw new Error("Cannot fork: the current pi_agents tool call is not persisted in the parent session.");
}

export function createForkSession(parentSessionFile: string | undefined, cwd: string, toolCallId: string): string {
	if (!parentSessionFile) throw new Error('Context mode "fork" requires a persistent parent session.');
	// createBranchedSession mutates its manager, so never branch the live parent.
	const clone = SessionManager.open(parentSessionFile);
	if (clone.getCwd() !== cwd) {
		throw new Error(`Context mode "fork" requires cwd "${cwd}", matching the parent session cwd "${clone.getCwd()}".`);
	}
	const leaf = safeForkLeaf(clone, toolCallId);
	const sessionFile = clone.createBranchedSession(leaf);
	if (!sessionFile) throw new Error("Cannot fork: the parent session did not produce a persistent child session file.");
	if (!existsSync(sessionFile)) {
		const header = clone.getHeader();
		if (!header) throw new Error("Cannot fork: the child session header is unavailable.");
		const entries = [header, ...clone.getEntries()].map((entry) => JSON.stringify(entry)).join("\n");
		writeFileSync(sessionFile, `${entries}\n`, { encoding: "utf8", mode: 0o600 });
	}
	return sessionFile;
}
