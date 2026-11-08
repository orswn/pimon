import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { type Driver, NEW_BUS_DRIVER, sleep, startDriver } from "../support/bus-driver.ts";

describe("bus transport", () => {
	let root: string;
	let busDir: string;
	const drivers: Driver[] = [];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bus-transport-"));
		busDir = join(root, "bus");
	});

	afterEach(async () => {
		for (const driver of drivers.splice(0)) driver.child.kill("SIGKILL");
		await sleep(50);
		rmSync(root, { recursive: true, force: true });
	});

	async function start(name: string): Promise<Driver> {
		const driver = startDriver(NEW_BUS_DRIVER, name, busDir);
		drivers.push(driver);
		await driver.next("started");
		return driver;
	}

	it("refuses an oversized body before sending", async () => {
		const sender = await start("sender");
		const receiver = await start("receiver");
		const result = sender.next("bigsend");
		sender.send({ cmd: "sendbig", to: "name:receiver" });
		expect((await result).payload).toMatchObject({ rejected: true });
		await sleep(200);
		expect(receiver.count("envelope")).toBe(0);
	});

	it("reports a blocked receiver as unconfirmed, keeps it, and delivers after the stall", async () => {
		const sender = await start("sender");
		const worker = await start("worker");
		const blocking = worker.next("blocking");
		worker.send({ cmd: "block", ms: "4500" });
		await blocking;
		const result = sender.next("send_result", 10_000);
		sender.send({ cmd: "send", to: "name:worker", body: "while blocked" });
		const payload = (await result).payload as { delivered: string[]; unknown: { reason: string }[]; failed: unknown[] };
		expect(payload.delivered).toEqual([]);
		expect(payload.failed).toEqual([]);
		expect(payload.unknown[0]?.reason).toMatch(/delivery unknown/);
		expect(readdirSync(join(busDir, "peers")).filter((file) => file.endsWith(".json"))).toHaveLength(2);
		const listed = sender.next("peers");
		sender.send({ cmd: "peers" });
		expect(((await listed).payload as unknown as { name: string }[]).map((peer) => peer.name)).toContain("worker");

		await worker.next("unblocked", 10_000);
		await sleep(200);
		expect(worker.events.some((entry) => entry.event === "envelope" && entry.payload["body"] === "while blocked")).toBe(
			true,
		);
		const after = sender.next("send_result");
		sender.send({ cmd: "send", to: "name:worker", body: "after unblock" });
		expect((await after).payload["delivered"]).toEqual(["worker"]);
	});

	it("leaves no socket or presence when it stops during a rebind", async () => {
		const observer = await start("observer");
		const racer = await start("racer");
		const sock = String(racer.events.find((entry) => entry.event === "started")?.payload["sock"]);
		racer.send({ cmd: "quitrace" });
		await racer.next("quitraced");
		await racer.exited;
		await sleep(200);
		expect(existsSync(sock)).toBe(false);
		expect(readdirSync(join(busDir, "peers"))).toHaveLength(1);
		const listed = observer.next("peers");
		observer.send({ cmd: "peers" });
		expect(((await listed).payload as unknown as { name: string }[]).map((peer) => peer.name)).toEqual(["observer"]);
	});

	it("reports a resend to a vanished target as failed", async () => {
		const sender = await start("sender");
		const transient = await start("transient");
		const first = sender.next("resend_first");
		sender.send({ cmd: "resend_dead", to: "name:transient", body: "retry me" });
		expect((await first).payload["delivered"]).toEqual(["transient"]);
		transient.send({ cmd: "quit" });
		await transient.exited;
		const again = sender.next("resend_result");
		sender.send({ cmd: "resend_now" });
		const payload = (await again).payload as { delivered: string[]; failed: { reason: string }[] };
		expect(payload.delivered).toEqual([]);
		expect(payload.failed[0]?.reason).toMatch(/target is no longer live/);
	});
});
