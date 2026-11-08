import { describe, expect, it } from "vite-plus/test";
import { ASKPASS_REDACTED, MAX_SECRET_BYTES, redactDeep, SecretStore, transformInput, unknownHandles } from "./core.ts";

const PEM = "-----BEGIN KEY-----\nAAAAAAAAAAAAAAAAAAAAAAAA\n-----END KEY-----";

function seeded() {
	const store = new SecretStore();
	const result = transformInput("pw [[secret:hunter2]] and [[secret gh_token:ghp:abc=]]", store);
	const unnamed = result.added[0]?.name ?? "";
	return { store, result, unnamed };
}

describe("transformInput", () => {
	it("replaces tags with handles and keeps values byte exact", () => {
		const { store, result, unnamed } = seeded();
		expect(unnamed).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
		expect(result.added[1]?.name).toBe("GH_TOKEN");
		expect(result.text).toBe(`pw $PI_SECRET_${unnamed} and $PI_SECRET_GH_TOKEN`);
		expect(store.get("GH_TOKEN")).toBe("ghp:abc=");
	});

	it("reuses the handle of a known value and flags a replaced name", () => {
		const { store, unnamed } = seeded();
		expect(transformInput("[[secret:hunter2]]", store).added[0]?.name).toBe(unnamed);
		expect(transformInput("[[secret GH_TOKEN:new]]", store).added[0]?.replaced).toBe(true);
	});

	it("passes an escaped tag literally", () => {
		expect(transformInput("\\[[secret:x]] y", new SecretStore()).text).toBe("[[secret:x]] y");
	});

	it("strips one newline at each end of a multiline value", () => {
		const store = new SecretStore();
		const result = transformInput(`[[secret K:\n${PEM}\n]]`, store);
		expect(store.get("K")).toBe(PEM);
		expect(result.text).toBe("$PI_SECRET_K");
		transformInput(`[[secret K2:\n${PEM}\n\n]]`, store);
		expect(store.get("K2")).toBe(`${PEM}\n`);
	});

	it("stores nothing when one tag is too large", () => {
		const store = new SecretStore();
		expect(() => transformInput(`[[secret A:ok]] [[secret B:${"x".repeat(MAX_SECRET_BYTES + 1)}]]`, store)).toThrow(
			/exceeds/,
		);
		expect(store.size).toBe(0);
	});

	it("rejects an empty value", () => {
		expect(() => transformInput("[[secret:]]", new SecretStore())).toThrow("empty secret tag");
	});
});

describe("SecretStore.redact", () => {
	it("redacts the value, its CRLF form, and long single lines", () => {
		const { store, unnamed } = seeded();
		transformInput(`[[secret K:\n${PEM}\n]]`, store);
		expect(store.redact("x hunter2 y")).toBe(`x $PI_SECRET_${unnamed} y`);
		expect(store.redact(PEM.replace(/\n/g, "\r\n"))).toBe("$PI_SECRET_K");
		expect(store.redact("AAAAAAAAAAAAAAAAAAAAAAAA")).toContain("$PI_SECRET_K");
	});

	it("does not redact values under 4 characters", () => {
		const store = new SecretStore();
		store.add("abc", "SHORT");
		expect(store.redact("abc")).toBe("abc");
	});
});

describe("SecretStore.addRedactOnly", () => {
	it("redacts an askpass reply to a literal that is not a handle, and gives it no name", () => {
		const store = new SecretStore();
		store.addRedactOnly("sudo-password-1");
		expect(store.redact("pw=sudo-password-1")).toBe("pw=[askpass reply redacted]");
		expect(ASKPASS_REDACTED).not.toMatch(/PI_SECRET_/);
		expect(store.names()).toEqual([]);
		expect(store.size).toBe(1);
		expect(unknownHandles(store.redact("echo sudo-password-1"), store)).toEqual([]);
	});

	it("keeps the handle when the same value also came from a tag", () => {
		const store = new SecretStore();
		store.add("shared-value", "DB");
		store.addRedactOnly("shared-value");
		expect(store.redact("shared-value")).toBe("$PI_SECRET_DB");
		store.clear();
		store.addRedactOnly("shared-value");
		store.add("shared-value", "DB");
		expect(store.redact("shared-value")).toBe("$PI_SECRET_DB");
	});

	it("forgets askpass replies on clear", () => {
		const store = new SecretStore();
		store.addRedactOnly("sudo-password-1");
		store.clear();
		expect(store.size).toBe(0);
		expect(store.redact("sudo-password-1")).toBe("sudo-password-1");
	});
});

describe("unknownHandles", () => {
	it("finds only expansions of unknown names", () => {
		const { store } = seeded();
		expect(unknownHandles("echo $PI_SECRET_NOPE ${PI_SECRET_GH_TOKEN} PI_SECRET_BARE", store)).toEqual([
			"$PI_SECRET_NOPE",
		]);
		expect(unknownHandles("echo ${#PI_SECRET_LEN} ${PI_SECRET_DEF:-x}", store)).toEqual([
			"$PI_SECRET_LEN",
			"$PI_SECRET_DEF",
		]);
	});
});

describe("redactDeep", () => {
	it("walks arrays and objects", () => {
		const { store, unnamed } = seeded();
		expect(redactDeep({ a: ["hunter2"], n: 1 }, store)).toEqual({ a: [`$PI_SECRET_${unnamed}`], n: 1 });
	});
});
