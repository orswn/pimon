import { chmodSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import type { AskRequest } from "./overlay.ts";

const MAX_REQUEST_BYTES = 4096;
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/g;

/** mkdir's mode does not narrow an existing directory, and a shared /tmp fallback may hold another user's. */
function prepareSocketDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const { uid } = statSync(dir);
	const self = process.getuid?.();
	if (self !== undefined && uid !== self) throw new Error(`${dir} is owned by uid ${uid}, not by this user`);
	chmodSync(dir, 0o700);
}

export interface AskpassServerOptions {
	sockPath: string;
	ask(request: AskRequest, conn: Socket): Promise<string | undefined>;
	/** Runs before the reply reaches the client. */
	onSecret(secret: string): void;
	onError(error: Error): void;
}

export interface AskpassServer {
	close(): void;
}

export function listenAskpass(options: AskpassServerOptions): Promise<AskpassServer> {
	const { sockPath } = options;
	const sockets = new Set<Socket>();
	let queue: Promise<void> = Promise.resolve();

	const enqueue = (request: AskRequest, conn: Socket) => {
		queue = queue.then(async () => {
			if (conn.destroyed) return;
			const secret = await options.ask(request, conn).catch(() => undefined);
			if (conn.destroyed) return;
			if (secret) options.onSecret(secret);
			conn.end(secret ?? "");
		});
	};

	try {
		prepareSocketDir(dirname(sockPath));
		rmSync(sockPath, { force: true });
	} catch (error) {
		return Promise.reject(error instanceof Error ? error : new Error(String(error)));
	}
	const server = createServer((conn) => {
		sockets.add(conn);
		conn.once("close", () => sockets.delete(conn));
		conn.on("error", () => {});
		conn.setEncoding("utf8");
		let buf = "";
		const onData = (chunk: string) => {
			buf += chunk;
			if (buf.length > MAX_REQUEST_BYTES) return void conn.destroy();
			const end = buf.indexOf("\n");
			if (end === -1) return;
			conn.off("data", onData);
			enqueue({ reason: buf.slice(0, end).replace(CONTROL, "") }, conn);
		};
		conn.on("data", onData);
	});

	const close = () => {
		for (const conn of sockets) conn.destroy();
		sockets.clear();
		server.close();
		rmSync(sockPath, { force: true });
	};

	return new Promise((resolve, reject) => {
		const onListenError = (error: Error) => {
			rmSync(sockPath, { force: true });
			reject(error);
		};
		server.once("error", onListenError);
		server.listen(sockPath, () => {
			server.off("error", onListenError);
			server.on("error", (error) => options.onError(error));
			try {
				chmodSync(sockPath, 0o600);
			} catch (error) {
				close();
				reject(error);
				return;
			}
			resolve({ close });
		});
	});
}
