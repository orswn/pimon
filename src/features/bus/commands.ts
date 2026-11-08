import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ActionHost,
	type ActionResult,
	busStatusAction,
	doctorAction,
	inboxAction,
	peersAction,
	pendingAction,
	probeAction,
	sendAction,
} from "./tool.ts";

export function registerCommands(pi: ExtensionAPI, host: ActionHost): void {
	const command = (name: string, description: string, run: (args: string) => ActionResult | Promise<ActionResult>) => {
		pi.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				try {
					const result = await run(args.trim());
					ctx.ui.notify(result.text, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	};

	command("bus", "Show pi-bus status and identity", () => busStatusAction(host));
	command("bus-peers", "List pi instances on the bus", () => peersAction(host));
	command("bus-inbox", "Show recent bus messages: /bus-inbox [unread]", (args) =>
		inboxAction(host, { limit: 15, unreadOnly: args === "unread" }),
	);
	command("bus-send", "Send a bus message: /bus-send <selector> <text>", (args) => {
		const [target, ...rest] = args.split(/\s+/);
		const body = rest.join(" ").trim();
		if (!target || !body) throw new Error("usage: /bus-send <selector> <text>");
		return sendAction(host, { action: "send", target, body, kind: "note", wake: "now" });
	});
	command("bus-probe", "Probe peers: /bus-probe [selector]", (args) => probeAction(host, args || undefined));
	command("bus-pending", "Show questions still awaiting a reply", () => pendingAction(host));
	command("bus-doctor", "Diagnose the bus: identity, peers, stale entries", () => doctorAction(host));
}
