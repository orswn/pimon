import { describe, expect, it } from "vite-plus/test";
import { HUB_ROUTES, matchRoute, type RouteKey } from "./routes.ts";

describe("hub route manifest", () => {
	it("matches each route with sample path parameters", () => {
		for (const key of Object.keys(HUB_ROUTES) as RouteKey[]) {
			const [method = "", path = ""] = key.split(" ");
			const segments = path
				.split("/")
				.filter(Boolean)
				.map((part) => (part.startsWith(":") ? `x-${part.slice(1)}` : part));
			expect(matchRoute(method, segments), key).toBe(key);
		}
	});

	it("gives no route for another method, length, or literal", () => {
		expect(matchRoute("POST", ["healthz"])).toBeUndefined();
		expect(matchRoute("GET", ["agents", "a", "b"])).toBeUndefined();
		expect(matchRoute("GET", ["link", "a", "nothing"])).toBeUndefined();
		expect(matchRoute("GET", ["link", "register"])).toBeUndefined();
		expect(matchRoute("DELETE", ["link", "register"])).toBe("DELETE /link/:agent");
	});
});
