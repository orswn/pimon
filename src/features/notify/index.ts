import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createProcessRunner, type ExecFn } from "../../core/exec.ts";
import { defineFeature } from "../../core/feature.ts";
import { createNotifier, formatOutcome, type NotifyKind, type NotifyService } from "./channels.ts";
import { checkOnlyCall } from "./only-call.ts";
import { NOTIFY_PROMPT } from "./prompt.ts";

export type { NotifyKind, NotifyOutcome, NotifyRequest, NotifyService } from "./channels.ts";
export { formatOutcome } from "./channels.ts";
export { checkOnlyCall } from "./only-call.ts";

interface NotifyBlocked {
	message: string;
	detail?: string | undefined;
}

declare module "../../core/services.ts" {
	interface ServiceMap {
		notify: NotifyService;
	}
}

declare module "../../core/events.ts" {
	interface PimonEvents {
		"notify:blocked": NotifyBlocked;
	}
}

const NOTIFY_DESCRIPTION =
	'Send the human a desktop and phone notification. Use it only for out-of-band attention: kind="blocked" when you cannot continue without the human, kind="done" when unattended work finishes, kind="info" for anything else. It does not replace an ordinary response when the human is present.';
const BLOCKED_ALONE_REASON =
	'notify kind="blocked" must be the only tool call in its message, and cannot be called from codemode. Call it alone.';

const notifyParameters = Type.Object({
	kind: StringEnum(["info", "blocked", "done"] as const, {
		description: "blocked also pauses an active goal. done reports completion. info is anything else.",
	}),
	message: Type.String({ description: "One line, what the user needs to know" }),
	detail: Type.Optional(Type.String({ description: "Optional second line with specifics" })),
});

interface NotifyFeatureOptions {
	/** Runs notify-send and kdeconnect-cli. Tests inject a recorder. */
	exec?: ExecFn;
}

export function createNotifyFeature(options: NotifyFeatureOptions = {}) {
	return defineFeature({
		id: "notify",
		description: "Desktop and phone notifications for out-of-band human attention",
		defaultEnabled: true,
		setup(ctx): NotifyService {
			const runner = createProcessRunner();
			const notifier = createNotifier({ exec: options.exec ?? runner.run });
			ctx.onSessionShutdown(() => runner.terminateAll());

			ctx.promptSection({ name: "notify", requiresTools: ["notify"], render: () => NOTIFY_PROMPT });

			ctx.pi.on("tool_call", (event, extensionCtx) => {
				if (event.toolName !== "notify" || (event.input as { kind?: unknown }).kind !== "blocked") return undefined;
				if (!checkOnlyCall(event, extensionCtx)) return undefined;
				return { block: true, reason: BLOCKED_ALONE_REASON };
			});

			ctx.pi.registerTool({
				name: "notify",
				label: "Notify",
				description: NOTIFY_DESCRIPTION,
				parameters: notifyParameters,
				async execute(_id, params, signal) {
					const kind = params.kind as NotifyKind;
					const blocked = kind === "blocked";
					// Emitted before the fan-out, so a slow phone cannot delay the pause of a goal.
					if (blocked) ctx.events.emit("notify:blocked", { message: params.message, detail: params.detail });
					const outcome = await notifier.notify({
						kind,
						message: params.message,
						detail: params.detail,
						signal,
					});
					return {
						content: [{ type: "text", text: formatOutcome(outcome) }],
						details: {},
						...(blocked ? { terminate: true } : {}),
					};
				},
			});

			return notifier;
		},
	});
}

export const notify = createNotifyFeature();
