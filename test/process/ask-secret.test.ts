import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { ASKPASS_CLIENT } from "../../src/features/ask-secret/index.ts";
import { promptOverlay } from "../../src/features/ask-secret/overlay.ts";
import { type AskpassServer, listenAskpass } from "../../src/features/ask-secret/server.ts";

interface Overlay {
	focused: boolean;
	handleInput(data: string): void;
	render(width: number): string[];
}

const CANCELLED =
	"No secret was given. The human cancelled or did not answer. Do not retry unless the human asks again.\n";

// oxlint-disable-next-line no-control-regex
const PAINTED = /\x1b\[41m[\s\S]*?\x1b\[0m/g;

let overlay: Overlay | undefined;
const theme = {
	fg: (_token: string, text: string) => text,
	colors: { warning: parseColor("#eed49f") },
	style: (text: string, options: { bg?: unknown }) => (options.bg ? `\x1b[41m${text}\x1b[0m` : text),
};
const ui = {
	custom: (factory: (...args: unknown[]) => Overlay) =>
		new Promise((resolve) => {
			const component = factory({ requestRender() {} }, theme, {}, (value: unknown) => {
				overlay = undefined;
				resolve(value);
			});
			component.focused = true;
			overlay = component;
		}),
} as unknown as ExtensionUIContext;

const root = mkdtempSync(join(tmpdir(), "pimon-askpass-proc-"));
const sockPath = join(root, "pi-ask-secret", "test.sock");
const secrets: string[] = [];
const order: string[] = [];
let server: AskpassServer | undefined;
let lastChild: ChildProcess | undefined;

function runClient(reason: string | undefined): Promise<{ code: number | null; out: string; err: string }> {
	return new Promise((resolve) => {
		const env: NodeJS.ProcessEnv = Object.fromEntries(
			Object.entries(process.env).filter(
				([key]) => key !== "SUDO_ASKPASS" && !key.startsWith("HERDR_") && !key.startsWith("PI_BUS_"),
			),
		);
		env["PI_ASK_SECRET_SOCK"] = sockPath;
		if (reason === undefined) delete env["PI_ASK_SECRET_REASON"];
		else env["PI_ASK_SECRET_REASON"] = reason;
		const child = spawn(ASKPASS_CLIENT, ["[sudo] password for x:"], { env });
		lastChild = child;
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
		child.on("close", (code) => {
			order.push("client closed");
			resolve({ code, out, err });
		});
	});
}

async function waitOverlay(): Promise<Overlay> {
	for (let i = 0; i < 100 && !overlay; i++) await sleep(20);
	if (!overlay) throw new Error("overlay did not open");
	return overlay;
}

const type = (target: Overlay, text: string) => {
	for (const ch of text) target.handleInput(ch);
};

describe("askpass socket with the real client", () => {
	beforeAll(async () => {
		server = await listenAskpass({
			sockPath,
			ask: (request, conn) => promptOverlay(ui, request, conn),
			onSecret: (secret) => {
				order.push("secret stored");
				secrets.push(secret);
			},
			onError: (error) => {
				throw error;
			},
		});
	});

	afterAll(() => {
		server?.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("listens on a socket with mode 600 in a 700 directory", () => {
		expect(statSync(sockPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(root, "pi-ask-secret")).mode & 0o777).toBe(0o700);
	});

	it("renders the reason in a masked overlay that fills its width", async () => {
		const pending = runClient("unit test");
		const target = await waitOverlay();
		const plain = target
			.render(80)
			.map((line) => stripTerminalSequences(line))
			.join("\n");
		expect(plain).toMatch(/Reason +unit test/);
		expect(plain).not.toMatch(/Caller/);
		expect(plain).not.toContain("[sudo]");
		expect(target.render(72).map((line) => visibleWidth(line))).toEqual(Array(target.render(72).length).fill(72));
		expect(target.render(40).every((line) => visibleWidth(line) === 40)).toBe(true);
		const unpainted = target.render(72).map((line) => visibleWidth(line.replace(PAINTED, "")));
		expect(unpainted.every((width) => width === 0)).toBe(true);
		expect(target.render(72).some((line) => line.includes("\x1b_pi:fc\x07"))).toBe(true);
		type(target, "hunter2");
		expect(target.render(80).some((line) => line.includes("•••••••"))).toBe(true);
		expect(target.render(80).join()).not.toContain("hunter2");
		target.handleInput("\r");
		expect(await pending).toEqual({ code: 0, out: "hunter2\n", err: "" });
	});

	it("stores the reply for redaction before the client receives it", async () => {
		order.length = 0;
		const pending = runClient("order");
		const target = await waitOverlay();
		type(target, "order-secret");
		target.handleInput("\r");
		await pending;
		expect(secrets).toContain("order-secret");
		expect(order).toEqual(["secret stored", "client closed"]);
	});

	it("wraps a long reason and caps it at 6 lines", async () => {
		const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
		const first = runClient(long);
		const target = await waitOverlay();
		const plain = target.render(72).map((line) => stripTerminalSequences(line));
		expect(plain.some((line) => line.includes("word0")) && plain.some((line) => line.includes("word39"))).toBe(true);
		expect(plain.filter((line) => /^│ {9}word/.test(line)).length).toBeGreaterThanOrEqual(1);
		expect(target.render(72).every((line) => visibleWidth(line) === 72)).toBe(true);
		const huge = runClient("x ".repeat(240));
		target.handleInput("\x1b");
		await first;
		const second = await waitOverlay();
		expect(second.render(72)).toHaveLength(6 + 6);
		second.handleInput("\x1b");
		await huge;
	});

	it("shows a missing reason and tells the model not to retry on Esc", async () => {
		const pending = runClient(undefined);
		const target = await waitOverlay();
		expect(stripTerminalSequences(target.render(80).join())).toMatch(/Reason +none given/);
		target.handleInput("\x1b");
		expect(await pending).toEqual({ code: 1, out: "", err: CANCELLED });
	});

	it("keeps newlines of a bracketed paste across chunks", async () => {
		const pending = runClient("paste");
		const target = await waitOverlay();
		target.handleInput("\x1b[200~line1\r\nli");
		target.handleInput("ne2\x1b[201~");
		target.handleInput("\r");
		expect((await pending).out).toBe("line1\nline2\n");
	});

	it("closes the overlay when the caller dies", async () => {
		const pending = runClient("killed");
		await waitOverlay();
		lastChild?.kill("SIGKILL");
		await pending;
		await sleep(100);
		expect(overlay).toBeUndefined();
	});

	it("strips control characters from the reason", async () => {
		const reasons: string[] = [];
		const other = join(root, "pi-ask-secret", "reason.sock");
		const extra = await listenAskpass({
			sockPath: other,
			ask: async (request) => {
				reasons.push(request.reason);
				return undefined;
			},
			onSecret: () => {},
			onError: () => {},
		});
		try {
			const result = await new Promise<{ code: number | null }>((resolve) => {
				const env: NodeJS.ProcessEnv = { ...process.env, PI_ASK_SECRET_SOCK: other };
				env["PI_ASK_SECRET_REASON"] = "\x1b[31mred\x07 bell\ttab\x7f end";
				const child = spawn(ASKPASS_CLIENT, [], { env });
				child.on("close", (code) => resolve({ code }));
			});
			expect(result.code).toBe(1);
			expect(reasons).toEqual(["[31mred belltab end"]);
		} finally {
			extra.close();
		}
	});

	it("narrows an existing socket directory to mode 700", async () => {
		const dir = join(root, "wide");
		mkdirSync(dir, { mode: 0o755 });
		chmodSync(dir, 0o755);
		const extra = await listenAskpass({
			sockPath: join(dir, "x.sock"),
			ask: async () => undefined,
			onSecret: () => {},
			onError: () => {},
		});
		extra.close();
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	it.skipIf(process.getuid?.() === statSync("/").uid)("refuses a socket directory owned by another user", async () => {
		const listening = listenAskpass({
			sockPath: "/pimon-test-never.sock",
			ask: async () => undefined,
			onSecret: () => {},
			onError: () => {},
		});
		await expect(listening).rejects.toThrow(/owned by uid \d+/);
		expect(existsSync("/pimon-test-never.sock")).toBe(false);
	});

	it("removes the socket on close", async () => {
		const other = join(root, "pi-ask-secret", "other.sock");
		const extra = await listenAskpass({
			sockPath: other,
			ask: async () => undefined,
			onSecret: () => {},
			onError: () => {},
		});
		expect(existsSync(other)).toBe(true);
		extra.close();
		expect(existsSync(other)).toBe(false);
	});
});
