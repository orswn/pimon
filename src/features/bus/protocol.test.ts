import { describe, expect, it } from "vite-plus/test";
import { normalizeWake, withoutToken } from "./protocol.ts";

const A = "aaaaaaaa-1111-4111-8111-111111111111";

describe("bus protocol", () => {
	it("normalizes wake values", () => {
		expect(normalizeWake()).toBe("now");
		expect(normalizeWake("next-turn")).toBe("now");
		expect(normalizeWake("never")).toBe("never");
	});

	it("strips the token from control data only", () => {
		const base = {
			v: 1,
			id: A,
			threadId: A,
			to: "x",
			priority: "normal",
			wake: "now",
			body: "",
			createdAt: 0,
		} as const;
		const from = { instanceId: A, owner: A, name: "n", pid: 1, cwd: "/", sock: "/s", labels: {} };
		expect(withoutToken({ ...base, from, kind: "control", data: { token: "t", a: 1 } }).data).toEqual({ a: 1 });
		expect(withoutToken({ ...base, from, kind: "note", data: { token: "t" } }).data).toEqual({ token: "t" });
	});
});
