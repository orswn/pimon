import { describe, expect, it } from "vite-plus/test";
import type { PeerRecord } from "./protocol.ts";
import { isUnicastSelector, matchPeers, parseSelector, SelectorError } from "./selectors.ts";

const OWNER = "a".repeat(32);

function peer(name: string, extra: Partial<PeerRecord> = {}): PeerRecord {
	const id = (
		name.length.toString(16) +
		name
			.split("")
			.map((c) => c.charCodeAt(0).toString(16))
			.join("")
	)
		.padEnd(32, "0")
		.slice(0, 32);
	return {
		protocol: 1,
		instanceId: id,
		owner: id.split("").reverse().join(""),
		name,
		pid: 1,
		cwd: "/w",
		sock: "/s",
		host: "h",
		labels: {},
		topics: [],
		state: "idle",
		startedAt: 0,
		heartbeatAt: 0,
		...extra,
	};
}

const self = peer("me");
const ctx = { selfInstanceId: self.instanceId, selfOwner: OWNER, selfName: "me" };
const names = (selector: string, peers: PeerRecord[]) => matchPeers(selector, peers, ctx).map((p) => p.name);

describe("selector parsing", () => {
	it("splits bare-word unions into names", () => {
		const peers = [peer("alice"), peer("bob"), peer("carol")];
		expect(names("alice|bob", peers)).toEqual(["alice", "bob"]);
	});

	it("keeps + inside a cwd value", () => {
		const peers = [peer("x", { cwd: "/a+b" }), peer("y", { cwd: "/a" })];
		expect(names("cwd:/a+b", peers)).toEqual(["x"]);
	});

	it("splits a cwd value when a known kind follows", () => {
		const peers = [peer("x", { cwd: "/a+b" }), peer("r", { labels: { role: "x" } }), peer("z")];
		expect(names("cwd:/a+b|role:x", peers)).toEqual(["x", "r"]);
	});

	it("keeps a bare word after | inside a cwd value", () => {
		expect(parseSelector("cwd:/a|bob")).toEqual([[{ negated: false, kind: "cwd", value: "/a|bob" }]]);
	});

	it("splits a free-text value before a negation or a valueless kind", () => {
		expect(parseSelector("label:k=v+!stale")).toHaveLength(1);
		expect(parseSelector("label:k=v+!stale")[0]).toHaveLength(2);
		expect(parseSelector("cwd:/a|all")).toHaveLength(2);
	});

	it.each(["all|", "cwd:/a|", "|all", "all||self"])("rejects %s as an empty branch", (selector) => {
		expect(() => parseSelector(selector)).toThrow(SelectorError);
	});

	it("rejects unknown kinds, valued kinds without a value, and bad ids", () => {
		expect(() => parseSelector("bogus:x")).toThrow(/unknown selector kind/);
		expect(() => parseSelector("role")).toThrow(/requires a value/);
		expect(() => parseSelector("all:x")).toThrow(/does not take a value/);
		expect(() => parseSelector("id:12")).toThrow(/8 to 32 hex/);
		expect(() => parseSelector("!!all")).toThrow(/repeated negation/);
	});
});

describe("selector matching", () => {
	it("excludes self unless named", () => {
		const peers = [self, peer("other")];
		expect(names("all", peers)).toEqual(["other"]);
		expect(names("self", peers)).toEqual(["me"]);
		expect(names("me", peers)).toEqual(["me"]);
	});

	it("matches children by owner or instance id in the parent label", () => {
		const peers = [
			peer("c1", { labels: { parent: OWNER } }),
			peer("c2", { labels: { parent: self.instanceId } }),
			peer("x"),
		];
		expect(names("children", peers)).toEqual(["c1", "c2"]);
	});

	it("matches a full owner id exactly and a prefix by prefix", () => {
		const target = peer("t", { owner: `${"5".repeat(12)}${"0".repeat(20)}` });
		const peers = [target, peer("u", { owner: `${"6".repeat(12)}${"0".repeat(20)}` })];
		expect(names(`owner:${target.owner}`, peers)).toEqual(["t"]);
		expect(names(`owner:${target.owner.slice(0, 12)}`, peers)).toEqual(["t"]);
	});

	it("intersects and excludes", () => {
		const peers = [peer("a", { labels: { role: "r" }, state: "busy" }), peer("b", { labels: { role: "r" } })];
		expect(names("role:r+!state:busy", peers)).toEqual(["b"]);
	});

	it("treats a union as not unicast", () => {
		expect(isUnicastSelector("owner:12345678")).toBe(true);
		expect(isUnicastSelector("alice|bob")).toBe(false);
		expect(isUnicastSelector("role:x")).toBe(false);
	});
});
