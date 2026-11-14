import { describe, expect, it } from "vite-plus/test";
import { cardUrl, EXTERNAL_DEFAULTS, parseExternal } from "./external.ts";
import { outboundText, parseSkills } from "./gateway.ts";

describe("external agent file", () => {
	it("reads one agent with defaults", () => {
		expect(parseExternal(JSON.stringify({ hermes: { url: "http://hermes:9900/", token: "t" } }))).toEqual([
			{
				id: "hermes",
				name: "hermes",
				url: "http://hermes:9900/",
				token: "t",
				description: "hermes: an external A2A agent",
				...EXTERNAL_DEFAULTS,
			},
		]);
		expect(EXTERNAL_DEFAULTS.replyTimeoutMs).toBe(960_000);
	});

	it("refuses a bad file", () => {
		const bad = (value: unknown) => () => parseExternal(JSON.stringify(value));
		expect(() => parseExternal("{")).toThrow();
		expect(bad([])).toThrow("JSON object");
		expect(bad({ "bad id": { url: "http://h/", token: "t" } })).toThrow("invalid characters");
		expect(bad({ h: { token: "t" } })).toThrow("url must be");
		expect(bad({ h: { url: "ftp://h/", token: "t" } })).toThrow("http or https");
		expect(bad({ h: { url: "http://h/" } })).toThrow("token must be");
		expect(bad({ h: { url: "http://h/", token: "t", pollMs: 0 } })).toThrow("pollMs must be");
		expect(bad({ h: { url: "http://h/", token: "t", tokenEnv: "X" } })).toThrow("unknown field tokenEnv");
		expect(
			bad({ a: { url: "http://h/", token: "t", name: "x" }, b: { url: "http://h/", token: "t", name: "x" } }),
		).toThrow("used twice");
	});

	it("keeps the token out of every parse error", () => {
		const error = (source: string) => {
			try {
				parseExternal(source);
			} catch (caught) {
				return String(caught);
			}
			return "no error";
		};
		const broken = error('{ "h": { "url": "http://h/", "token": hX9secretTOKEN } }');
		expect(broken).toBe("Error: external file is not valid JSON");
		const control = error(JSON.stringify({ h: { url: "http://h/", token: "sec\nretTOKEN" } }));
		expect(control).toBe("Error: external agent h: token must be visible ASCII");
		const spaced = error(JSON.stringify({ h: { url: "http://h/", token: "sec retTOKEN" } }));
		expect(spaced).toBe("Error: external agent h: token must be visible ASCII");
		expect(error(JSON.stringify({ h: { url: "http://h/", token: " secretTOKEN " } }))).toBe(
			"Error: external agent h: token must be visible ASCII",
		);
		for (const text of [broken, control, spaced]) expect(text).not.toMatch(/secret|TOKEN/);
	});

	it("refuses a name that no /a2a/@<name> URL can reach", () => {
		const named = (name: string) => () => parseExternal(JSON.stringify({ h: { url: "http://h/", token: "t", name } }));
		for (const name of ["two words", "a/b", "@h", "-h"]) expect(named(name)).toThrow("name must match");
		expect(named("Hermes.2")()).toMatchObject([{ name: "Hermes.2" }]);
	});

	it("finds the card next to the JSON-RPC URL", () => {
		expect(cardUrl("http://hermes:9900/")).toBe("http://hermes:9900/.well-known/agent-card.json");
		expect(cardUrl("http://h:1/a2a/x")).toBe("http://h:1/a2a/x/.well-known/agent-card.json");
	});
});

describe("external gateway helpers", () => {
	it("names the sender in front of the text", () => {
		expect(outboundText("hi", "bee", "mars")).toBe("[from bee on mars]\nhi");
		expect(outboundText("hi", "hermes", null)).toBe("[from hermes]\nhi");
	});

	it("keeps only well-formed skills of the agent card", () => {
		expect(
			parseSkills({
				skills: [
					{ id: "toolset.web", name: "web", description: "d", tags: ["web", 3] },
					{ id: "no-name" },
					{ id: "x", name: "x" },
				],
			}),
		).toEqual([
			{ id: "toolset.web", name: "web", description: "d", tags: ["web"] },
			{ id: "x", name: "x", description: "", tags: [] },
		]);
		expect(parseSkills({})).toEqual([]);
	});
});
