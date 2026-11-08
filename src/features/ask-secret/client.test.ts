import { statSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { ASKPASS_CLIENT } from "./index.ts";

describe("askpass client", () => {
	it("ships executable, because SUDO_ASKPASS runs it directly", () => {
		expect(statSync(ASKPASS_CLIENT).mode & 0o755).toBe(0o755);
	});
});
