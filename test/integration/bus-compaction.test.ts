import {
	type AssistantMessage,
	fauxAssistantMessage,
	type FauxResponseStep,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { defineFeature } from "../../src/core/feature.ts";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { bus, type BusService } from "../../src/features/bus/index.ts";
import { BusNode } from "../../src/features/bus/node.ts";
import { busDirs } from "../../src/features/bus/registry.ts";
import { createHarness, type Harness } from "../support/harness.ts";

let service: BusService | undefined;
const capture = defineFeature({
	id: "bus-capture",
	description: "test feature that captures the bus service",
	defaultEnabled: true,
	dependsOn: ["bus"],
	setup(ctx) {
		service = ctx.service("bus");
	},
});

interface Latch {
	promise: Promise<void>;
	open(): void;
}

function latch(): Latch {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

function held(started: Latch, release: Latch, reply: AssistantMessage): FauxResponseStep {
	return async () => {
		started.open();
		await release.promise;
		return reply;
	};
}

const say = (text: string) => fauxAssistantMessage(fauxText(text));
const big = (marker: string) => `${marker} ${"x".repeat(100_000)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const has = (messages: unknown, needle: string) => JSON.stringify(messages ?? []).includes(needle);

describe("bus digests and compaction", () => {
	let harness: Harness | undefined;
	let peer: BusNode | undefined;

	beforeEach(() => clearReloadState());
	afterEach(async () => {
		await peer?.stop();
		peer = undefined;
		await harness?.shutdown();
		harness?.dispose();
		harness = undefined;
		service = undefined;
		clearReloadState();
	});

	async function setup(steps: FauxResponseStep[]): Promise<{ h: Harness; self: string }> {
		const h = await createHarness({ features: [bus, capture] });
		harness = h;
		const deadline = Date.now() + 5_000;
		while (!service?.started) {
			if (Date.now() > deadline) throw new Error("bus did not start");
			await sleep(20);
		}
		peer = new BusNode({
			owner: crypto.randomUUID(),
			desiredName: "peer",
			dirs: busDirs(h.agentDir),
			onEnvelope: () => {},
		});
		await peer.start();
		h.respond([say("R1"), say("R2"), ...steps]);
		await h.session.prompt(big("OLD-P1"));
		await h.session.prompt(big("OLD-P2"));
		return { h, self: `id:${service.instanceId}` };
	}

	it("starts no request for a digest during a manual compaction", async () => {
		const started = latch();
		const release = latch();
		const { h, self } = await setup([held(started, release, say("SUMMARY")), say("WOKE")]);
		const log: string[] = [];
		h.session.subscribe((event) => {
			if (event.type === "compaction_end") log.push(`compaction_end@${h.requests.length}`);
			if (event.type === "agent_start") log.push(`agent_start@${h.requests.length}`);
		});

		const compacting = h.session.compact();
		await started.promise;
		await peer?.send(self, { body: "DURING-COMPACTION", kind: "note", wake: "now" });
		await sleep(1_600);
		expect(h.requests).toHaveLength(3);
		release.open();
		await compacting;
		await h.waitForRequests(4);

		expect(log).toEqual(["compaction_end@3", "agent_start@3"]);
		expect(has(h.requests[3], "DURING-COMPACTION")).toBe(true);
		expect(has(h.requests[3], "SUMMARY")).toBe(true);
	});

	it("keeps a digest unread when compaction aborts its run", async () => {
		const started = latch();
		const release = latch();
		const { h, self } = await setup([
			held(started, release, say("NEVER-SEEN")),
			say("SUMMARY"),
			fauxAssistantMessage(fauxToolCall("pi_bus", { action: "inbox" }), { stopReason: "toolUse" }),
			say("done"),
		]);
		await peer?.send(self, { body: "ABORTED-DIGEST", kind: "note", wake: "now" });
		await started.promise;
		const compacting = h.session.compact();
		release.open();
		await compacting;
		await h.session.waitForIdle();

		await h.session.prompt("inbox");
		const results = h.session.messages.filter((message) => message.role === "toolResult");
		const text = JSON.stringify(results.at(-1));
		expect(text).toContain("ABORTED-DIGEST");
		expect(text).toContain("unread");
	});
});
