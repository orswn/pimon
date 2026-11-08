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

export function registerCommands(pi: ExtensionAPI, host: () => AgentsHost): void {
	const command = (
		name: string,
		description: string,
		run: (args: string, ctx: ExtensionContext) => ActionResult | Promise<ActionResult>,
	) => {
		pi.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				try {
					const result = await run(args.trim(), ctx);
					ctx.ui.notify(result.text, result.ok === false ? "warning" : "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	};
	const agent = (args: string) => args || undefined;

	command("agents", "List child pi instances spawned from this session", () => listAction(host()));
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
