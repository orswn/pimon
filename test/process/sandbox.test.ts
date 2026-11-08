import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { describe, expect, it } from "vite-plus/test";
import { STUBBED_COMMANDS } from "../support/sandbox.ts";

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
		const leaked = Object.keys(process.env).filter(
			(key) =>
				key.startsWith("PI_BUS_") ||
				key.startsWith("HERDR_") ||
				["PI_ASK_SECRET_SOCK", "SUDO_ASKPASS", "TMUX", "DBUS_SESSION_BUS_ADDRESS"].includes(key),
		);
		expect(leaked).toEqual([]);
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
