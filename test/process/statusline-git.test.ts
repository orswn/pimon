import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { createStatuslineFeature } from "../../src/features/statusline/index.ts";
import { createHarness, type Harness } from "../support/harness.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

let harness: Harness | undefined;
const originalPath = process.env["PATH"];
afterEach(() => {
	process.env["PATH"] = originalPath;
	harness?.dispose();
	harness = undefined;
	clearReloadState();
});

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await sleep(20);
	}
}

/** A `git` first in PATH that records its arguments. Its child writes the marker before the 800 ms timeout unless shutdown kills the group. */
function slowGit() {
	const root = mkdtempSync(join(tmpdir(), "statusline-git-"));
	const bin = join(root, "bin");
	const log = join(root, "args.log");
	const marker = join(root, "survived");
	const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n( sleep 0.5; echo alive > '${marker}' ) &\nsleep 1\necho '## main'\n`;
	mkdirSync(bin);
	writeFileSync(join(bin, "git"), script);
	chmodSync(join(bin, "git"), 0o755);
	process.env["PATH"] = `${bin}:${originalPath ?? ""}`;
	return { log, marker };
}

describe("statusline git process", () => {
	it("runs git with optional locks off and leaves no process after shutdown", async () => {
		const git = slowGit();
		harness = await createHarness({
			features: [createStatuslineFeature({ cacheDir: join(tmpdir(), "statusline-unused") })],
			ui: {
				theme,
				// Builds the footer at once, like interactive mode.
				setFooter: (factory) => {
					factory?.({ requestRender() {} } as unknown as TUI, theme, {
						getGitBranch: () => null,
						getExtensionStatuses: () => new Map(),
						getAvailableProviderCount: () => 0,
						onBranchChange: () => () => {},
					});
				},
				setWorkingIndicator: () => {},
			},
		});
		await until(() => existsSync(git.log) && readFileSync(git.log, "utf8").includes("--no-optional-locks -C"));
		expect(readFileSync(git.log, "utf8")).toContain("--no-optional-locks -C");
		await harness.shutdown();
		await sleep(1_500);
		expect(existsSync(git.marker)).toBe(false);
	});
});
