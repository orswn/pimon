import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export const OLD_BUS_DRIVER = new URL("../fixtures/old-bus/harness.ts", import.meta.url).pathname;
export const NEW_BUS_DRIVER = new URL("../fixtures/new-bus-driver.ts", import.meta.url).pathname;

export interface DriverEvent {
	event: string;
	payload: Record<string, unknown>;
}

export interface Driver {
	child: ChildProcessWithoutNullStreams;
	events: DriverEvent[];
	send(command: Record<string, string>): void;
	/** Resolves with the first `event` that arrives after the call. */
	next(event: string, timeoutMs?: number): Promise<DriverEvent>;
	count(event: string): number;
	exited: Promise<number | null>;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs a bus node in its own process. Commands go in on stdin, events come out as JSONL on stdout. */
export function startDriver(script: string, name: string, busDir: string, extra: string[] = []): Driver {
	const child = spawn(process.execPath, [script, name, "", ...extra], {
		env: { ...process.env, PI_BUS_DIR: busDir },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const events: DriverEvent[] = [];
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		while (buffer.includes("\n")) {
			const index = buffer.indexOf("\n");
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line) continue;
			try {
				events.push(JSON.parse(line) as DriverEvent);
			} catch {
				// Not an event line.
			}
		}
	});
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	const count = (event: string) => events.filter((entry) => entry.event === event).length;
	return {
		child,
		events,
		count,
		exited,
		send: (command) => child.stdin.write(`${JSON.stringify(command)}\n`),
		async next(event, timeoutMs = 8_000) {
			const seen = count(event);
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (count(event) > seen) return events.filter((entry) => entry.event === event)[seen] as DriverEvent;
				await sleep(20);
			}
			throw new Error(`${name}: no ${event} event in time`);
		},
	};
}
