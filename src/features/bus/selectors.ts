// Selector grammar: tokens joined by `|` (union) or `+` (intersection). `!token` excludes.
// Self is excluded unless the selector names this session. Every malformed selector raises SelectorError.

import { sessionTag } from "./identity.ts";
import type { AgentInfo } from "./protocol.ts";
import { fullId, idFragment } from "./protocol.ts";

export interface SelectorContext {
	selfId: string;
	selfName: string;
}

interface Token {
	negated: boolean;
	kind: string;
	value: string;
}

export class SelectorError extends Error {}

const VALUELESS = new Set(["all", "self", "children", "stale"]);
const VALUED = new Set(["id", "owner", "session", "name", "role", "label", "topic", "cwd", "parent", "state", "host"]);
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
		// `owner:` is the old name of `id:`. A non-hex value names an agent id exactly, such as an external agent.
		const fragment = idFragment(value);
		if (fragment) return { negated, kind: "id", value: fragment };
		if (/^[0-9a-f-]+$/i.test(value) || kind === "owner")
			throw new SelectorError(`${kind} selector needs 8 to 32 hex characters, got "${value}"`);
		return { negated, kind: "id", value: `=${value}` };
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

function hexMatches(value: string | null | undefined, fragment: string): boolean {
	if (!value) return false;
	if (fragment.startsWith("=")) return value === fragment.slice(1);
	const hex = fullId(value);
	// A full id must match exactly, so a prefix collision cannot turn a pinned send into a broadcast.
	return fragment.length === 32 ? hex === fragment : hex.startsWith(fragment);
}

function matchesToken(token: Token, agent: AgentInfo, ctx: SelectorContext, agents: AgentInfo[]): boolean {
	switch (token.kind) {
		case "all":
			return agent.online;
		case "self":
			return agent.id === ctx.selfId;
		case "stale":
			// Kept so old selectors still parse. The hub reports liveness itself.
			return false;
		case "id":
			return hexMatches(agent.id, token.value);
		case "name":
			return agent.name === token.value;
		case "role":
			return agent.role === token.value;
		case "state":
			return token.value === "offline" ? !agent.online : agent.online && agent.state === token.value;
		case "session":
			return sessionTag(agent.id) === token.value;
		case "host":
			return agent.host === token.value;
		case "topic":
			return agent.topics.includes(token.value);
		case "cwd": {
			const cwd = agent.cwd ?? "";
			return cwd === token.value || cwd.startsWith(`${token.value.replace(/\/$/, "")}/`);
		}
		case "children":
			return agent.parent === ctx.selfId;
		case "parent": {
			const parent = agent.parent;
			if (!parent) return false;
			// An exact name wins over an id reading, so an agent named "deadbeef" stays selectable.
			const named = agents.filter((candidate) => candidate.name === token.value);
			if (named.length > 0) return named.some((candidate) => candidate.id === parent);
			const fragment = idFragment(token.value);
			if (!fragment) return false;
			return hexMatches(parent, fragment);
		}
		case "label": {
			const eq = token.value.indexOf("=");
			if (eq === -1) return agent.labels[token.value] !== undefined;
			return agent.labels[token.value.slice(0, eq)] === token.value.slice(eq + 1);
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
			if (token.kind === "id" && hexMatches(ctx.selfId, token.value)) return true;
			if (token.kind === "name" && token.value === ctx.selfName) return true;
		}
	}
	return false;
}

/**
 * Offline agents count only for a unicast `id:` selector or one that holds `state:offline`.
 * Else `all` would reach every session of the last 7 days.
 */
export function reachesOffline(selector: string): boolean {
	const groups = parseSelector(selector);
	const tokens = groups.flat();
	if (tokens.some((token) => token.kind === "state" && token.value === "offline" && !token.negated)) return true;
	return groups.length === 1 && (groups[0] ?? []).some((token) => token.kind === "id" && !token.negated);
}

export function matchAgents(selector: string, agents: AgentInfo[], ctx: SelectorContext): AgentInfo[] {
	const groups = parseSelector(selector);
	const includeSelf = mentionsSelf(groups, ctx);
	const offline = reachesOffline(selector);
	return agents.filter((agent) => {
		if (!includeSelf && agent.id === ctx.selfId) return false;
		if (!agent.online && !offline) return false;
		return groups.some((group) => group.every((token) => matchesToken(token, agent, ctx, agents) !== token.negated));
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
	return (groups[0] ?? []).some((token) => !token.negated && (token.kind === "name" || token.kind === "id"));
}

function shownValue(token: { kind: string; value: string }): string {
	return token.kind === "id" && token.value.startsWith("=") ? token.value.slice(1) : token.value;
}

export function describeSelector(selector: string): string {
	try {
		return parseSelector(selector)
			.map((group) =>
				group
					.map((token) => `${token.negated ? "!" : ""}${token.kind}${token.value ? `:${shownValue(token)}` : ""}`)
					.join("+"),
			)
			.join(" or ");
	} catch {
		return selector;
	}
}
