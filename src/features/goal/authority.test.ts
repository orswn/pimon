import { describe, expect, it } from "vite-plus/test";
import { type Authority, closeAuthority, onInput, onUserMessage, openAuthority } from "./authority.ts";

const land = (authority: Authority, text: string) => onUserMessage(authority, text);

describe("authority window", () => {
	it("opens when an idle interactive or rpc message lands", () => {
		for (const source of ["interactive", "rpc"]) {
			const queued = onInput(openAuthority(), source, undefined);
			expect(queued.window).toBeUndefined();
			expect(land(queued, "keep going").window).toBe("keep going");
		}
	});

	it("does not open for a message sent by an extension", () => {
		expect(land(onInput(openAuthority(), "extension", undefined), "task").window).toBeUndefined();
	});

	it("opens a steer when it lands, not when it is typed", () => {
		const typed = onInput(openAuthority(), "interactive", "steer");
		expect(typed.window).toBeUndefined();
		expect(land(typed, "skip the deploy").window).toBe("skip the deploy");
	});

	it("keeps the order of a human steer and an extension follow-up", () => {
		let state = onInput(openAuthority(), "interactive", "steer");
		state = onInput(state, "extension", "followUp");
		state = land(state, "human words");
		expect(state.window).toBe("human words");
		state = closeAuthority();
		state = onInput(onInput(openAuthority(), "extension", "followUp"), "interactive", "followUp");
		state = land(state, "from an extension");
		expect(state.window).toBeUndefined();
		expect(land(state, "from the human").window).toBe("from the human");
	});

	it("an idle input drops a stale flag from an earlier input", () => {
		const stale = onInput(openAuthority(), "interactive", "steer");
		const idle = onInput(stale, "extension", undefined);
		expect(land(idle, "extension task").window).toBeUndefined();
	});

	it("a user message without an input keeps the current window", () => {
		const open = land(onInput(openAuthority(), "interactive", undefined), "keep going");
		expect(land(open, "sent by an extension").window).toBe("keep going");
	});

	it("keeps a human message without text as a visible placeholder", () => {
		expect(land(onInput(openAuthority(), "interactive", undefined), "  ").window).toBe("(no text)");
	});

	it("closes with an empty queue", () => {
		expect(closeAuthority()).toEqual({ queue: [], window: undefined });
	});
});
