import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import { newChildState, sendTask, spawnIdentity } from "./child.ts";
import type { SpawnFile } from "./spawn-file.ts";

const DATA: SpawnFile = {
	version: 2,
	spawnId: "child-1",
	role: { name: "worker", prompt: "You work." },
	parent: { name: "boss", id: "a".repeat(32) },
	child: { name: "w1", labels: { depth: "1" } },
	firstTask: { messageId: "m-1" },
	createdAt: 1,
};

describe("first task of a spawned child", () => {
	it("queues behind a run that already started instead of failing", () => {
		const calls: unknown[][] = [];
		const pi = { sendUserMessage: (...args: unknown[]) => calls.push(args) } as unknown as ExtensionAPI;
		sendTask(pi, "Task: x");
		expect(calls).toEqual([["Task: x", { deliverAs: "followUp" }]]);
	});

	it("names the first task in the identity only until it came", () => {
		const state = { ...newChildState(), read: true, data: DATA, firstTask: { sent: false } };
		const source = { entry: { ...DATA }, data: DATA };
		expect(spawnIdentity(state, source)).toEqual({
			name: "w1",
			role: "worker",
			parent: "a".repeat(32),
			labels: { depth: "1" },
			firstTask: "m-1",
		});
		state.firstTask = { sent: false, text: "Task: x" } as never;
		expect(spawnIdentity(state, source)?.firstTask).toBeUndefined();
		expect(spawnIdentity(state, { entry: source.entry })?.firstTask).toBeUndefined();
	});
});
