import type { ContextEditEntryDraft, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineFeature } from "../../core/feature.ts";
import { type Block, type Budget, hasImages, type PlanEntry, planOmissions } from "./plan.ts";

type EditableContent = NonNullable<ContextEditEntryDraft["replacement"]>["content"];

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
const STUCK_REPEAT_BYTES = 4_000_000;

/** Warn about a context that cannot shrink once, then again only after it grows by another 4 MB. */
export function shouldWarnStuck(bytes: number, lastWarnedBytes: number): boolean {
	return lastWarnedBytes === 0 || bytes >= lastWarnedBytes + STUCK_REPEAT_BYTES;
}

const configSchema = Type.Object(
	{
		triggerBytes: Type.Integer({ minimum: 1, default: 28_000_000 }),
		targetBytes: Type.Integer({ minimum: 1, default: 20_000_000 }),
		keepRecentImages: Type.Integer({ minimum: 0, default: 8 }),
	},
	{ additionalProperties: false },
);

interface Projection {
	entries: PlanEntry[];
	protectedIds: Set<string>;
	paths: Map<string, string>;
	toolCallIds: Map<string, string>;
}

export function project(event: Pick<TurnEndEvent, "context" | "toolResultEntryIds">): Projection {
	const entries: PlanEntry[] = [];
	const toolCallIds = new Map<string, string>();
	const paths = new Map<string, string>();
	const protectedIds = new Set(event.toolResultEntryIds);
	for (const projected of event.context.contextEntries) {
		const source = projected.sourceEntry;
		for (const message of projected.messages) {
			if (!("content" in message) || message.content === undefined) continue;
			entries.push({ id: source.id, role: message.role, content: message.content as string | Block[] });
			// Only plain message entries can take a context edit.
			if (source.type !== "message") protectedIds.add(source.id);
			if (message.role === "toolResult" && source.type === "message") toolCallIds.set(source.id, message.toolCallId);
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const path = (block.arguments as { path?: unknown }).path;
					if (typeof path === "string") paths.set(block.id, path);
				}
			}
		}
	}
	return { entries, protectedIds, paths, toolCallIds };
}

export const imageBudget = defineFeature({
	id: "image-budget",
	description: "Replace old tool-result images with placeholders before the request passes the provider size limit",
	defaultEnabled: true,
	configSchema,
	setup(ctx) {
		const budget: Budget = ctx.config;
		if (budget.targetBytes >= budget.triggerBytes) {
			throw new Error(`targetBytes (${budget.targetBytes}) must be below triggerBytes (${budget.triggerBytes})`);
		}
		let lastStuckWarning = 0;
		const warnStuck = (bytes: number, ui: ExtensionContext) => {
			if (!ui.hasUI || !shouldWarnStuck(bytes, lastStuckWarning)) return;
			lastStuckWarning = bytes;
			ui.ui.notify(
				`image-budget: context is ${mb(bytes)}. Recent and user images cannot be omitted. Use /compact or /new before it reaches the provider limit.`,
				"warning",
			);
		};

		ctx.pi.on("turn_end", (event, extensionCtx) => {
			const projection = project(event);
			// Only images can be omitted, so a context without one needs no size estimate.
			if (!hasImages(projection.entries)) return undefined;
			const plan = planOmissions(projection.entries, budget, projection);
			if (plan.omissions.length === 0) {
				if (plan.beforeBytes > budget.triggerBytes) warnStuck(plan.beforeBytes, extensionCtx);
				return undefined;
			}
			lastStuckWarning = 0;
			const images = plan.omissions.reduce((sum, omission) => sum + omission.images, 0);
			if (extensionCtx.hasUI) {
				extensionCtx.ui.notify(
					`image-budget: omitted ${images} old image(s) from context, ${mb(plan.beforeBytes)} to ${mb(plan.afterBytes)}${plan.reachedTarget ? "" : " (target not reached)"}`,
					plan.reachedTarget ? "info" : "warning",
				);
			}
			const edits: ContextEditEntryDraft[] = plan.omissions.map((omission) => ({
				type: "context_edit",
				targetId: omission.targetId,
				replacement: { content: omission.content as EditableContent },
			}));
			return { entries: [...event.entries, ...edits] };
		});
	},
});
