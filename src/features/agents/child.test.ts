import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import { sendTask } from "./child.ts";

describe("first task of a spawned child", () => {
	it("queues behind a run that already started instead of failing", () => {
		const calls: unknown[][] = [];
		const pi = { sendUserMessage: (...args: unknown[]) => calls.push(args) } as unknown as ExtensionAPI;
		sendTask(pi, "Task: x");
		expect(calls).toEqual([["Task: x", { deliverAs: "followUp" }]]);
	});
});
