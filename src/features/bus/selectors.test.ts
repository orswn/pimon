import { describe, expect, it } from "vite-plus/test";
import { sessionTag } from "./identity.ts";
import type { AgentInfo } from "./protocol.ts";
import {
	describeSelector,
	isUnicastSelector,
	matchAgents,
	parseSelector,
	reachesOffline,
	SelectorError,
} from "./selectors.ts";

function idOf(name: string): string {
	return (
		name.length.toString(16) +
		name
			.split("")
			.map((c) => c.charCodeAt(0).toString(16))
			.join("")
	)
		.padEnd(32, "0")
		.slice(0, 32);
}

function agent(name: string, extra: Partial<AgentInfo> = {}): AgentInfo {
	return {
		id: idOf(name),
		name,
		kind: "pi",
		host: "mars",
		cwd: "/w",
		role: null,
		labels: {},
		parent: null,
		topics: [],
		online: true,
		state: "idle",
		activity: null,
		status: { text: "", at: null },
		lastSeenAt: null,
		...extra,
	};
}

const self = agent("me");
const ctx = { selfId: self.id, selfName: "me" };
const names = (selector: string, agents: AgentInfo[]) => matchAgents(selector, agents, ctx).map((a) => a.name);

describe("selector parsing", () => {
	it("splits bare-word unions into names", () => {
		const agents = [agent("alice"), agent("bob"), agent("carol")];
		expect(names("alice|bob", agents)).toEqual(["alice", "bob"]);
	});

	it("keeps + inside a cwd value", () => {
		const agents = [agent("x", { cwd: "/a+b" }), agent("y", { cwd: "/a" })];
		expect(names("cwd:/a+b", agents)).toEqual(["x"]);
	});

	it("splits a cwd value when a known kind follows", () => {
		const agents = [agent("x", { cwd: "/a+b" }), agent("r", { role: "x" }), agent("z")];
		expect(names("cwd:/a+b|role:x", agents)).toEqual(["x", "r"]);
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
		expect(() => parseSelector("owner:hermes")).toThrow(SelectorError);
		expect(() => parseSelector("!!all")).toThrow(/repeated negation/);
	});

	it("shows an exact agent id as the model wrote it", () => {
		expect(describeSelector("id:hermes")).toBe("id:hermes");
		expect(describeSelector("name:mars|id:hermes")).toBe("name:mars or id:hermes");
	});
});

describe("selector matching", () => {
	it("excludes self unless named", () => {
		const agents = [self, agent("other")];
		expect(names("all", agents)).toEqual(["other"]);
		expect(names("self", agents)).toEqual(["me"]);
		expect(names("me", agents)).toEqual(["me"]);
	});

	it("matches children by the parent session id", () => {
		const agents = [agent("c1", { parent: self.id }), agent("x", { parent: idOf("zz") })];
		expect(names("children", agents)).toEqual(["c1"]);
	});

	it("reads owner: as id:, a full id exactly and a prefix by prefix", () => {
		const target = agent("t", { id: `${"5".repeat(12)}${"0".repeat(20)}` });
		const agents = [target, agent("u", { id: `${"6".repeat(12)}${"0".repeat(20)}` })];
		expect(names(`id:${target.id}`, agents)).toEqual(["t"]);
		expect(names(`owner:${target.id.slice(0, 12)}`, agents)).toEqual(["t"]);
	});

	it("matches an external agent by name and by its exact non-hex id", () => {
		const hermes = agent("hermes", { id: "hermes", kind: "external" });
		const agents = [hermes, agent("other")];
		expect(names("name:hermes", agents)).toEqual(["hermes"]);
		expect(names("id:hermes", agents)).toEqual(["hermes"]);
		expect(names("id:herm", agents)).toEqual([]);
	});

	it("matches host, session tag, and topic", () => {
		const agents = [agent("a", { host: "venus", topics: ["build"] }), agent("b")];
		expect(names("host:venus", agents)).toEqual(["a"]);
		expect(names("topic:build", agents)).toEqual(["a"]);
		expect(names(`session:${sessionTag(idOf("b"))}`, agents)).toEqual(["b"]);
	});

	it("matches nothing for stale", () => {
		expect(names("stale", [agent("a")])).toEqual([]);
	});

	it("reaches offline agents only by unicast id or state:offline", () => {
		const gone = agent("gone", { online: false });
		const agents = [gone, agent("here")];
		expect(names("all", agents)).toEqual(["here"]);
		expect(names("gone", agents)).toEqual([]);
		expect(names(`id:${gone.id}`, agents)).toEqual(["gone"]);
		expect(names("state:offline", agents)).toEqual(["gone"]);
		expect(reachesOffline("id:12345678|all")).toBe(false);
		expect(reachesOffline("!state:offline")).toBe(false);
	});

	it("intersects and excludes", () => {
		const agents = [agent("a", { role: "r", state: "busy" }), agent("b", { role: "r" })];
		expect(names("role:r+!state:busy", agents)).toEqual(["b"]);
	});

	it("treats a union as not unicast", () => {
		expect(isUnicastSelector("owner:12345678")).toBe(true);
		expect(isUnicastSelector("alice|bob")).toBe(false);
		expect(isUnicastSelector("role:x")).toBe(false);
	});
});
