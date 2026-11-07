import { describe, expect, it } from "vite-plus/test";
import { createRegistry, oldRegistryWarning, routeDigest } from "./registry.ts";

describe("digest routing", () => {
	it("steers into the session that started the job", () => {
		expect(routeDigest("session-a", "session-a")).toBe("steer");
	});

	it("only notifies any other session", () => {
		expect(routeDigest("session-a", "session-b")).toBe("notice");
		expect(routeDigest("session-a", undefined)).toBe("notice");
	});
});

describe("old background extension registry", () => {
	it("warns once with the names of jobs it still runs", () => {
		const holder = {
			__piBackgroundRegistry_v2: {
				active: new Map([
					["tests", {}],
					["server", {}],
				]),
			},
		};
		expect(oldRegistryWarning(holder)).toBe(
			"2 job(s) from the old background extension still run in this process: tests, server. pimon cannot manage them. Restart pi after they end.",
		);
	});

	it("says nothing when there is no old registry or it is empty", () => {
		expect(oldRegistryWarning({})).toBeUndefined();
		expect(oldRegistryWarning({ __piBackgroundRegistry_v2: { active: new Map() } })).toBeUndefined();
		expect(oldRegistryWarning({ __piBackgroundRegistry_v2: "junk" })).toBeUndefined();
	});
});

describe("registry", () => {
	it("starts empty, with no reported leases", () => {
		const reg = createRegistry("/agent");
		expect(reg.active.size + reg.completed.size + reg.orphans.size + reg.reportedLeases.size).toBe(0);
		expect(reg.agentDir).toBe("/agent");
	});
});
