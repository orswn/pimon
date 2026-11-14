import { describe, expect, it } from "vite-plus/test";
import { senderText, shortId } from "./protocol.ts";

const A = "0190aaaa-1111-7111-8111-111111111111";

describe("bus protocol", () => {
	it("shortens ids to 12 hex", () => {
		expect(shortId(A)).toBe("0190aaaa1111");
	});

	it("names an agent sender by id and a principal by name only", () => {
		expect(senderText({ id: A, name: "bob" })).toBe("bob id:0190aaaa1111");
		expect(senderText({ name: "hermes" })).toBe("hermes");
	});
});
