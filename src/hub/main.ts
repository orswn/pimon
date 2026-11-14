import { ConfigError, loadConfig } from "./config.ts";
import { startHub } from "./server.ts";

const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

async function main(): Promise<void> {
	const config = loadConfig(process.argv.slice(2), process.env);
	const options: Parameters<typeof startHub>[0] = {
		listen: `${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`,
		dataDir: config.data,
		testAgents: config.testAgents,
		presenceGraceMs: config.presenceGraceMs,
		heartbeatMs: config.heartbeatMs,
		pushAllow: config.pushAllow,
		log,
	};
	if (config.tokensFile) options.tokensFile = config.tokensFile;
	if (config.externalFile) options.externalFile = config.externalFile;
	if (config.publicUrl) options.publicUrl = config.publicUrl;
	if (!config.tokensFile && !config.testAgents) log("warning: no token file; only /healthz and cards answer");
	const hub = await startHub(options);
	process.stdout.write(`listening ${hub.port}\n`);

	let stopping = false;
	const stop = (signal: string) => {
		if (stopping) return;
		stopping = true;
		log(`${signal}: stopping`);
		hub.close().then(
			() => process.exit(0),
			(error: unknown) => {
				log(`stop failed: ${String(error)}`);
				process.exit(1);
			},
		);
	};
	process.on("SIGTERM", () => stop("SIGTERM"));
	process.on("SIGINT", () => stop("SIGINT"));
	process.on("SIGHUP", () => {
		try {
			hub.reloadTokens();
			log("SIGHUP: tokens reloaded");
		} catch (error) {
			log(`SIGHUP: token reload failed, old tokens kept: ${String(error)}`);
		}
		if (!config.externalFile) return;
		try {
			hub.reloadExternal();
			log(`SIGHUP: external agents reloaded: ${hub.hub.gateway.size}`);
		} catch (error) {
			log(`SIGHUP: external reload failed, old agents kept: ${String(error)}`);
		}
	});
}

main().catch((error: unknown) => {
	if (error instanceof ConfigError) {
		process.stderr.write(`${error.message}\n`);
		process.exit(2);
	}
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exit(1);
});
