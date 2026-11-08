import { describe, expect, it } from "vite-plus/test";
import { adoptOwner, busLabels, defaultName, deleteIdentityEnv, readLaunchEnv } from "./identity.ts";

describe("bus identity", () => {
	it("uses a non-empty PI_BUS_OWNER before a new uuid and ignores an owner left on globalThis", () => {
		const globals = globalThis as Record<string, unknown>;
		globals["__piBusOwner"] = "old-owner";
		try {
			expect(adoptOwner({ owner: "env-owner" })).toBe("env-owner");
			expect(adoptOwner({ owner: "" })).toMatch(/^[0-9a-f-]{36}$/);
			expect(globals["__piBusOwner"]).toBe("old-owner");
		} finally {
			delete globals["__piBusOwner"];
		}
	});

	it("reads launch values once and removes identity keys from the env", () => {
		const env: NodeJS.ProcessEnv = {
			PI_BUS_ROLE: "reviewer",
			PI_BUS_PARENT: "p",
			PI_BUS_CONTROL_TOKEN: "t",
			PI_BUS_WAKE_POLICY: "parent",
			PI_BUS_DIR: "/d",
			PIMON_SPAWN_FILE: "/f",
			OTHER: "x",
		};
		const launch = readLaunchEnv(env);
		deleteIdentityEnv(env);
		expect(launch).toMatchObject({ role: "reviewer", parent: "p", controlToken: "t", spawnFile: "/f" });
		expect(env).toEqual({ PI_BUS_WAKE_POLICY: "parent", PI_BUS_DIR: "/d", OTHER: "x" });
	});

	it("names a delegated instance by role and a plain one by host, both with a session tag", () => {
		const file = "/s/2026-01-01_0190aaaa-bbbb.jsonl";
		const plain = defaultName({}, file, "o", "box");
		const child = defaultName({ role: "Reviewer" }, file, "o", "box");
		expect(plain).toMatch(/^box-[0-9a-f]{6}$/);
		expect(child).toBe(plain.replace("box", "reviewer"));
		expect(defaultName({ name: "Fixed Name" }, file, "o")).toBe("fixed-name");
	});

	it("builds labels from the launch env and cwd", () => {
		expect(busLabels({ labels: "a=1,b=2", role: "r", parent: "p", team: "t" }, "/w")).toEqual({
			a: "1",
			b: "2",
			role: "r",
			parent: "p",
			team: "t",
			cwd: "/w",
		});
	});
});
