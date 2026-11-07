import { scrubEnv } from "./sandbox.ts";

if (!process.env["PIMON_TEST_SANDBOX"]) {
	throw new Error("tests must run through the vite.config.ts test projects, which set up the sandbox");
}
scrubEnv(process.env);
