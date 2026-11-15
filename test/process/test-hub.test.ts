import { chmodSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { startTestHub, tempDir } from "../support/hub.ts";
import { hubBinary } from "../support/hub-process.ts";

const KEEP_RUNNING = `#!/usr/bin/env node
import { createServer } from "node:http";
process.on("SIGTERM", () => {});
const server = createServer((_req, res) => res.end("{}"));
server.listen(0, "127.0.0.1", () => process.stdout.write(\`listening \${server.address().port}\\n\`));
`;

const EXIT_AT_ONCE = `#!/bin/sh
exit 3
`;

describe("test hub", () => {
	const saved = process.env["HUB_BIN"];
	const dirs: { dispose(): void }[] = [];
	afterEach(() => {
		if (saved === undefined) delete process.env["HUB_BIN"];
		else process.env["HUB_BIN"] = saved;
		for (const dir of dirs.splice(0)) dir.dispose();
	});

	function fakeHub(name: string, script: string): void {
		const dir = tempDir("fake-hub-");
		dirs.push(dir);
		const file = join(dir.dir, name);
		writeFileSync(file, script);
		chmodSync(file, 0o755);
		process.env["HUB_BIN"] = file;
	}

	it("kills a hub that ignores SIGTERM after a bounded wait", async () => {
		fakeHub("keep-running.mjs", KEEP_RUNNING);
		const hub = await startTestHub();
		const started = Date.now();
		await hub.close();
		expect(Date.now() - started).toBeLessThan(5_000);
		await expect(fetch(`${hub.url}/healthz`)).rejects.toThrow();
	}, 10_000);

	it("runs HUB_BIN, else the fetched binary, and says how to fetch a missing one", () => {
		const dir = tempDir("fetched-hub-");
		dirs.push(dir);
		const fetched = join(dir.dir, "a2a-hub");
		expect(hubBinary({ HUB_BIN: "/opt/hub" }, fetched)).toBe("/opt/hub");
		expect(() => hubBinary({}, fetched)).toThrow(
			`no hub binary at ${fetched}: run scripts/fetch-hub.sh, or set HUB_BIN`,
		);
		writeFileSync(fetched, "");
		expect(hubBinary({}, fetched)).toBe(fetched);
	});

	it("deletes its temp dir when the hub does not start", async () => {
		fakeHub("exit.sh", EXIT_AT_ONCE);
		const before = readdirSync(tmpdir()).filter((name) => name.startsWith("pimon-test-hub-"));
		await expect(startTestHub()).rejects.toThrow("hub exited with 3");
		const after = readdirSync(tmpdir()).filter((name) => name.startsWith("pimon-test-hub-"));
		expect(after).toEqual(before);
	});
});
