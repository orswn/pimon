import { defineFeature } from "../../core/feature.ts";
import { ancestorMcpServers, discoverResources } from "./paths.ts";

export const ancestorConfig = defineFeature({
	id: "ancestor-config",
	description: "Load skills, prompts, and MCP servers from workspace directories above the repo, up to $HOME",
	defaultEnabled: true,
	setup(ctx) {
		ctx.pi.on("resources_discover", (event, extensionCtx) =>
			discoverResources(event.cwd, extensionCtx.isProjectTrusted()),
		);

		ctx.onSessionStart((_event, extensionCtx) => {
			if (!extensionCtx.isProjectTrusted()) return;
			const { servers, errors } = ancestorMcpServers(extensionCtx.cwd);
			for (const [name, { config, source }] of servers) {
				try {
					ctx.pi.registerMcpServer(name, config);
				} catch (error) {
					errors.push(`${source}: server "${name}": ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (errors.length > 0) extensionCtx.ui.notify(`ancestor-config:\n${errors.join("\n")}`, "warning");
		});
	},
});
