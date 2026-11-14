import { readFileSync } from "node:fs";

/** One A2A agent outside the hub, such as Hermes. The hub sends it tasks and maps its answers back. */
export interface ExternalAgentConfig {
	/** The hub agent id: `/a2a/<id>`. The key in the file. */
	id: string;
	/** `@<name>` resolves to it before any pi session. */
	name: string;
	/** The JSON-RPC URL of the agent. The card is at `<url>/.well-known/agent-card.json`. */
	url: string;
	token: string;
	description: string;
	/** GetTask interval after a dropped stream, and the card retry interval after a failed fetch. */
	pollMs: number;
	cardTtlMs: number;
	/** The longest time from dispatch to a final answer. */
	replyTimeoutMs: number;
	/** A stream without a byte for this long counts as dropped. */
	idleMs: number;
	/** The wait after a rate-limit answer. */
	retryMs: number;
	/** How long the hub retries an agent it cannot connect to before the task fails. */
	offlineMs: number;
}

export const EXTERNAL_DEFAULTS = {
	pollMs: 10_000,
	cardTtlMs: 600_000,
	replyTimeoutMs: 960_000,
	idleMs: 30_000,
	retryMs: 60_000,
	offlineMs: 600_000,
} as const;

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VISIBLE_ASCII = /^[\x21-\x7E]+$/;
const KNOWN_FIELDS = new Set(["name", "url", "token", "description", ...Object.keys(EXTERNAL_DEFAULTS)]);

function positive(entry: Record<string, unknown>, id: string, field: keyof typeof EXTERNAL_DEFAULTS): number {
	const value = entry[field];
	if (value === undefined) return EXTERNAL_DEFAULTS[field];
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`external agent ${id}: ${field} must be a positive integer`);
	}
	return value;
}

function text(entry: Record<string, unknown>, id: string, field: string, required: boolean): string | undefined {
	const value = entry[field];
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`external agent ${id}: ${field} must be a non-empty string`);
	}
	return value.trim();
}

export function parseExternal(source: string): ExternalAgentConfig[] {
	let raw: unknown;
	try {
		raw = JSON.parse(source);
	} catch {
		// The V8 message quotes part of the file, which holds plain tokens.
		throw new Error("external file is not valid JSON");
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("external file must be a JSON object");
	const agents: ExternalAgentConfig[] = [];
	const names = new Set<string>();
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!AGENT_ID.test(id)) throw new Error(`external agent id ${id} has invalid characters`);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error(`external agent ${id}: entry must be an object`);
		}
		const entry = value as Record<string, unknown>;
		const unknown = Object.keys(entry).find((field) => !KNOWN_FIELDS.has(field));
		if (unknown) throw new Error(`external agent ${id}: unknown field ${unknown}`);
		const url = text(entry, id, "url", true) ?? "";
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error(`external agent ${id}: url is not a valid URL`);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error(`external agent ${id}: url must use http or https`);
		}
		const name = text(entry, id, "name", false) ?? id;
		if (!AGENT_ID.test(name)) throw new Error(`external agent ${id}: name must match ${AGENT_ID.source}`);
		const token = entry["token"];
		if (typeof token !== "string" || !VISIBLE_ASCII.test(token)) {
			throw new Error(`external agent ${id}: token must be visible ASCII`);
		}
		if (names.has(name)) throw new Error(`external agent ${id}: name ${name} is used twice`);
		names.add(name);
		agents.push({
			id,
			name,
			url,
			token,
			description: text(entry, id, "description", false) ?? `${name}: an external A2A agent`,
			pollMs: positive(entry, id, "pollMs"),
			cardTtlMs: positive(entry, id, "cardTtlMs"),
			replyTimeoutMs: positive(entry, id, "replyTimeoutMs"),
			idleMs: positive(entry, id, "idleMs"),
			retryMs: positive(entry, id, "retryMs"),
			offlineMs: positive(entry, id, "offlineMs"),
		});
	}
	return agents;
}

export function loadExternal(file: string | undefined): ExternalAgentConfig[] {
	return file ? parseExternal(readFileSync(file, "utf8")) : [];
}

/** `<url>/.well-known/agent-card.json`, also when the URL has no trailing slash. */
export function cardUrl(url: string): string {
	return new URL(".well-known/agent-card.json", url.endsWith("/") ? url : `${url}/`).toString();
}
