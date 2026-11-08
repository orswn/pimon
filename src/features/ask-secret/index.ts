import { randomBytes } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionContext,
	isBashToolResult,
	type ToolResultEvent,
	type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { defineFeature, type WakeMessage } from "../../core/feature.ts";
import {
	ENV_PREFIX,
	hasTag,
	MIN_REDACT_LENGTH,
	redactDeep,
	SecretStore,
	transformInput,
	unknownHandles,
} from "./core.ts";
import { promptOverlay } from "./overlay.ts";
import { SECRETS_PROMPT } from "./prompt.ts";
import { type AskpassServer, listenAskpass } from "./server.ts";

export const ASKPASS_CLIENT = fileURLToPath(new URL("./pi-ask-secret", import.meta.url));

export function askpassSocketPath(): string {
	return join(process.env["XDG_RUNTIME_DIR"] ?? "/tmp", "pi-ask-secret", `${process.pid}.sock`);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function clearSecretEnv(): void {
	for (const key of Object.keys(process.env)) if (key.startsWith(ENV_PREFIX)) delete process.env[key];
}

/** A nested pi in another mode must not prompt through its parent's socket. */
function dropInheritedAskpass(): void {
	delete process.env["PI_ASK_SECRET_SOCK"];
	const askpass = process.env["SUDO_ASKPASS"];
	if (askpass && basename(askpass) === basename(ASKPASS_CLIENT)) delete process.env["SUDO_ASKPASS"];
}

export function redactToolResult(event: ToolResultEvent, store: SecretStore): ToolResultEventResult | undefined {
	let changed = false;
	const content = event.content.map((part) => {
		if (part.type !== "text") return part;
		const text = store.redact(part.text);
		if (text === part.text) return part;
		changed = true;
		return { ...part, text };
	});
	const patch: ToolResultEventResult = {};
	if (event.structuredContent !== undefined) {
		const structuredContent = redactDeep(event.structuredContent, store);
		if (JSON.stringify(structuredContent) !== JSON.stringify(event.structuredContent)) changed = true;
		// Returning content without structuredContent drops it, so always carry it along.
		patch.structuredContent = structuredContent;
	}
	if (event.details !== undefined && event.details !== null) {
		const details = redactDeep(event.details, store);
		if (JSON.stringify(details) !== JSON.stringify(event.details)) {
			changed = true;
			patch.details = details;
		}
	}
	if (!changed) return undefined;
	patch.content = content;
	return patch;
}

export function redactWake(message: WakeMessage, store: SecretStore): WakeMessage {
	if (store.size === 0) return message;
	const content =
		typeof message.content === "string"
			? store.redact(message.content)
			: message.content.map((part) => (part.type === "text" ? { ...part, text: store.redact(part.text) } : part));
	const redacted: WakeMessage = { ...message, content };
	if (message.details !== undefined) redacted.details = redactDeep(message.details, store);
	return redacted;
}

export const REMOVED_OUTPUT = "[output removed by ask-secret: it could contain a secret]\n";
export const MAX_REWRITE_BYTES = 64 * 1024 * 1024;

export type RedactFileResult =
	| { outcome: "unchanged" | "redacted" | "missing" }
	| { outcome: "removed" | "deleted" | "failed"; error: unknown };

async function replaceFile(path: string, content: string): Promise<void> {
	const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
	try {
		await writeFile(temp, content, { mode: 0o600, flag: "wx" });
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** Fails closed: when the file cannot be checked, its content is replaced, or else the file is deleted. */
export async function redactFile(
	path: string,
	store: SecretStore,
	options: { maxBytes?: number } = {},
): Promise<RedactFileResult> {
	const maxBytes = options.maxBytes ?? MAX_REWRITE_BYTES;
	try {
		const { size } = await stat(path);
		if (size > maxBytes) throw new Error(`file is ${size} bytes, above the ${maxBytes} byte limit`);
		const text = await readFile(path, "utf8");
		const redacted = store.redact(text);
		if (redacted === text) return { outcome: "unchanged" };
		await replaceFile(path, redacted);
		return { outcome: "redacted" };
	} catch (error) {
		if (isMissing(error)) return { outcome: "missing" };
		try {
			await replaceFile(path, REMOVED_OUTPUT);
			return { outcome: "removed", error };
		} catch {
			try {
				await rm(path, { force: true });
				return { outcome: "deleted", error };
			} catch (rmError) {
				return { outcome: "failed", error: rmError };
			}
		}
	}
}

/** Rings the bell and shows a desktop notification when a prompt opens. */
export function desktopAlert(pi: ExtensionAPI, text: string): void {
	process.stdout.write("\x07");
	pi.exec("notify-send", ["-a", "pi", "pi-ask-secret", text.slice(0, 200)]).catch(() => {});
}

export interface AskSecretOptions {
	alert?: (pi: ExtensionAPI, text: string) => void;
	maxRewriteBytes?: number;
}

export function createAskSecret(options: AskSecretOptions = {}) {
	const alertHuman = options.alert ?? desktopAlert;
	return defineFeature({
		id: "ask-secret",
		description: "Get secrets from the human into commands without the model or the session file seeing them",
		defaultEnabled: true,
		setup(ctx) {
			ctx.promptSection({ name: "secrets", render: () => SECRETS_PROMPT });
			const store = new SecretStore();
			ctx.wakeFilter((message) => redactWake(message, store));
			// Captured once per process: a later runtime would see the value this feature set.
			const original = ctx.reloadState("env", 1, () => ({ sudoAskpass: process.env["SUDO_ASKPASS"] }));
			const sockPath = askpassSocketPath();
			let server: AskpassServer | undefined;
			let session: ExtensionContext | undefined;

			const clearSecrets = () => {
				clearSecretEnv();
				store.clear();
			};

			ctx.onSessionStart(async (_event, extensionCtx) => {
				session = extensionCtx;
				// A previous runtime in this process may have left values behind; their handles are unknown now.
				clearSecrets();
				if (extensionCtx.mode !== "tui") {
					dropInheritedAskpass();
					return;
				}
				if (server) return;
				try {
					server = await listenAskpass({
						sockPath,
						ask: async (request, conn) => {
							if (!session) return undefined;
							alertHuman(ctx.pi, request.reason || "secret requested");
							return promptOverlay(session.ui, request, conn);
						},
						onSecret: (secret) => store.addRedactOnly(secret),
						onError: (error) => session?.ui.notify(`ask-secret: socket error: ${error.message}`, "error"),
					});
				} catch (error) {
					dropInheritedAskpass();
					extensionCtx.ui.notify(`ask-secret: cannot listen on ${sockPath}: ${describe(error)}`, "error");
					return;
				}
				process.env["PI_ASK_SECRET_SOCK"] = sockPath;
				process.env["SUDO_ASKPASS"] = ASKPASS_CLIENT;
			});

			ctx.onSessionShutdown(() => {
				if (server) {
					server.close();
					server = undefined;
					delete process.env["PI_ASK_SECRET_SOCK"];
					if (original.sudoAskpass === undefined) delete process.env["SUDO_ASKPASS"];
					else process.env["SUDO_ASKPASS"] = original.sudoAskpass;
				}
				session = undefined;
				clearSecrets();
			});

			ctx.pi.on("input", async (event, extensionCtx) => {
				if (!hasTag(event.text)) return { action: "continue" };
				// Fail closed: any error here must block the message, never pass raw text on.
				try {
					const result = transformInput(event.text, store);
					for (const { name, replaced, short } of result.added) {
						process.env[ENV_PREFIX + name] = store.get(name);
						if (replaced) extensionCtx.ui.notify(`ask-secret: $${ENV_PREFIX}${name} now holds a new value.`, "warning");
						if (short) {
							extensionCtx.ui.notify(
								`ask-secret: $${ENV_PREFIX}${name} is under ${MIN_REDACT_LENGTH} characters and is not redacted from tool output.`,
								"warning",
							);
						}
					}
					return { action: "transform", text: result.text, images: event.images };
				} catch (error) {
					if (extensionCtx.hasUI && !extensionCtx.ui.getEditorText()) extensionCtx.ui.setEditorText(event.text);
					extensionCtx.ui.notify(`ask-secret: message not sent: ${describe(error)}`, "error");
					return { action: "handled" };
				}
			});

			// Nested calls (codemode scripts) pass through here too, so checking `command` covers them.
			ctx.pi.on("tool_call", (event) => {
				const command = (event.input as { command?: unknown } | undefined)?.command;
				if (typeof command !== "string") return undefined;
				const unknown = unknownHandles(command, store);
				if (unknown.length === 0) return undefined;
				return {
					block: true,
					reason: `Unknown or expired secret handle: ${unknown.join(", ")}. Secrets live only for the current pi runtime. Ask the human to provide them again.`,
				};
			});

			ctx.pi.on("tool_result", async (event, extensionCtx) => {
				if (store.size === 0) return undefined;
				const patch = redactToolResult(event, store);
				const fullOutputPath = isBashToolResult(event) ? event.details?.fullOutputPath : undefined;
				if (fullOutputPath) {
					const result = await redactFile(fullOutputPath, store, { maxBytes: options.maxRewriteBytes });
					if (result.outcome === "removed" || result.outcome === "deleted") {
						const action = result.outcome === "removed" ? "removed the content of" : "deleted";
						extensionCtx.ui.notify(`ask-secret: ${action} ${fullOutputPath}: ${describe(result.error)}`, "warning");
					} else if (result.outcome === "failed") {
						extensionCtx.ui.notify(
							`ask-secret: ${fullOutputPath} may still hold a secret: ${describe(result.error)}`,
							"error",
						);
					}
				}
				return patch;
			});
		},
	});
}

export const askSecret = createAskSecret();
