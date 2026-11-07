import { describe, expect, it } from "vite-plus/test";
import { createEventBus } from "./events.ts";

describe("event bus", () => {
	it("delivers to listeners and isolates a throwing listener", () => {
		const failures: string[] = [];
		const bus = createEventBus((event) => failures.push(event));
		const seen: string[] = [];
		bus.on("pimon:session-ready", () => {
			throw new Error("boom");
		});
		bus.on("pimon:session-ready", ({ reason }) => seen.push(reason));
		bus.emit("pimon:session-ready", { reason: "startup" });
		expect(seen).toEqual(["startup"]);
		expect(failures).toEqual(["pimon:session-ready"]);
	});

	it("unsubscribes and does not call a listener added during emit", () => {
		const bus = createEventBus(() => {});
		const seen: string[] = [];
		const off = bus.on("pimon:session-ready", () => {
			seen.push("first");
			bus.on("pimon:session-ready", () => seen.push("late"));
		});
		bus.emit("pimon:session-ready", { reason: "a" });
		off();
		bus.emit("pimon:session-ready", { reason: "b" });
		expect(seen).toEqual(["first", "late"]);
	});
});
