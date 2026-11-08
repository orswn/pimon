import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ActionResult,
	type AgentsHost,
	closeAction,
	focusAction,
	killAction,
	listAction,
	pruneAction,
	rolesAction,
	whereAction,
} from "./tool.ts";

type Show = (text: string, level: "info" | "warning" | "error") => void;

async function runAndShow(run: () => ActionResult | Promise<ActionResult>, show: Show): Promise<void> {
	try {
		const result = await run();
		show(result.text, result.ok === false ? "warning" : "info");
	} catch (error) {
		show(error instanceof Error ? error.message : String(error), "error");
	}
}

/** Shows what `/agents` shows. */
export function showAgentsList(host: AgentsHost, show: Show): Promise<void> {
	return runAndShow(() => listAction(host), show);
}

export function registerCommands(pi: ExtensionAPI, host: () => AgentsHost): void {
	const command = (
		name: string,
		description: string,
		run: (args: string, ctx: ExtensionContext) => ActionResult | Promise<ActionResult>,
	) => {
		pi.registerCommand(name, {
			description,
			handler: (args, ctx) =>
				runAndShow(
					() => run(args.trim(), ctx),
					(text, level) => ctx.ui.notify(text, level),
				),
		});
	};
	const agent = (args: string) => args || undefined;

	pi.registerCommand("agents", {
		description: "List child pi instances spawned from this session",
		handler: (_args, ctx) => showAgentsList(host(), (text, level) => ctx.ui.notify(text, level)),
	});
	command("agents-roles", "List available agent roles", (_args, ctx) => rolesAction(host(), ctx, { action: "roles" }));
	command("agents-where", "Show where a new child would be placed", () => whereAction(host()));
	command("agents-close", "Ask a child to finish and exit: /agents-close [name]", (args) =>
		closeAction(host(), agent(args)),
	);
	command("agents-kill", "Force stop a child and close its pane: /agents-kill [name]", (args) =>
		killAction(host(), agent(args), true),
	);
	command("agents-focus", "Focus a child's pane: /agents-focus [name]", (args) => focusAction(host(), agent(args)));
	command("agents-prune", "Forget exited or failed children whose process is gone", () => pruneAction(host()));
}
