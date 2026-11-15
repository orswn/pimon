// Hub process and raw link helpers for black-box tests of an a2a-hub binary.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_HEADER, BUS_EXTENSION_URI, HARNESS, HUB_PROTOCOL } from "../../src/features/bus/hub/client.ts";

/** The protocol that this pimon speaks. */
export const PROTOCOL = HUB_PROTOCOL;
/** Where `scripts/fetch-hub.sh` puts the pinned hub. */
export const FETCHED_HUB = resolve(import.meta.dirname, "../../.hub/a2a-hub");
export const BUS_URI = BUS_EXTENSION_URI;
export { AGENT_HEADER, HARNESS };
export const HOST_TOKEN = "mars-token";
export const OTHER_HOST_TOKEN = "venus-token";
export const PEER_TOKEN = "hermes-token";

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function tempDir(prefix: string): { dir: string; dispose(): void } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeTokens(dir: string): string {
	const hex = (token: string) => createHash("sha256").update(token).digest("hex");
	const file = join(dir, "tokens.json");
	writeFileSync(
		file,
		JSON.stringify({
			mars: { kind: "host", sha256: hex(HOST_TOKEN) },
			venus: { kind: "host", sha256: hex(OTHER_HOST_TOKEN) },
			hermes: { kind: "peer", sha256: hex(PEER_TOKEN) },
		}),
	);
	return file;
}

export interface HubProcess {
	url: string;
	port: number;
	child: ChildProcess;
	stderr(): string;
	stop(signal?: NodeJS.Signals): Promise<number | null>;
}

/** The hub binary under test: env `HUB_BIN`, else the binary that `scripts/fetch-hub.sh` fetched. */
export function hubBinary(env: NodeJS.ProcessEnv = process.env, fetched = FETCHED_HUB): string {
	const bin = env["HUB_BIN"];
	if (bin) return bin;
	if (!existsSync(fetched)) throw new Error(`no hub binary at ${fetched}: run scripts/fetch-hub.sh, or set HUB_BIN`);
	return fetched;
}

/** `HUB_BIN` must exec the hub in place and not fork, because `stop` signals only the direct child. */
export async function startHubProcess(options: {
	dataDir: string;
	/** Defaults to a free port. */
	port?: number;
	tokensFile?: string;
	externalFile?: string;
	testAgents?: boolean;
	env?: Record<string, string>;
}): Promise<HubProcess> {
	const args = ["--listen", `127.0.0.1:${options.port ?? 0}`, "--data", options.dataDir];
	if (options.tokensFile) args.push("--tokens", options.tokensFile);
	if (options.externalFile) args.push("--external", options.externalFile);
	if (options.testAgents) args.push("--test-agents");
	const command = hubBinary();
	const child = spawn(command, args, {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...options.env },
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
	const port = await new Promise<number>((done, fail) => {
		let out = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			fail(new Error(`hub did not start: ${stderr}`));
		}, 10_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
			const match = /listening (\d+)/.exec(out);
			if (match) {
				clearTimeout(timer);
				done(Number(match[1]));
			}
		});
		void exited.then((code) => {
			clearTimeout(timer);
			fail(new Error(`hub exited with ${code}: ${stderr}`));
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			fail(new Error(`hub did not start: ${command}: ${error.message}`));
		});
	});
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		child,
		stderr: () => stderr,
		stop: async (signal = "SIGTERM") => {
			if (child.exitCode === null && child.signalCode === null) child.kill(signal);
			return exited;
		},
	};
}

export interface LinkEventRecord {
	id: number;
	type: string;
	data: Record<string, unknown>;
}

export class LinkClient {
	readonly events: LinkEventRecord[] = [];
	readonly #hub: string;
	readonly #headers: Record<string, string>;
	readonly agent: string;
	#controller: AbortController | undefined;
	#waiters: (() => void)[] = [];
	#done: Promise<void> | undefined;
	closedByServer = false;

	constructor(hub: string, agent: string, token = HOST_TOKEN) {
		this.#hub = hub;
		this.agent = agent;
		this.#headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	}

	async request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
		const init: RequestInit = { method, headers: this.#headers };
		if (body !== undefined) init.body = JSON.stringify(body);
		const response = await fetch(`${this.#hub}${path}`, init);
		const text = await response.text();
		return { status: response.status, body: text ? (JSON.parse(text) as unknown) : null };
	}

	async ok(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
		const result = await this.request(method, path, body);
		if (result.status !== 200) throw new Error(`${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`);
		return result.body as Record<string, unknown>;
	}

	register(extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		return this.ok("POST", "/link/register", {
			agent: this.agent,
			protocol: PROTOCOL,
			labels: { harness: HARNESS },
			...extra,
		});
	}

	async connect(options: { lastEventId?: string; query?: string } = {}): Promise<void> {
		this.#controller = new AbortController();
		const headers: Record<string, string> = { ...this.#headers };
		if (options.lastEventId !== undefined) headers["Last-Event-ID"] = options.lastEventId;
		const query = options.query === undefined ? "" : `?${options.query}`;
		const response = await fetch(`${this.#hub}/link/${this.agent}/events${query}`, {
			headers,
			signal: this.#controller.signal,
		});
		if (response.status !== 200 || !response.body) throw new Error(`events: ${response.status}`);
		const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
		this.#done = (async () => {
			let buffer = "";
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += value;
					let end = buffer.indexOf("\n\n");
					while (end >= 0) {
						this.#frame(buffer.slice(0, end));
						buffer = buffer.slice(end + 2);
						end = buffer.indexOf("\n\n");
					}
				}
				this.closedByServer = true;
			} catch {
				// aborted by close()
			}
			this.#wake();
		})();
	}

	#frame(frame: string): void {
		let id = 0;
		let type = "message";
		let data = "";
		for (const line of frame.split("\n")) {
			if (line.startsWith("id: ")) id = Number(line.slice(4));
			else if (line.startsWith("event: ")) type = line.slice(7);
			else if (line.startsWith("data: ")) data += line.slice(6);
		}
		if (!data) return;
		this.events.push({ id, type, data: JSON.parse(data) as Record<string, unknown> });
		this.#wake();
	}

	#wake(): void {
		for (const wake of this.#waiters.splice(0)) wake();
	}

	async next(
		type: string,
		match: (data: Record<string, unknown>) => boolean = () => true,
		timeoutMs = 5000,
	): Promise<LinkEventRecord> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.events.find((event) => event.type === type && match(event.data));
			if (found) return found;
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`no ${type} event for ${this.agent}; got ${JSON.stringify(this.events)}`);
			await new Promise<void>((done) => {
				const timer = setTimeout(done, left);
				this.#waiters.push(() => {
					clearTimeout(timer);
					done();
				});
			});
		}
	}

	ack(upTo: number): Promise<Record<string, unknown>> {
		return this.ok("POST", `/link/${this.agent}/ack`, { upTo });
	}

	update(taskId: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
		return this.request("POST", `/link/${this.agent}/tasks/${taskId}`, body);
	}

	status(text: string): Promise<Record<string, unknown>> {
		return this.ok("POST", `/link/${this.agent}/status`, { text });
	}

	async close(): Promise<void> {
		this.#controller?.abort();
		await this.#done;
	}
}
