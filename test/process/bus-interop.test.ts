import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
	type Driver,
	NEW_BUS_DRIVER as NEW,
	OLD_BUS_DRIVER as OLD,
	sleep,
	startDriver,
} from "../support/bus-driver.ts";

describe("old and new bus nodes on one bus", () => {
	let root: string;
	let busDir: string;
	const drivers: Driver[] = [];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "bus-interop-"));
		busDir = join(root, "bus");
	});

	afterEach(async () => {
		for (const driver of drivers.splice(0)) driver.child.kill("SIGKILL");
		await sleep(50);
		rmSync(root, { recursive: true, force: true });
	});

	function start(script: string, name: string, extra: string[] = []): Driver {
		const driver = startDriver(script, name, busDir, extra);
		drivers.push(driver);
		return driver;
	}

	async function pair(options: { mute?: boolean } = {}) {
		const flags = options.mute ? ["--mute"] : [];
		const old = start(OLD, "old-peer", flags);
		const fresh = start(NEW, "new-peer", flags);
		const [oldStart, newStart] = await Promise.all([old.next("started"), fresh.next("started")]);
		return { old, fresh, oldId: String(oldStart.payload["instanceId"]), newId: String(newStart.payload["instanceId"]) };
	}

	async function pendingOf(driver: Driver) {
		const result = driver.next("pending");
		driver.send({ cmd: "pending" });
		return (await result).payload as unknown as { body: string }[];
	}

	it.each([
		["old", "new"],
		["new", "old"],
	] as const)("delivers from %s to %s with an ack", async (from, to) => {
		const { old, fresh } = await pair();
		const [sender, receiver] = from === "old" ? [old, fresh] : [fresh, old];
		const received = receiver.next("envelope");
		const result = sender.next("send_result");
		sender.send({ cmd: "send", to: `name:${to}-peer`, body: `hi from ${from}` });
		expect((await result).payload["delivered"]).toEqual([`${to}-peer`]);
		expect((await received).payload).toMatchObject({ body: `hi from ${from}`, from: `${from}-peer`, wake: "now" });
	});

	it.each([
		["old", "new"],
		["new", "old"],
	] as const)("drops a duplicate envelope from %s at %s", async (from, _to) => {
		const { old, fresh } = await pair();
		const [sender, receiver] = from === "old" ? [old, fresh] : [fresh, old];
		const result = sender.next("dup_result");
		sender.send({ cmd: "senddup", to: from === "old" ? "name:new-peer" : "name:old-peer", body: "once" });
		const acks = (await result).payload as unknown as { first: { accepted: boolean }[]; second: { reason?: string }[] };
		expect(acks.first[0]?.accepted).toBe(true);
		expect(acks.second[0]?.reason).toMatch(/duplicate/);
		await sleep(200);
		expect(receiver.events.filter((entry) => entry.event === "envelope")).toHaveLength(1);
	});

	it.each([
		["old", "new"],
		["new", "old"],
	] as const)("settles a question from %s with a reply by full id from %s", async (asker, _answerer) => {
		const { old, fresh } = await pair({ mute: true });
		const [from, to] = asker === "old" ? [old, fresh] : [fresh, old];
		const toName = asker === "old" ? "new-peer" : "old-peer";
		const fromName = asker === "old" ? "old-peer" : "new-peer";
		const question = to.next("envelope");
		from.send({ cmd: "send", to: `name:${toName}`, body: "question?", kind: "question" });
		const inbound = await question;
		expect(await pendingOf(from)).toHaveLength(1);
		const answer = from.next("envelope");
		to.send({ cmd: "answer", to: `name:${fromName}`, body: "answer", corrId: String(inbound.payload["messageId"]) });
		expect((await answer).payload["corrId"]).toBe(inbound.payload["messageId"]);
		await sleep(150);
		expect(await pendingOf(from)).toEqual([]);
	});

	it.each([
		["old", "new"],
		["new", "old"],
	] as const)("reports %s stopping its endpoint as left to %s", async (leaver, _watcher) => {
		const { old, fresh } = await pair();
		const [leaving, watcher] = leaver === "old" ? [old, fresh] : [fresh, old];
		const watching = watcher.next("watching");
		watcher.send({ cmd: "watch", to: `name:${leaver}-peer` });
		await watching;
		const gone = watcher.next("peer_gone");
		leaving.send({ cmd: "endpoint_stop" });
		expect((await gone).payload).toMatchObject({ name: `${leaver}-peer`, reason: "left", pending: 0 });
	});

	it("keeps each heartbeat fresh for the other side", async () => {
		const { fresh, oldId, newId } = await pair();
		const read = (id: string) =>
			JSON.parse(readFileSync(join(busDir, "peers", `${id}.json`), "utf8")) as { heartbeatAt: number };
		const before = { old: read(oldId).heartbeatAt, fresh: read(newId).heartbeatAt };
		await sleep(5_600);
		expect(read(oldId).heartbeatAt).toBeGreaterThan(before.old);
		expect(read(newId).heartbeatAt).toBeGreaterThan(before.fresh);
		const listed = fresh.next("peers");
		fresh.send({ cmd: "peers" });
		expect(((await listed).payload as unknown as { name: string }[]).map((peer) => peer.name).sort()).toEqual([
			"new-peer",
			"old-peer",
		]);
	});
});
