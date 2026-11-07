import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const STUBBED_COMMANDS = [
	"notify-send",
	"kdeconnect-cli",
	"herdr",
	"sudo",
	"tmux",
	"kitty",
	"xdg-open",
	"paplay",
] as const;

export const ISOLATED_ENV_PREFIXES = ["PI_BUS_", "HERDR_", "PI_SECRET_"] as const;

export const ISOLATED_ENV_KEYS = [
	"PI_ASK_SECRET_SOCK",
	"PI_ASK_SECRET_REASON",
	"SUDO_ASKPASS",
	"PI_AGENT_LABEL",
	"PI_AGENTS_TOOLS",
	"PIMON_SPAWN_FILE",
	"PI_BACKGROUND_DIR",
	"PI_SESSION_FILE",
	"PI_SESSION_ID",
	"KITTY_LISTEN_ON",
	"KITTY_WINDOW_ID",
	"TMUX",
	"TMUX_PANE",
	"DBUS_SESSION_BUS_ADDRESS",
] as const;

export function scrubEnv(env: NodeJS.ProcessEnv): void {
	for (const key of Object.keys(env)) {
		if (ISOLATED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete env[key];
	}
	for (const key of ISOLATED_ENV_KEYS) delete env[key];
}

export interface Sandbox {
	root: string;
	env: Record<string, string>;
	dispose(): void;
}

export function createSandbox(): Sandbox {
	const root = mkdtempSync(join(tmpdir(), "pimon-test-"));
	const bin = join(root, "bin");
	const home = join(root, "home");
	const runtime = join(root, "runtime");
	const agent = join(root, "agent");
	mkdirSync(bin);
	mkdirSync(home);
	mkdirSync(runtime, { mode: 0o700 });
	mkdirSync(agent);
	const stub = resolve(import.meta.dirname, "bin", "stub");
	chmodSync(stub, 0o755);
	for (const command of STUBBED_COMMANDS) symlinkSync(stub, join(bin, command));
	return {
		root,
		env: {
			PIMON_TEST_SANDBOX: root,
			PIMON_TEST_STUB_LOG: join(root, "stub-calls.log"),
			PATH: `${bin}:${process.env["PATH"] ?? ""}`,
			HOME: home,
			XDG_RUNTIME_DIR: runtime,
			PI_CODING_AGENT_DIR: agent,
		},
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}
