import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Gap, gapSummary } from "./gap.ts";

type RenderArgs = Parameters<MessageRenderer<Gap>>;

export function renderGap(
	message: Pick<RenderArgs[0], "content" | "details">,
	{ expanded, outputPad }: Pick<RenderArgs[1], "expanded" | "outputPad">,
	theme: RenderArgs[2],
): Text {
	const summary = message.details ? gapSummary(message.details) : "session gap";
	const content = typeof message.content === "string" ? message.content : "";
	const body = expanded && content ? `\n${content}` : "";
	return new Text(theme.fg("dim", `${summary}${body}`), outputPad, 0);
}
