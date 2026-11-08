/**
 * Selector parsing and matching for pi-bus addressing.
 *
 * Grammar: tokens joined by `|` (union) or `+` (intersection), `!token` excludes.
 * Self is excluded unless the selector explicitly names this instance.
 *
 * Every malformed selector raises SelectorError. A selector that silently means
 * "everyone" or "nobody" is the failure mode this file exists to prevent.
 */

import type { PeerRecord } from "./protocol.ts";
import { fullId, idFragment, shortId } from "./protocol.ts";

export interface SelectorContext {
	selfInstanceId: string;
	/** Stable process identity, used for durable links such as parent and child. */
	selfOwner: string;
	selfName: string;
}

interface Token {
	negated: boolean;
	kind: string;
	value: string;
}

export class SelectorError extends Error {}

/** Kinds that take no value. */
const VALUELESS = new Set(["all", "self", "children", "stale"]);
/** Kinds that require a value. */
const VALUED = new Set(["id", "owner", "session", "name", "role", "label", "topic", "cwd", "parent", "state"]);

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
		// Bare word is shorthand for a peer name.
		return { negated, kind: "name", value: text };
	}

	const kind = text.slice(0, colon).trim();
	const value = text.slice(colon + 1).trim();
	if (VALUELESS.has(kind)) throw new SelectorError(`selector "${kind}" does not take a value`);
	if (!VALUED.has(kind)) throw new SelectorError(`unknown selector kind: ${kind}`);
	if (!value) throw new SelectorError(`selector ${kind} needs a value`);

	if (kind === "id" || kind === "owner") {
		const fragment = idFragment(value);
		if (!fragment) {
			throw new SelectorError(`${kind} selector needs 8 to 32 hex characters, got "${value}"`);
		}
		return { negated, kind, value: fragment };
	}
	if (kind === "label" && value.indexOf("=") === 0) throw new SelectorError("label selector needs key or key=value");

	return { negated, kind, value };
}

function hexMatches(value: string | undefined, fragment: string): boolean {
	if (!value) return false;
	const hex = fullId(value);
	// A full 32-character id must match exactly, so a prefix collision between two
	// live peers can never turn an identity-pinned send into a broadcast.
	return fragment.length === 32 ? hex === fragment : hex.startsWith(fragment);
}

function idMatches(peer: PeerRecord, fragment: string): boolean {
	return hexMatches(peer.instanceId, fragment);
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
			return idMatches(peer, token.value);
		case "owner":
			return hexMatches(peer.owner, token.value);
		case "name":
			return peer.name === token.value;
		case "role":
			return peer.labels.role === token.value;
		case "state":
			return peer.state === token.value;
		case "session":
			return peer.session === token.value;
		case "topic":
			return peer.topics.includes(token.value);
		case "cwd":
			return peer.cwd === token.value || peer.cwd.startsWith(`${token.value.replace(/\/$/, "")}/`);
		case "children":
			// Children record the parent's stable owner, so this survives a reload.
			return peer.labels.parent === ctx.selfOwner || peer.labels.parent === ctx.selfInstanceId;
		case "parent": {
			const parent = peer.labels.parent;
			if (!parent) return false;
			// An exact live name wins over an id reading, so a peer named "deadbeef"
			// stays selectable.
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
			const key = token.value.slice(0, eq);
			const want = token.value.slice(eq + 1);
			return peer.labels[key] === want;
		}
		default:
			return false;
	}
}

function mentionsSelf(groups: Token[][], ctx: SelectorContext): boolean {
	const selfHex = fullId(ctx.selfInstanceId);
	for (const group of groups) {
		for (const token of group) {
			if (token.negated) continue;
			if (token.kind === "self") return true;
			if (token.kind === "id" && (token.value.length === 32 ? selfHex === token.value : selfHex.startsWith(token.value))) {
				return true;
			}
			if (token.kind === "owner" && hexMatches(ctx.selfOwner, token.value)) return true;
			if (token.kind === "name" && token.value === ctx.selfName) return true;
		}
	}
	return false;
}

export function parseSelector(selector: string): Token[][] {
	const text = (selector || "").trim();
	if (!text) throw new SelectorError("selector is required");
	const branches = text.split("|");
	const groups: Token[][] = [];
	for (const branch of branches) {
		if (!branch.trim()) throw new SelectorError(`empty branch in selector "${selector}"`);
		const tokens = branch.split("+").map(parseToken);
		groups.push(tokens);
	}
	if (groups.length === 0) throw new SelectorError(`selector "${selector}" has no tokens`);
	return groups;
}

export function matchPeers(selector: string, peers: PeerRecord[], ctx: SelectorContext): PeerRecord[] {
	const groups = parseSelector(selector);
	const includeSelf = mentionsSelf(groups, ctx);
	const matched: PeerRecord[] = [];

	for (const peer of peers) {
		if (!includeSelf && peer.instanceId === ctx.selfInstanceId) continue;
		let ok = false;
		for (const group of groups) {
			const positive = group.filter((token) => !token.negated);
			const negative = group.filter((token) => token.negated);
			const positiveOk = positive.length === 0 || positive.every((token) => matchesToken(token, peer, ctx, peers));
			const negativeOk = negative.every((token) => !matchesToken(token, peer, ctx, peers));
			if (positiveOk && negativeOk) {
				ok = true;
				break;
			}
		}
		if (ok) matched.push(peer);
	}

	return matched;
}

/**
 * Ambiguity guard for callers that need exactly one peer, such as a reply or a
 * lifecycle action. Names are human labels and can repeat across live peers.
 */
export function matchOne(selector: string, peers: PeerRecord[], ctx: SelectorContext): PeerRecord {
	const matched = matchPeers(selector, peers, ctx);
	if (matched.length === 1) return matched[0];
	if (matched.length === 0) throw new SelectorError(`no peer matches ${selector}`);
	const options = matched.map((peer) => `${peer.name} (id:${shortId(peer.instanceId)})`).join(", ");
	throw new SelectorError(`${selector} is ambiguous, it matches ${matched.length} peers: ${options}. Address one by id.`);
}

/**
 * True when the selector names a specific recipient. A name is an advisory
 * label, so several matches means an ambiguous address, not a broadcast.
 *
 * Extra intersection filters do not disable the guard: `name:twin+role:worker`
 * still expresses one intended peer. A union of branches does not, since that is
 * an explicit multi-target address.
 */
export function isUnicastSelector(selector: string): boolean {
	let groups: Token[][];
	try {
		groups = parseSelector(selector);
	} catch {
		return false;
	}
	if (groups.length !== 1) return false;
	return groups[0].some((token) => !token.negated && (token.kind === "name" || token.kind === "id" || token.kind === "owner"));
}

export function describeSelector(selector: string): string {
	try {
		const groups = parseSelector(selector);
		return groups
			.map((group) =>
				group.map((token) => `${token.negated ? "!" : ""}${token.kind}${token.value ? `:${token.value}` : ""}`).join("+"),
			)
			.join(" or ");
	} catch {
		return selector;
	}
}
