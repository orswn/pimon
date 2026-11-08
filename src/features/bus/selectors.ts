// Selector grammar: tokens joined by `|` (union) or `+` (intersection). `!token` excludes.
// Self is excluded unless the selector names this instance. Every malformed selector raises SelectorError.

import type { PeerRecord } from "./protocol.ts";
import { fullId, idFragment } from "./protocol.ts";

export interface SelectorContext {
	selfInstanceId: string;
	selfOwner: string;
	selfName: string;
}

interface Token {
	negated: boolean;
	kind: string;
	value: string;
}

export class SelectorError extends Error {}

const VALUELESS = new Set(["all", "self", "children", "stale"]);
const VALUED = new Set(["id", "owner", "session", "name", "role", "label", "topic", "cwd", "parent", "state"]);
/** Only these values are free text that can hold `|` or `+`. */
const FREE_TEXT = new Set(["cwd", "label"]);

function parseToken(raw: string): Token {
	let text = raw.trim();
	if (!text) throw new SelectorError("empty selector token");
	const negated = text.startsWith("!");
	if (negated) text = text.slice(1).trim();
	if (!text) throw new SelectorError("negation without a token");
	if (text.startsWith("!")) throw new SelectorError(`repeated negation in "${raw.trim()}"`);

	const colon = text.indexOf(":");
	if (colon === -1) {
		if (VALUELESS.has(text)) return { negated, kind: text, value: "" };
		if (VALUED.has(text)) throw new SelectorError(`selector "${text}" requires a value, for example ${text}:something`);
		return { negated, kind: "name", value: text };
	}

	const kind = text.slice(0, colon).trim();
	const value = text.slice(colon + 1).trim();
	if (VALUELESS.has(kind)) throw new SelectorError(`selector "${kind}" does not take a value`);
	if (!VALUED.has(kind)) throw new SelectorError(`unknown selector kind: ${kind}`);
	if (!value) throw new SelectorError(`selector ${kind} needs a value`);

	if (kind === "id" || kind === "owner") {
		const fragment = idFragment(value);
		if (!fragment) throw new SelectorError(`${kind} selector needs 8 to 32 hex characters, got "${value}"`);
		return { negated, kind, value: fragment };
	}
	if (kind === "label" && value.indexOf("=") === 0) throw new SelectorError("label selector needs key or key=value");

	return { negated, kind, value };
}

function startsNewToken(rest: string): boolean {
	const text = rest.trimStart();
	if (!text) return true;
	if (text.startsWith("!")) return true;
	const match = /^([a-z]+)\s*(:|$|[|+])/.exec(text);
	if (!match?.[1]) return false;
	if (match[2] === ":") return VALUED.has(match[1]);
	return VALUELESS.has(match[1]);
}

function isFreeText(token: string): boolean {
	const text = token.trim().replace(/^!\s*/, "");
	const colon = text.indexOf(":");
	return colon > 0 && FREE_TEXT.has(text.slice(0, colon).trim());
}

/** Splits into union branches of intersection tokens. A `cwd:` or `label:` value keeps `|` and `+` unless a new token follows. */
function splitSelector(text: string): string[][] {
	const branches: string[][] = [];
	let tokens: string[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char !== "|" && char !== "+") continue;
		const token = text.slice(start, index);
		if (isFreeText(token) && !startsNewToken(text.slice(index + 1))) continue;
		tokens.push(token);
		if (char === "|") {
			branches.push(tokens);
			tokens = [];
		}
		start = index + 1;
	}
	tokens.push(text.slice(start));
	branches.push(tokens);
	return branches;
}

export function parseSelector(selector: string): Token[][] {
	const text = (selector || "").trim();
	if (!text) throw new SelectorError("selector is required");
	const groups: Token[][] = [];
	for (const branch of splitSelector(text)) {
		if (branch.length === 1 && !branch[0]?.trim()) throw new SelectorError(`empty branch in selector "${selector}"`);
		groups.push(branch.map(parseToken));
	}
	return groups;
}

function hexMatches(value: string | undefined, fragment: string): boolean {
	if (!value) return false;
	const hex = fullId(value);
	// A full id must match exactly, so a prefix collision cannot turn a pinned send into a broadcast.
	return fragment.length === 32 ? hex === fragment : hex.startsWith(fragment);
}

function matchesToken(token: Token, peer: PeerRecord, ctx: SelectorContext, peers: PeerRecord[]): boolean {
	switch (token.kind) {
		case "all":
			return true;
		case "self":
			return peer.instanceId === ctx.selfInstanceId;
		case "stale":
			return peer.stale === true;
		case "id":
			return hexMatches(peer.instanceId, token.value);
		case "owner":
			return hexMatches(peer.owner, token.value);
		case "name":
			return peer.name === token.value;
		case "role":
			return peer.labels["role"] === token.value;
		case "state":
			return peer.state === token.value;
		case "session":
			return peer.session === token.value;
		case "topic":
			return peer.topics.includes(token.value);
		case "cwd":
			return peer.cwd === token.value || peer.cwd.startsWith(`${token.value.replace(/\/$/, "")}/`);
		case "children":
			return peer.labels["parent"] === ctx.selfOwner || peer.labels["parent"] === ctx.selfInstanceId;
		case "parent": {
			const parent = peer.labels["parent"];
			if (!parent) return false;
			// An exact live name wins over an id reading, so a peer named "deadbeef" stays selectable.
			const named = peers.filter((candidate) => candidate.name === token.value);
			if (named.length > 0) {
				return named.some((candidate) => candidate.instanceId === parent || candidate.owner === parent);
			}
			const fragment = idFragment(token.value);
			if (!fragment) return false;
			return hexMatches(parent, fragment);
		}
		case "label": {
			const eq = token.value.indexOf("=");
			if (eq === -1) return peer.labels[token.value] !== undefined;
			return peer.labels[token.value.slice(0, eq)] === token.value.slice(eq + 1);
		}
		default:
			return false;
	}
}

function mentionsSelf(groups: Token[][], ctx: SelectorContext): boolean {
	for (const group of groups) {
		for (const token of group) {
			if (token.negated) continue;
			if (token.kind === "self") return true;
			if (token.kind === "id" && hexMatches(ctx.selfInstanceId, token.value)) return true;
			if (token.kind === "owner" && hexMatches(ctx.selfOwner, token.value)) return true;
			if (token.kind === "name" && token.value === ctx.selfName) return true;
		}
	}
	return false;
}

export function matchPeers(selector: string, peers: PeerRecord[], ctx: SelectorContext): PeerRecord[] {
	const groups = parseSelector(selector);
	const includeSelf = mentionsSelf(groups, ctx);
	return peers.filter((peer) => {
		if (!includeSelf && peer.instanceId === ctx.selfInstanceId) return false;
		return groups.some((group) => group.every((token) => matchesToken(token, peer, ctx, peers) !== token.negated));
	});
}

/** True when the selector names one intended recipient. Extra intersection filters keep it unicast. A union does not. */
export function isUnicastSelector(selector: string): boolean {
	let groups: Token[][];
	try {
		groups = parseSelector(selector);
	} catch {
		return false;
	}
	if (groups.length !== 1) return false;
	return (groups[0] ?? []).some(
		(token) => !token.negated && (token.kind === "name" || token.kind === "id" || token.kind === "owner"),
	);
}

export function describeSelector(selector: string): string {
	try {
		return parseSelector(selector)
			.map((group) =>
				group
					.map((token) => `${token.negated ? "!" : ""}${token.kind}${token.value ? `:${token.value}` : ""}`)
					.join("+"),
			)
			.join(" or ");
	} catch {
		return selector;
	}
}
