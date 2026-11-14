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
	setStatusAction,
} from "./tool.ts";

export function registerCommands(pi: ExtensionAPI, host: ActionHost, tokenCheck: () => string): void {
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
	command("bus-peers", "List sessions on the bus", () => peersAction(host));
	command("bus-inbox", "Show recent bus messages: /bus-inbox [unread]", (args) =>
		inboxAction(host, { limit: 15, unreadOnly: args === "unread" }),
	);
	command("bus-send", "Send a bus message: /bus-send <selector> <text>", (args) => {
		const [target, ...rest] = args.split(/\s+/);
		const body = rest.join(" ").trim();
		if (!target || !body) throw new Error("usage: /bus-send <selector> <text>");
		return sendAction(host, { action: "send", target, body, kind: "note", wake: "now" });
	});
	command("bus-status", "Set the one-line status that peers see: /bus-status [text]; no text clears it", (args) =>
		setStatusAction(host, args),
	);
	command("bus-probe", "Probe peers: /bus-probe [selector]", (args) => probeAction(host, args || undefined));
	command("bus-pending", "Show questions still awaiting a reply", () => pendingAction(host));
	command("bus-doctor", "Diagnose the bus: hub health, token, link, and duplicate names", () =>
		doctorAction(host, tokenCheck),
	);
}
