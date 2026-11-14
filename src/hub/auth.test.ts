import { describe, expect, it } from "vite-plus/test";
import { ANONYMOUS, authenticate, parseTokens, sha256 } from "./auth.ts";

const hex = (token: string) => sha256(token).toString("hex");
const tokens = parseTokens(
	JSON.stringify({
		mars: { kind: "host", sha256: hex("mars-secret") },
		hermes: { kind: "peer", sha256: hex("hermes-secret") },
	}),
);

describe("auth", () => {
	it("maps a bearer token to its principal and kind", () => {
		expect(authenticate("Bearer mars-secret", tokens, false)).toEqual({
			ok: true,
			principal: { name: "mars", kind: "host" },
		});
		expect(authenticate("bearer hermes-secret", tokens, false)).toEqual({
			ok: true,
			principal: { name: "hermes", kind: "peer" },
		});
	});

	it("gives 401 for a missing, malformed, or wrong token", () => {
		expect(authenticate(undefined, tokens, false)).toEqual({ ok: false, status: 401 });
		expect(authenticate("", tokens, false)).toEqual({ ok: false, status: 401 });
		expect(authenticate("Basic bWFyczp4", tokens, false)).toEqual({ ok: false, status: 401 });
		expect(authenticate("Bearer wrong", tokens, false)).toEqual({ ok: false, status: 401 });
		expect(authenticate("Bearer mars-secret extra", tokens, false)).toEqual({ ok: false, status: 401 });
	});

	it("allows anonymous only on routes that permit it, and still checks a sent token", () => {
		expect(authenticate(undefined, tokens, true)).toEqual({ ok: true, principal: ANONYMOUS });
		expect(authenticate("Bearer wrong", tokens, true)).toEqual({ ok: false, status: 401 });
	});

	it("refuses a token file with a bad kind or digest", () => {
		expect(() => parseTokens('{"x": {"kind": "admin", "sha256": "' + hex("a") + '"}}')).toThrow(/kind/);
		expect(() => parseTokens('{"x": {"kind": "host", "sha256": "abc"}}')).toThrow(/sha256/);
		expect(() => parseTokens("[]")).toThrow(/object/);
		expect(parseTokens("{}").size).toBe(0);
	});
});
