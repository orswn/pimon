import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
	accountIdFromAccess,
	claudeLine,
	codexLine,
	createUsagePoller,
	formatUsagePart,
	usageCacheDir,
	usageCacheFile,
	type UsagePollerOptions,
} from "./usage.ts";

const TOKEN = "secret-token-value";
const POLL = 60_000;

function jwt(payload: object): string {
	return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
}

interface FetchCall {
	url: string;
	headers: Record<string, string>;
	signal: AbortSignal | undefined;
}

function harness(overrides: Partial<UsagePollerOptions> = {}) {
	const dir = overrides.dir ?? mkdtempSync(join(tmpdir(), "statusline-usage-"));
	const clock = { now: Date.now() };
	const calls: FetchCall[] = [];
	let respond: (call: FetchCall) => Promise<Response> = async () =>
		Response.json({ five_hour: { utilization: 42 }, seven_day: { utilization: 7 } });
	const fetchFn = (async (url: string, init?: RequestInit) => {
		const call = { url, headers: init?.headers as Record<string, string>, signal: init?.signal ?? undefined };
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
	let changes = 0;
	const make = (extra: Partial<UsagePollerOptions> = {}) =>
		createUsagePoller({
			dir,
			agentDir: "/agent/a",
			pollMs: POLL,
			fetch: fetchFn,
			now: () => clock.now,
			signal: new AbortController().signal,
			onChange: () => changes++,
			...overrides,
			...extra,
		});
	return {
		dir,
		clock,
		calls,
		make,
		file: (provider: string) => usageCacheFile(dir, provider, "/agent/a"),
		setRespond: (fn: typeof respond) => {
			respond = fn;
		},
		changes: () => changes,
	};
}

const token = async () => TOKEN;

describe("usage cache location", () => {
	it("lives under the runtime dir per user, with a per agent dir file", () => {
		const dir = usageCacheDir({ XDG_RUNTIME_DIR: "/run/user/7" }, 7);
		expect(dir).toBe("/run/user/7/pimon-7/statusline");
		expect(usageCacheDir({}, 7)).toBe("/tmp/pimon-7/statusline");
		expect(usageCacheDir({ XDG_RUNTIME_DIR: "" }, 7)).toBe("/tmp/pimon-7/statusline");
		const a = usageCacheFile(dir, "anthropic", "/agent/a");
		expect(a).toMatch(/\/usage-anthropic-[0-9a-f]{8}\.json$/);
		expect(usageCacheFile(dir, "anthropic", "/agent/b")).not.toBe(a);
	});
});

describe("usage poller", () => {
	it("makes one fetch per interval for two runtimes that share the cache dir", async () => {
		const h = harness();
		const a = h.make();
		const b = h.make();
		await a.check("anthropic", token);
		await b.check("anthropic", token);
		expect(h.calls).toHaveLength(1);
		expect(b.parts("anthropic").map((part) => part.text)).toEqual(["42%", "7%"]);
		h.clock.now += POLL;
		await a.check("anthropic", token);
		await b.check("anthropic", token);
		await a.check("anthropic", token);
		expect(h.calls).toHaveLength(2);
	});

	it("does not fetch while the file is fresh", async () => {
		const h = harness();
		writeFileSync(
			h.file("anthropic"),
			JSON.stringify({ version: 1, fetchedAt: h.clock.now - 1000, parts: [{ text: "9%", percent: 9 }] }),
		);
		const poller = h.make();
		await poller.check("anthropic", token);
		expect(h.calls).toHaveLength(0);
		expect(poller.parts("anthropic")).toEqual([{ text: "9%", percent: 9 }]);
	});

	it("checks the file again only after the in-memory gate", async () => {
		const h = harness();
		writeFileSync(h.file("anthropic"), JSON.stringify({ version: 1, fetchedAt: h.clock.now - 1000, parts: [] }));
		const poller = h.make();
		await poller.check("anthropic", token);
		h.clock.now += POLL - 1001;
		await poller.check("anthropic", token);
		expect(h.calls).toHaveLength(0);
		h.clock.now += 1;
		await poller.check("anthropic", token);
		expect(h.calls).toHaveLength(1);
	});

	it("defers to a live claim and checks again after 5 s", async () => {
		const h = harness();
		const poller = h.make();
		await poller.check("anthropic", token);
		expect(h.calls).toHaveLength(1);
		h.clock.now += POLL;
		const claim = `${h.file("anthropic")}.claim`;
		writeFileSync(claim, "");
		utimesSync(claim, h.clock.now / 1000, h.clock.now / 1000);
		await poller.check("anthropic", token);
		expect(h.calls).toHaveLength(1);
		rmSync(claim);
		h.clock.now += 4_999;
		await poller.check("anthropic", token);
		expect(h.calls).toHaveLength(1);
		h.clock.now += 1;
		await poller.check("anthropic", token);
		expect(h.calls).toHaveLength(2);
	});

	it("does not fetch when another process refreshed the file between the read and the claim", async () => {
		const h = harness();
		writeFileSync(h.file("anthropic"), JSON.stringify({ version: 1, fetchedAt: h.clock.now - POLL, parts: [] }));
		let reads = 0;
		// The second clock read comes after the stale file read and before the claim.
		const poller = h.make({
			now: () => {
				reads++;
				if (reads === 2) {
					writeFileSync(
						h.file("anthropic"),
						JSON.stringify({ version: 1, fetchedAt: h.clock.now, parts: [{ text: "5%", percent: 5 }] }),
					);
				}
				return h.clock.now;
			},
		});
		await poller.check("anthropic", token);
		expect(reads).toBeGreaterThanOrEqual(2);
		expect(h.calls).toHaveLength(0);
		expect(poller.parts("anthropic")).toEqual([{ text: "5%", percent: 5 }]);
		expect(existsSync(`${h.file("anthropic")}.claim`)).toBe(false);
	});

	it("keeps a claim that another process took over from a slow holder", async () => {
		const h = harness();
		const claim = `${h.file("anthropic")}.claim`;
		const gates: (() => void)[] = [];
		const started: (() => void)[] = [];
		const startedAt = [0, 1].map((index) => new Promise<void>((resolve) => (started[index] = resolve)));
		h.setRespond(
			() =>
				new Promise((resolve) => {
					gates.push(() => resolve(Response.json({ five_hour: { utilization: 1 } })));
					started[gates.length - 1]?.();
				}),
		);
		const slow = h.make().check("anthropic", token);
		await startedAt[0];
		h.clock.now += 31_000;
		const takeover = h.make().check("anthropic", token);
		await startedAt[1];
		const owner = readFileSync(claim, "utf8");
		gates[0]?.();
		await slow;
		expect(readFileSync(claim, "utf8")).toBe(owner);
		gates[1]?.();
		await takeover;
		expect(existsSync(claim)).toBe(false);
	});

	it("gives up on a token that does not come", async () => {
		const h = harness();
		const poller = h.make({ requestTimeoutMs: 50 });
		await poller.check("anthropic", () => new Promise(() => {}));
		expect(h.calls).toHaveLength(0);
		expect(existsSync(`${h.file("anthropic")}.claim`)).toBe(false);
		expect(JSON.parse(readFileSync(h.file("anthropic"), "utf8")).backoffUntil).toBe(h.clock.now + POLL);
	});

	it("treats a file from the future as stale", async () => {
		const h = harness();
		writeFileSync(
			h.file("anthropic"),
			JSON.stringify({ version: 1, fetchedAt: h.clock.now + 3_600_000, parts: [{ text: "9%", percent: 9 }] }),
		);
		const poller = h.make();
		await poller.check("anthropic", token);
		expect(h.calls).toHaveLength(1);
	});

	it("ignores a backoff more than one hour ahead", async () => {
		const h = harness();
		writeFileSync(
			h.file("anthropic"),
			JSON.stringify({ version: 1, fetchedAt: 0, parts: [], backoffUntil: h.clock.now + 3_600_001 }),
		);
		await h.make().check("anthropic", token);
		expect(h.calls).toHaveLength(1);
	});

	it("caps a long Retry-After at one hour", async () => {
		const h = harness();
		h.setRespond(async () => new Response("", { status: 429, headers: { "retry-after": "86400" } }));
		await h.make().check("anthropic", token);
		expect(JSON.parse(readFileSync(h.file("anthropic"), "utf8")).backoffUntil).toBe(h.clock.now + 3_600_000);
	});

	it("treats a claim from the future as stale", async () => {
		const h = harness();
		const claim = `${h.file("anthropic")}.claim`;
		writeFileSync(claim, "");
		const future = (h.clock.now + 600_000) / 1000;
		utimesSync(claim, future, future);
		await h.make().check("anthropic", token);
		expect(h.calls).toHaveLength(1);
	});

	it("refuses a symlinked cache dir", async () => {
		const root = mkdtempSync(join(tmpdir(), "statusline-link-"));
		const target = join(root, "target");
		mkdirSync(join(target, "statusline"), { recursive: true, mode: 0o700 });
		symlinkSync(target, join(root, "pimon-1"));
		const h = harness({ dir: join(root, "pimon-1", "statusline") });
		await h.make().check("anthropic", token);
		expect(h.calls).toHaveLength(0);
		expect(readdirSync(join(target, "statusline"))).toEqual([]);
	});

	it("takes over a claim older than 30 s and removes it after the fetch", async () => {
		const h = harness();
		const claim = `${h.file("anthropic")}.claim`;
		writeFileSync(claim, "");
		const old = (h.clock.now - 31_000) / 1000;
		utimesSync(claim, old, old);
		const poller = h.make();
		await poller.check("anthropic", token);
		expect(h.calls).toHaveLength(1);
		expect(existsSync(claim)).toBe(false);
	});

	it("writes a backoff on 429 and fetches nothing before it ends", async () => {
		const h = harness();
		const a = h.make();
		await a.check("anthropic", token);
		h.setRespond(async () => new Response("slow down", { status: 429, headers: { "retry-after": "600" } }));
		h.clock.now += POLL;
		const at429 = h.clock.now;
		await a.check("anthropic", token);
		expect(h.calls).toHaveLength(2);
		const saved = JSON.parse(readFileSync(h.file("anthropic"), "utf8"));
		expect(saved.backoffUntil).toBe(at429 + 600_000);
		expect(saved.parts.map((part: { text: string }) => part.text)).toEqual(["42%", "7%"]);
		expect(a.parts("anthropic")).toHaveLength(2);

		const b = h.make();
		h.clock.now = at429 + 599_999;
		await a.check("anthropic", token);
		await b.check("anthropic", token);
		expect(h.calls).toHaveLength(2);
		h.clock.now = at429 + 600_000;
		await b.check("anthropic", token);
		expect(h.calls).toHaveLength(3);
	});

	it("backs off at least 300 s on 429 without Retry-After", async () => {
		const h = harness();
		h.setRespond(async () => new Response("", { status: 429 }));
		await h.make().check("anthropic", token);
		expect(JSON.parse(readFileSync(h.file("anthropic"), "utf8")).backoffUntil).toBe(h.clock.now + 300_000);
	});

	it("keeps old parts after a failure, holds every process for one interval, and shows none after 15 min", async () => {
		const h = harness();
		const a = h.make();
		await a.check("anthropic", token);
		h.setRespond(async () => new Response("", { status: 500 }));
		h.clock.now += POLL;
		await a.check("anthropic", token);
		expect(h.calls).toHaveLength(2);
		expect(a.parts("anthropic")).toHaveLength(2);
		const saved = JSON.parse(readFileSync(h.file("anthropic"), "utf8"));
		expect(saved.backoffUntil).toBe(h.clock.now + POLL);

		const b = h.make();
		await b.check("anthropic", token);
		await a.check("anthropic", token);
		expect(h.calls).toHaveLength(2);
		for (let i = 0; i < 14; i++) {
			h.clock.now += POLL;
			await a.check("anthropic", token);
		}
		expect(a.parts("anthropic")).toHaveLength(2);
		h.clock.now += POLL;
		await a.check("anthropic", token);
		expect(a.parts("anthropic")).toEqual([]);
	});

	it("treats a missing token as a failure", async () => {
		const h = harness();
		await h.make().check("anthropic", async () => undefined);
		expect(h.calls).toHaveLength(0);
		expect(JSON.parse(readFileSync(h.file("anthropic"), "utf8")).backoffUntil).toBe(h.clock.now + POLL);
	});

	it("never writes the token to the cache dir", async () => {
		const h = harness();
		const poller = h.make();
		await poller.check("anthropic", token);
		h.setRespond(async () => new Response("", { status: 429 }));
		h.clock.now += POLL;
		await poller.check("anthropic", token);
		for (const name of readdirSync(h.dir)) {
			expect(readFileSync(join(h.dir, name), "utf8")).not.toContain(TOKEN);
		}
		expect(statSync(h.file("anthropic")).mode & 0o777).toBe(0o600);
	});

	it("creates the cache dir private to the user", async () => {
		const root = mkdtempSync(join(tmpdir(), "statusline-dir-"));
		const dir = join(root, "pimon-1", "statusline");
		const h = harness({ dir });
		await h.make().check("anthropic", token);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(root, "pimon-1")).mode & 0o777).toBe(0o700);
	});

	it("sends the bearer token, the codex account id, and a timeout signal", async () => {
		const h = harness();
		h.setRespond(async () => Response.json({ rate_limit: { primary_window: { used_percent: 12.4 } } }));
		const access = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" } });
		const poller = h.make();
		await poller.check("openai-codex", async () => access);
		expect(h.calls[0]?.url).toBe("https://chatgpt.com/backend-api/wham/usage");
		expect(h.calls[0]?.headers["Authorization"]).toBe(`Bearer ${access}`);
		expect(h.calls[0]?.headers["chatgpt-account-id"]).toBe("acct-9");
		expect(h.calls[0]?.signal).toBeInstanceOf(AbortSignal);
		expect(poller.parts("openai-codex")).toEqual([{ text: "12%", percent: 12 }]);
	});

	it("ignores providers without a usage endpoint", async () => {
		const h = harness();
		const poller = h.make();
		await poller.check("llm-proxy", token);
		await poller.check("claude-code", token);
		expect(h.calls).toHaveLength(0);
		expect(poller.parts("llm-proxy")).toEqual([]);
	});

	it("writes nothing and removes the claim when the runtime aborts the fetch", async () => {
		const controller = new AbortController();
		const h = harness({ signal: controller.signal });
		let started!: () => void;
		const fetchStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		h.setRespond(
			(call) =>
				new Promise((_resolve, reject) => {
					call.signal?.addEventListener("abort", () => reject(call.signal?.reason));
					started();
				}),
		);
		const pending = h.make().check("anthropic", token);
		await fetchStarted;
		expect(existsSync(`${h.file("anthropic")}.claim`)).toBe(true);
		controller.abort();
		await pending;
		expect(existsSync(`${h.file("anthropic")}.claim`)).toBe(false);
		expect(existsSync(h.file("anthropic"))).toBe(false);
	});

	it("starts no new check after the runtime aborts", async () => {
		const controller = new AbortController();
		const h = harness({ signal: controller.signal });
		controller.abort();
		await h.make().check("anthropic", token);
		expect(h.calls).toHaveLength(0);
	});
});

describe("usage parsers", () => {
	const now = Date.parse("2026-11-08T12:00:00Z");

	it("reads codex windows with reset times", () => {
		const data = {
			rate_limit: {
				primary_window: { used_percent: 55, reset_at: now / 1000 + 90 * 60 },
				secondary_window: { used_percent: 81 },
			},
		};
		const parts = codexLine(data);
		expect(parts).toEqual([
			{ text: "55%", percent: 55, resetsAt: now + 90 * 60_000 },
			{ text: "81%", percent: 81 },
		]);
		expect(parts.map((part) => formatUsagePart(part, now))).toEqual(["55%:1h30m", "81%"]);
	});

	it("reads claude windows with reset times", () => {
		const data = { five_hour: { utilization: 20, resets_at: "2026-11-08T12:30:00Z" }, seven_day: { utilization: 3 } };
		const parts = claudeLine(data);
		expect(parts).toEqual([
			{ text: "20%", percent: 20, resetsAt: now + 30 * 60_000 },
			{ text: "3%", percent: 3 },
		]);
		expect(parts.map((part) => formatUsagePart(part, now))).toEqual(["20%:30m", "3%"]);
	});

	it("counts the reset down at render time", () => {
		const part = { text: "55%", percent: 55, resetsAt: now + 90 * 60_000 };
		expect(formatUsagePart(part, now + 30 * 60_000)).toBe("55%:1h");
		expect(formatUsagePart(part, now + 89 * 60_000)).toBe("55%:1m");
	});

	it("shows a part from an older file as stored", () => {
		expect(formatUsagePart({ text: "9%:3h", percent: 9 }, now)).toBe("9%:3h");
	});

	it("reads the account id claim from the access token", () => {
		expect(accountIdFromAccess(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "a1" } }))).toBe("a1");
		expect(accountIdFromAccess("not-a-jwt")).toBeUndefined();
	});
});
