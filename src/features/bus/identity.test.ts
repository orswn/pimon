import { describe, expect, it } from "vite-plus/test";
import { busLabels, controlPolicyOf, defaultName, deleteIdentityEnv, readLaunchEnv, sessionTag } from "./identity.ts";

describe("bus identity", () => {
	it("reads launch values once and removes identity keys from the env", () => {
		const env: NodeJS.ProcessEnv = {
			PI_BUS_ROLE: "reviewer",
			PI_BUS_PARENT: "p",
			PI_BUS_OWNER: "o",
			PI_BUS_CONTROL_TOKEN: "t",
			PI_BUS_WAKE_POLICY: "parent",
			PI_BUS_DIR: "/d",
			PIMON_SPAWN_FILE: "/f",
			OTHER: "x",
		};
		const launch = readLaunchEnv(env);
		deleteIdentityEnv(env);
		expect(launch).toEqual({ role: "reviewer", parent: "p", wakePolicy: "parent" });
		expect(env).toEqual({ PI_BUS_WAKE_POLICY: "parent", OTHER: "x" });
	});

	it("names by env, then session name, then role or host with a tag of the session id", () => {
		const id = "0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
		const plain = defaultName({}, id, "box");
		expect(plain).toBe(`box-${sessionTag(id)}`);
		expect(defaultName({ role: "Reviewer" }, id, "box")).toBe(plain.replace("box", "reviewer"));
		expect(defaultName({ sessionName: "My Work", role: "r" }, id, "box")).toBe("my-work");
		expect(defaultName({ name: "Fixed Name", sessionName: "s" }, id)).toBe("fixed-name");
	});

	it("builds labels from the launch env; role and parent are separate hub fields", () => {
		expect(busLabels({ labels: "a=1,b=2", role: "r", parent: "p", team: "t" })).toEqual({ a: "1", b: "2", team: "t" });
	});

	it("reads control any as parent, because the hub forwards a close only from the parent", () => {
		expect(controlPolicyOf({ control: "any" })).toBe("parent");
		expect(controlPolicyOf({ control: "none" })).toBe("none");
		expect(controlPolicyOf({})).toBe("parent");
	});
});
