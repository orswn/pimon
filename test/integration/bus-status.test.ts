import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { clearReloadState } from "../../src/core/reload-state.ts";
import { busCapture, busHarness, until } from "../support/bus.ts";
import type { Harness } from "../support/harness.ts";
import { type HubPeer, startPeer, startTestHub, type TestHub } from "../support/hub.ts";

const capture = busCapture();

describe("bus status line", () => {
	let hub: TestHub;
	let harness: Harness | undefined;
	let peer: HubPeer | undefined;
	beforeAll(async () => {
		hub = await startTestHub();
	});
	afterAll(async () => {
		await hub.close();
	});
	beforeEach(() => {
		clearReloadState();
	});
	afterEach(async () => {
		await peer?.stop();
		peer = undefined;
		capture.reset();
		await harness?.shutdown();
		harness?.dispose();
		harness = undefined;
		clearReloadState();
	});

	it("shows link state and unread count without a peer count, sends only changes, and again after a session start", async () => {
		const sent: string[] = [];
		harness = await busHarness(hub.url, capture, {
			ui: {
				setStatus: (key: string, text: string | undefined) => {
					if (key === "pi-bus") sent.push(text ?? "");
				},
			},
		});
		const h = harness;
		await until(() => sent.at(-1) === "bus: online");
		const settled = sent.length;

		h.respond([fauxAssistantMessage(fauxText("a")), fauxAssistantMessage(fauxText("b"))]);
		await h.session.prompt("one");
		await h.session.prompt("two");
		expect(sent).toHaveLength(settled);

		peer = await startPeer(hub.url, "writer");
		await peer.send(capture.get().id, "note", { wake: "never" });
		await until(() => sent.at(-1) === "bus: 1 unread");
		expect(sent.every((text) => !/peer/.test(text))).toBe(true);

		const before = sent.length;
		await h.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		expect(sent.slice(before)).toEqual(["bus: 1 unread"]);
	});
});
