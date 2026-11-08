import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface BranchEntry {
	message?: { role?: string; content?: unknown };
}

/** Names of the other tool calls in the assistant message that issued `toolCallId`. */
export function siblingToolCalls(branch: readonly unknown[], toolCallId: string): string[] {
	for (let index = branch.length - 1; index >= 0; index--) {
		const message = (branch[index] as BranchEntry | undefined)?.message;
		if (message?.role !== "assistant") continue;
		const calls = (Array.isArray(message.content) ? message.content : []).filter(
			(part) => (part as { type?: string }).type === "toolCall",
		) as { id?: string; name?: string }[];
		if (!calls.some((call) => call.id === toolCallId)) return [];
		return calls.filter((call) => call.id !== toolCallId).map((call) => call.name ?? "a tool");
	}
	return [];
}

export interface OnlyCallCheck {
	nested: boolean;
	siblings: string[];
}

/** A call is alone when the model issued it directly and its message has no other tool call. */
export function checkOnlyCall(
	event: { toolCallId: string; parentToolCallId?: string | undefined },
	ctx: Pick<ExtensionContext, "sessionManager">,
): OnlyCallCheck | undefined {
	if (event.parentToolCallId !== undefined) return { nested: true, siblings: [] };
	const siblings = siblingToolCalls(ctx.sessionManager.getBranch(), event.toolCallId);
	return siblings.length > 0 ? { nested: false, siblings } : undefined;
}
