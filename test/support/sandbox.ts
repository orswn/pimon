import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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

export const ISOLATED_ENV_PREFIXES = ["PI_BUS_", "HERDR_", "PI_SECRET_", "HUB_"] as const;

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
	"DISPLAY",
	"WAYLAND_DISPLAY",
] as const;

/** `HUB_BIN` picks the hub binary under test. It reaches no human. */
export const KEPT_ENV_KEYS = ["HUB_BIN"] as const;

export function scrubEnv(env: NodeJS.ProcessEnv): void {
	for (const key of Object.keys(env)) {
		if ((KEPT_ENV_KEYS as readonly string[]).includes(key)) continue;
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
	// globalSetup runs once per test project in one process. Without this, each root nests in the previous TMPDIR and socket paths overflow.
	const base = process.env["PIMON_TEST_OUTER_TMPDIR"] ?? tmpdir();
	const root = mkdtempSync(join(base, "pimon-test-"));
	const bin = join(root, "bin");
	const home = join(root, "home");
	const runtime = join(root, "runtime");
	const agent = join(root, "agent");
	const temp = join(root, "tmp");
	mkdirSync(bin);
	mkdirSync(home);
	mkdirSync(runtime, { mode: 0o700 });
	mkdirSync(agent);
	mkdirSync(temp, { mode: 0o700 });
	const stub = resolve(import.meta.dirname, "bin", "stub");
	chmodSync(stub, 0o755);
	for (const command of STUBBED_COMMANDS) symlinkSync(stub, join(bin, command));
	return {
		root,
		env: {
			PIMON_TEST_SANDBOX: root,
			PIMON_TEST_OUTER_TMPDIR: base,
			PIMON_TEST_STUB_LOG: join(root, "stub-calls.log"),
			PATH: `${bin}:${process.env["PATH"] ?? ""}`,
			HOME: home,
			XDG_RUNTIME_DIR: runtime,
			PI_CODING_AGENT_DIR: agent,
			TMPDIR: temp,
		},
		dispose: () => {
			killSandboxHubs(root);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/**
 * SIGKILLs each process with `--data` under `root` and returns the pids.
 * An interrupted run can leave hub processes that outlive their test worker.
 */
export function killSandboxHubs(root: string, procDir = "/proc"): number[] {
	const inside = (path: string | undefined) => path !== undefined && (path === root || path.startsWith(`${root}/`));
	const killed: number[] = [];
	for (const entry of readdirSync(procDir)) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid === process.pid) continue;
		let args: string[];
		try {
			args = readFileSync(join(procDir, entry, "cmdline"), "utf8").split("\0");
		} catch {
			continue;
		}
		const data = args.findIndex((arg) => arg === "--data" || arg.startsWith("--data="));
		if (data < 0) continue;
		const value = args[data] === "--data" ? args[data + 1] : args[data]?.slice("--data=".length);
		if (!inside(value)) continue;
		try {
			process.kill(pid, "SIGKILL");
			killed.push(pid);
		} catch {
			// Already gone.
		}
	}
	return killed;
}
