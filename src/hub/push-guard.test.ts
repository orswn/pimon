import { describe, expect, it } from "vite-plus/test";
import { parsePushAllow, PushGuard, type Resolver } from "./push-guard.ts";

const resolver =
	(table: Record<string, string[]>): Resolver =>
	async (host) => {
		const addresses = table[host];
		if (!addresses) throw new Error(`ENOTFOUND ${host}`);
		return addresses;
	};

describe("push guard", () => {
	it("denies private, loopback, link-local, CGNAT, unspecified, and multicast addresses by default", () => {
		const guard = new PushGuard();
		for (const ip of [
			"127.0.0.1",
			"10.1.2.3",
			"172.20.0.5",
			"192.168.1.1",
			"169.254.169.254",
			"100.100.1.1",
			"0.0.0.0",
			"224.0.0.1",
			"::1",
			"::",
			"fd12::1",
			"fe80::1",
			"ff02::1",
			"::ffff:127.0.0.1",
		]) {
			expect(guard.addressAllowed(ip), ip).toBe(false);
		}
		for (const ip of ["93.184.216.34", "100.128.0.1", "172.32.0.1", "2606:4700::1111"]) {
			expect(guard.addressAllowed(ip), ip).toBe(true);
		}
	});

	it("refuses an IP literal in a denied range at config time and leaves host names to send time", () => {
		const guard = new PushGuard();
		expect(guard.checkUrl(new URL("http://169.254.169.254/latest"))).toMatch(/169\.254\.169\.254/);
		expect(guard.checkUrl(new URL("http://[::1]:8080/x"))).toMatch(/::1/);
		expect(guard.checkUrl(new URL("http://2130706433/"))).toMatch(/127\.0\.0\.1/);
		expect(guard.checkUrl(new URL("https://hooks.example/a"))).toBeUndefined();
		expect(guard.checkUrl(new URL("https://93.184.216.34/a"))).toBeUndefined();
	});

	it("checks every resolved address at send time", async () => {
		const guard = new PushGuard(
			[],
			resolver({
				"public.example": ["93.184.216.34"],
				"rebind.example": ["93.184.216.34", "10.0.0.7"],
				"inside.example": ["192.168.0.10"],
			}),
		);
		expect(await guard.checkSend("https://public.example/hook")).toBeUndefined();
		expect(await guard.checkSend("https://rebind.example/hook")).toMatch(/10\.0\.0\.7/);
		expect(await guard.checkSend("https://inside.example/hook")).toMatch(/192\.168\.0\.10/);
		expect(await guard.checkSend("https://missing.example/hook")).toMatch(/ENOTFOUND/);
		expect(await guard.checkSend("http://127.0.0.1:9/hook")).toMatch(/127\.0\.0\.1/);
	});

	it("allows host names and CIDRs from the allow list", async () => {
		const guard = new PushGuard(
			["hooks.internal", "10.20.0.0/16", "fd00::5"],
			resolver({ "hooks.internal": ["10.9.9.9"], "svc.example": ["10.20.3.4"], "other.example": ["10.21.0.1"] }),
		);
		expect(await guard.checkSend("http://hooks.internal/x")).toBeUndefined();
		expect(await guard.checkSend("http://HOOKS.internal./x")).toBeUndefined();
		expect(await guard.checkSend("http://svc.example/x")).toBeUndefined();
		expect(await guard.checkSend("http://other.example/x")).toMatch(/10\.21\.0\.1/);
		expect(guard.checkUrl(new URL("http://10.20.1.1/x"))).toBeUndefined();
		expect(guard.checkUrl(new URL("http://[fd00::5]/x"))).toBeUndefined();
		expect(guard.checkUrl(new URL("http://[fd00::6]/x"))).toMatch(/fd00::6/);
	});

	it("parses the allow list and refuses a bad entry", () => {
		expect(parsePushAllow(" Hooks.Example , 10.0.0.0/8,::1,, ")).toEqual(["hooks.example", "10.0.0.0/8", "::1"]);
		expect(parsePushAllow(undefined)).toEqual([]);
		for (const bad of ["10.0.0.0/33", "fd00::/129", "10.0.0.0/x", "http://x", "a b", "-bad.example"]) {
			expect(() => parsePushAllow(bad), bad).toThrow(/push allow/);
		}
	});
});
