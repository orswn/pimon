import { describe, expect, it } from "vite-plus/test";
import {
	captureIdentity,
	captureOwner,
	groupMembers,
	type ProcessIdentity,
	readProcess,
	type VerifyDeps,
	verifyGroup,
	verifyLeader,
	verifyOwner,
} from "./identity.ts";

describe("identity from the real /proc", () => {
	it("reads our own stat", () => {
		const self = readProcess(process.pid);
		expect(self?.pid).toBe(process.pid);
		expect(self?.startTicks).toBeGreaterThan(0);
		expect(self?.pgid).toBeGreaterThan(0);
		expect(readProcess(999_999_998)).toBeUndefined();
	});

	it("captures a boot id and verifies ourselves as alive", () => {
		const self = readProcess(process.pid);
		const identity = captureIdentity(process.pid);
		expect(identity?.bootId?.length).toBeGreaterThan(10);
		expect(identity && self && verifyLeader({ ...identity, pgid: self.pgid })).toBe("alive");
	});

	it("group scan finds our own group", () => {
		const self = readProcess(process.pid);
		expect(self && groupMembers(self.pgid, undefined).some((member) => member.pid === process.pid)).toBe(true);
	});

	it("captures and verifies this pi process as an owner", () => {
		const owner = captureOwner();
		expect(owner?.pid).toBe(process.pid);
		expect(owner && verifyOwner(owner)).toBe("alive");
		expect(owner && verifyOwner({ ...owner, startTicks: owner.startTicks + 1 })).toBe("gone");
	});
});

describe("pid reuse and reboot, through injected readers", () => {
	const identity = { bootId: "boot-A", pid: 4242, pgid: 4242, startTicks: 1000 };
	const readAs = (proc: ProcessIdentity | undefined): VerifyDeps => ({
		readProcess: () => proc,
		readBootId: () => "boot-A",
		available: () => true,
	});
	const proc = (over: Partial<ProcessIdentity> = {}): ProcessIdentity => ({
		pid: 4242,
		pgid: 4242,
		startTicks: 1000,
		state: "S",
		...over,
	});

	it("same pid and start ticks is alive", () => {
		expect(verifyLeader(identity, readAs(proc()))).toBe("alive");
	});

	it("same pid with different start ticks is gone, not alive", () => {
		expect(verifyLeader(identity, readAs(proc({ startTicks: 9999 })))).toBe("gone");
	});

	it("a vanished pid is gone", () => {
		expect(verifyLeader(identity, readAs(undefined))).toBe("gone");
	});

	it("same pid leading a different group is ambiguous, never alive", () => {
		expect(verifyLeader(identity, readAs(proc({ pgid: 77 })))).toBe("ambiguous");
	});

	it("a different boot id is gone", () => {
		expect(verifyLeader(identity, { ...readAs(proc()), readBootId: () => "boot-B" })).toBe("gone");
	});

	it("missing start ticks can never be alive", () => {
		expect(verifyLeader({ ...identity, startTicks: undefined }, readAs(proc()))).toBe("ambiguous");
	});

	it("no /proc means ambiguous, not gone", () => {
		expect(verifyLeader(identity, { available: () => false })).toBe("ambiguous");
	});

	it("D state still counts as alive", () => {
		expect(verifyLeader(identity, readAs(proc({ state: "D" })))).toBe("alive");
	});

	it("an owner with a reused pid, a new boot, or no /proc is not alive", () => {
		const owner = { pid: 4242, startTicks: 1000, bootId: "boot-A" };
		expect(verifyOwner(owner, readAs(proc()))).toBe("alive");
		expect(verifyOwner(owner, readAs(proc({ startTicks: 5 })))).toBe("gone");
		expect(verifyOwner(owner, readAs(undefined))).toBe("gone");
		expect(verifyOwner(owner, { ...readAs(proc()), readBootId: () => "boot-B" })).toBe("gone");
		expect(verifyOwner(owner, { available: () => false })).toBe("ambiguous");
	});
});

describe("a dead leader with live group members", () => {
	const identity = { bootId: "boot-A", pid: 4242, pgid: 4242, startTicks: 1000 };
	const deps = {
		available: () => true,
		readBootId: () => "boot-A",
		readProcess: (pid: number) => (pid === 4242 ? undefined : { pid, pgid: 4242, startTicks: 5000, state: "S" }),
		listPids: () => [4242, 4243],
	};

	it("group liveness is ambiguous when only descendants remain", () => {
		expect(verifyGroup(identity, deps)).toBe("ambiguous");
		expect(verifyLeader(identity, deps)).toBe("gone");
	});

	it("members older than the lease do not resurrect it", () => {
		const older = {
			...deps,
			readProcess: (pid: number) => (pid === 4242 ? undefined : { pid, pgid: 4242, startTicks: 10, state: "S" }),
		};
		expect(verifyGroup(identity, older)).toBe("gone");
		expect(groupMembers(4242, 1000, older)).toHaveLength(0);
	});
});
