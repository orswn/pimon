import { createSandbox, scrubEnv } from "./sandbox.ts";

// Workers inherit this environment, so no test reaches the human's desktop, phone, terminal multiplexer, or pi.
export default function setup(): () => void {
	const sandbox = createSandbox();
	scrubEnv(process.env);
	Object.assign(process.env, sandbox.env);
	// An interrupted run exits without calling the teardown. Its hub processes would outlive it.
	const onExit = () => sandbox.dispose();
	process.once("exit", onExit);
	return () => {
		process.off("exit", onExit);
		sandbox.dispose();
	};
}
