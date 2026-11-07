import { describe, expect, it } from "vite-plus/test";
import type { Liveness } from "./identity.ts";
import type { Lease } from "./leases.ts";
import { type ClassifyDeps, classifyLease } from "./recovery.ts";

const base: Lease = {
	version: 1,
	name: "job",
	kind: "background",
	command: "x",
	cwd: "/tmp",
	logFile: "/tmp/job.log",
	createdAt: 1,
	identity: { bootId: "boot", pid: 10, pgid: 10, startTicks: 5 },
};
const owned = (pid: number): Lease => ({ ...base, owner: { pid, startTicks: 7 } });
const deps = (group: Liveness, owner: Liveness): ClassifyDeps => ({
	selfPid: 100,
	group: () => group,
	owner: () => owner,
});

describe("lease classification", () => {
	it("a dead job is gone whoever owns it", () => {
		expect(classifyLease(owned(200), false, deps("gone", "alive"))).toBe("gone");
		expect(classifyLease(base, false, deps("gone", "gone"))).toBe("gone");
	});

	it("a live sibling's job is never claimed", () => {
		expect(classifyLease(owned(200), false, deps("alive", "alive"))).toBe("foreign");
	});

	it("an unverifiable sibling is treated as alive", () => {
		expect(classifyLease(owned(200), false, deps("alive", "ambiguous"))).toBe("foreign");
	});

	it("a job whose owner died is an orphan", () => {
		expect(classifyLease(owned(200), false, deps("alive", "gone"))).toBe("orphan");
		expect(classifyLease(owned(200), false, deps("ambiguous", "gone"))).toBe("orphan");
	});

	it("this process's own lease is an orphan only when the registry lost it", () => {
		expect(classifyLease(owned(100), true, deps("alive", "alive"))).toBe("own");
		expect(classifyLease(owned(100), false, deps("alive", "alive"))).toBe("orphan");
	});

	it("a live lease from the old extension, which has no owner, is left alone", () => {
		expect(classifyLease(base, false, deps("alive", "gone"))).toBe("foreign");
	});
});
