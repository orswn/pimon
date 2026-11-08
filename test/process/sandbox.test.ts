import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { describe, expect, it } from "vite-plus/test";
import { ISOLATED_ENV_KEYS, ISOLATED_ENV_PREFIXES, scrubEnv, STUBBED_COMMANDS } from "../support/sandbox.ts";

const isolated = (key: string) =>
	ISOLATED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
	(ISOLATED_ENV_KEYS as readonly string[]).includes(key);

const sandbox = process.env["PIMON_TEST_SANDBOX"] ?? "";

describe("test sandbox", () => {
	it("points home, runtime, and agent dirs into a temp sandbox", () => {
		expect(sandbox).not.toBe("");
		expect(homedir().startsWith(sandbox)).toBe(true);
		expect(process.env["XDG_RUNTIME_DIR"]?.startsWith(sandbox)).toBe(true);
		expect(process.env["PI_CODING_AGENT_DIR"]?.startsWith(sandbox)).toBe(true);
	});

	it("points the temp dir into the sandbox with mode 700", () => {
		expect(tmpdir().startsWith(`${sandbox}/`)).toBe(true);
		expect(statSync(tmpdir()).mode & 0o777).toBe(0o700);
	});

	it("removes the environment that reaches a live pi or terminal", () => {
		expect(Object.keys(process.env).filter(isolated)).toEqual([]);
	});

	it("scrubs every isolated key and prefix", () => {
		const env: NodeJS.ProcessEnv = { HOME: "/home/kept", PATH: "/bin" };
		for (const key of ISOLATED_ENV_KEYS) env[key] = "fake";
		for (const prefix of ISOLATED_ENV_PREFIXES) env[`${prefix}FAKE`] = "fake";
		scrubEnv(env);
		expect(env).toEqual({ HOME: "/home/kept", PATH: "/bin" });
	});

	it("scrubs the X11 and Wayland display", () => {
		const env: NodeJS.ProcessEnv = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1" };
		scrubEnv(env);
		expect(env).toEqual({});
	});

	it.each(STUBBED_COMMANDS)("resolves %s to the recording stub", (command) => {
		const path = execFileSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).trim();
		expect(path.startsWith(sandbox)).toBe(true);
	});

	it("records a desktop notification instead of sending it", () => {
		execFileSync("notify-send", ["-a", "pi", "sandbox check"]);
		expect(readFileSync(process.env["PIMON_TEST_STUB_LOG"] ?? "", "utf8")).toContain(
			"notify-send\t-a pi sandbox check",
		);
	});

	it("blocks herdr", () => {
		expect(() => execFileSync("herdr", ["pane", "list"], { stdio: "pipe" })).toThrow();
	});
});
