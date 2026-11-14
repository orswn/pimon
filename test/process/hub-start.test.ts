import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { startHub } from "../../src/hub/server.ts";
import { startHubProcess, tempDir } from "../support/hub.ts";

// The hub image installs no peer dependencies, so the hub must not load typebox at run time.
const NO_TYPEBOX = `import { registerHooks } from "node:module";
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "typebox" || specifier.startsWith("typebox/")) throw new Error("the hub loaded " + specifier);
		return next(specifier, context);
	},
});`;

describe("startHub", () => {
	it("starts the hub process without the typebox package", async () => {
		const tmp = tempDir("hub-no-typebox-");
		const hub = await startHubProcess({
			dataDir: `${tmp.dir}/data`,
			testAgents: true,
			env: { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(NO_TYPEBOX)}` },
		});
		try {
			expect((await fetch(`${hub.url}/healthz`)).status).toBe(200);
			expect(hub.stderr()).not.toContain("typebox");
		} finally {
			await hub.stop();
			tmp.dispose();
		}
	});

	it("runs on an in-memory database with inline tokens and closes cleanly", async () => {
		const sha256 = createHash("sha256").update("secret").digest("hex");
		const hub = await startHub({ dataDir: ":memory:", tokens: { mars: { kind: "host", sha256 } }, log: () => {} });
		try {
			expect(hub.url).toBe(`http://127.0.0.1:${hub.port}`);
			const health = (await (await fetch(`${hub.url}/healthz`)).json()) as Record<string, unknown>;
			expect(health).toMatchObject({ ok: true, agents: 0 });
			const register = await fetch(`${hub.url}/link/register`, {
				method: "POST",
				headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
				body: JSON.stringify({ agent: "a1", protocol: 2, labels: { model: "m" } }),
			});
			expect(register.status).toBe(200);
			const big = await fetch(`${hub.url}/link/register`, {
				method: "POST",
				headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
				body: JSON.stringify({ agent: "a2", protocol: 2, cwd: "x".repeat(1024 * 1024) }),
			});
			expect(big.status).toBe(413);
		} finally {
			await hub.close();
		}
	});

	it("serves the built-in agents without a token in test mode", async () => {
		const hub = await startHub({ dataDir: ":memory:", testAgents: true, log: () => {} });
		try {
			const response = await fetch(`${hub.url}/a2a/@echo`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "SendMessage",
					params: { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "hello" }] } },
				}),
			});
			const body = (await response.json()) as { result: { task: { status: { state: string }; artifacts: unknown[] } } };
			expect(body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
			expect(body.result.task.artifacts).toEqual([
				{ artifactId: expect.any(String), name: "echo", parts: [{ text: "hello" }] },
			]);
			const wrong = await fetch(`${hub.url}/a2a/echo`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
				body: "{}",
			});
			expect(wrong.status).toBe(401);
		} finally {
			await hub.close();
		}
	});

	it("answers a malformed path with 400 and checks the token before it looks up an agent", async () => {
		const sha256 = createHash("sha256").update("secret").digest("hex");
		const hub = await startHub({ dataDir: ":memory:", tokens: { mars: { kind: "host", sha256 } }, log: () => {} });
		try {
			const auth = { Authorization: "Bearer secret", "Content-Type": "application/json" };
			await fetch(`${hub.url}/link/register`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ agent: "a1", protocol: 2 }),
			});
			expect((await fetch(`${hub.url}/a2a/%E0%A4%A`, { method: "POST", headers: auth, body: "{}" })).status).toBe(400);
			expect((await fetch(`${hub.url}/link/%E0%A4%A/events`, { headers: auth })).status).toBe(400);
			const anonymous = (path: string) => fetch(`${hub.url}/a2a/${path}`, { method: "POST", body: "{}" });
			expect((await anonymous("a1")).status).toBe(401);
			expect((await anonymous("nobody")).status).toBe(401);
			expect((await anonymous("@nobody")).status).toBe(401);
		} finally {
			await hub.close();
		}
	});

	it("refuses a push config to a loopback IP literal unless the allow list has it", async () => {
		const sha256 = createHash("sha256").update("secret").digest("hex");
		const tokens = { mars: { kind: "host" as const, sha256 } };
		for (const [pushAllow, code] of [
			[[], -32602],
			[["127.0.0.0/8"], undefined],
		] as const) {
			const hub = await startHub({ dataDir: ":memory:", tokens, pushAllow: [...pushAllow], log: () => {} });
			try {
				const headers = { Authorization: "Bearer secret", "Content-Type": "application/json", "A2A-Version": "1.0" };
				await fetch(`${hub.url}/link/register`, {
					method: "POST",
					headers,
					body: JSON.stringify({ agent: "a1", protocol: 2 }),
				});
				const rpc = async (method: string, params: unknown) =>
					(await (
						await fetch(`${hub.url}/a2a/a1`, {
							method: "POST",
							headers,
							body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
						})
					).json()) as { result?: { task?: { id: string } }; error?: { code: number; message: string } };
				const sent = await rpc("SendMessage", {
					message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "x" }] },
					configuration: { returnImmediately: true },
				});
				const taskId = sent.result?.task?.id ?? "";
				const created = await rpc("CreateTaskPushNotificationConfig", {
					taskId,
					id: "c1",
					url: "http://127.0.0.1:9/hook",
				});
				expect(created.error?.code).toBe(code);
			} finally {
				await hub.close();
			}
		}
	});

	it("sends a comment heartbeat on an A2A stream", async () => {
		const sha256 = createHash("sha256").update("secret").digest("hex");
		const hub = await startHub({
			dataDir: ":memory:",
			tokens: { mars: { kind: "host", sha256 } },
			heartbeatMs: 50,
			log: () => {},
		});
		const controller = new AbortController();
		try {
			const headers = { Authorization: "Bearer secret", "Content-Type": "application/json", "A2A-Version": "1.0" };
			await fetch(`${hub.url}/link/register`, {
				method: "POST",
				headers,
				body: JSON.stringify({ agent: "a1", protocol: 2 }),
			});
			const response = await fetch(`${hub.url}/a2a/a1`, {
				method: "POST",
				headers,
				signal: controller.signal,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "SendStreamingMessage",
					params: { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "x" }] } },
				}),
			});
			const reader = (response.body ?? expect.unreachable()).pipeThrough(new TextDecoderStream()).getReader();
			let text = "";
			while (!text.includes(": hb")) {
				const { value, done } = await reader.read();
				if (done) break;
				text += value;
			}
			expect(text).toMatch(/^data: .*"task"/);
			expect(text).toContain(": hb\n\n");
		} finally {
			controller.abort();
			await hub.close();
		}
	});
});
