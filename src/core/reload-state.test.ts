import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { clearReloadState, reloadSlot } from "./reload-state.ts";

describe("reloadSlot", () => {
	afterEach(() => clearReloadState());

	it("returns the same value for the same owner, key, and version", () => {
		const a = reloadSlot("bg", "jobs", 1, () => ({ n: 1 }));
		expect(reloadSlot("bg", "jobs", 1, () => ({ n: 2 }))).toBe(a);
		expect(reloadSlot("other", "jobs", 1, () => ({ n: 3 }))).not.toBe(a);
	});

	it("replaces the value when the version changes", () => {
		reloadSlot("bg", "jobs", 1, () => "old");
		expect(reloadSlot("bg", "jobs", 2, () => "new")).toBe("new");
	});

	it("survives a fresh copy of the module", async () => {
		const value = reloadSlot("bg", "jobs", 1, () => ({}));
		vi.resetModules();
		const fresh = await import("./reload-state.ts");
		expect(fresh.reloadSlot).not.toBe(reloadSlot);
		expect(fresh.reloadSlot("bg", "jobs", 1, () => ({}))).toBe(value);
	});
});
