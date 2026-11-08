import { describe, expect, it } from "vite-plus/test";
import { addJob, createRegistry, type JobState, oldRegistryWarning, retireJob, routeDigest } from "./registry.ts";

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

describe("registry change hook", () => {
	const job = (name: string) =>
		({
			options: { name, kind: "background" },
			sink: { close: () => {} },
			matcher: undefined,
			exitedAt: undefined,
			markExited: () => {},
		}) as unknown as JobState;

	it("is called once when a job is added and once when it retires", () => {
		const reg = createRegistry("/agent");
		let calls = 0;
		reg.changed = () => calls++;
		const state = job("build");
		addJob(reg, state);
		expect(calls).toBe(1);
		retireJob(reg, state, "exit code 0");
		expect(calls).toBe(2);
	});

	it("is called once when error and close both retire the same job", () => {
		const reg = createRegistry("/agent");
		const state = job("build");
		addJob(reg, state);
		let calls = 0;
		reg.changed = () => calls++;
		expect(retireJob(reg, state, "error")).toBe(true);
		expect(retireJob(reg, state, "exit code 1")).toBe(false);
		expect(calls).toBe(1);
	});
});
