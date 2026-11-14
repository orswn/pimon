import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PrincipalKind } from "./protocol.ts";

export interface Principal {
	name: string;
	kind: PrincipalKind;
}

export const ANONYMOUS: Principal = { name: "anonymous", kind: "peer" };

interface TokenEntry {
	principal: Principal;
	digest: Buffer;
}

export class TokenTable {
	readonly #entries: TokenEntry[];

	constructor(entries: TokenEntry[] = []) {
		this.#entries = entries;
	}

	get size(): number {
		return this.#entries.length;
	}

	/** Compares against every entry so the time does not depend on which entry matches. */
	match(token: string): Principal | undefined {
		const digest = sha256(token);
		let found: Principal | undefined;
		for (const entry of this.#entries) {
			if (timingSafeEqual(entry.digest, digest) && !found) found = entry.principal;
		}
		return found;
	}
}

export function sha256(value: string): Buffer {
	return createHash("sha256").update(value, "utf8").digest();
}

export function parseTokens(text: string): TokenTable {
	const raw: unknown = JSON.parse(text);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("token file must be a JSON object");
	const entries: TokenEntry[] = [];
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		const entry = value as { kind?: unknown; sha256?: unknown } | null;
		if (!entry || (entry.kind !== "host" && entry.kind !== "peer")) {
			throw new Error(`token ${name}: kind must be "host" or "peer"`);
		}
		if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(entry.sha256)) {
			throw new Error(`token ${name}: sha256 must be 64 hex chars`);
		}
		entries.push({ principal: { name, kind: entry.kind }, digest: Buffer.from(entry.sha256, "hex") });
	}
	return new TokenTable(entries);
}

export function loadTokens(file: string | undefined): TokenTable {
	return file ? parseTokens(readFileSync(file, "utf8")) : new TokenTable();
}

export type AuthResult = { ok: true; principal: Principal } | { ok: false; status: 401 };

/** A missing header gives `anonymous` only when the route allows it. */
export function authenticate(header: string | undefined, tokens: TokenTable, allowAnonymous: boolean): AuthResult {
	if (header === undefined || header === "") {
		return allowAnonymous ? { ok: true, principal: ANONYMOUS } : { ok: false, status: 401 };
	}
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
	const principal = match?.[1] ? tokens.match(match[1]) : undefined;
	return principal ? { ok: true, principal } : { ok: false, status: 401 };
}
