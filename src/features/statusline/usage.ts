import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface UsagePart {
	text: string;
	percent: number;
	/** Epoch ms of the window reset. Files from before this field carry the countdown in `text`. */
	resetsAt?: number;
}

const STALE_AFTER_MS = 15 * 60_000;
const CLAIM_STALE_MS = 30_000;
const CLAIM_RETRY_MS = 5_000;
const MIN_429_BACKOFF_MS = 300_000;
// A backoff further ahead than this comes from a clock jump or a bad file.
const MAX_BACKOFF_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 10_000;
const FILE_VERSION = 1;

interface UsageSource {
	url: string;
	headers(token: string): Record<string, string>;
	parse(data: unknown): UsagePart[];
}

const SOURCES: Record<string, UsageSource> = {
	"openai-codex": {
		url: "https://chatgpt.com/backend-api/wham/usage",
		headers: (token) => ({
			Authorization: `Bearer ${token}`,
			"chatgpt-account-id": accountIdFromAccess(token) ?? "",
			originator: "pi",
		}),
		parse: codexLine,
	},
	anthropic: {
		url: "https://api.anthropic.com/api/oauth/usage",
		headers: (token) => ({
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "oauth-2025-04-20",
			"User-Agent": "pi-statusline",
		}),
		parse: claudeLine,
	},
};

export function hasUsageSource(provider: string | undefined): provider is string {
	return provider !== undefined && Object.hasOwn(SOURCES, provider);
}

export function usageCacheDir(env: NodeJS.ProcessEnv, uid: number | undefined): string {
	return join(env["XDG_RUNTIME_DIR"] || "/tmp", `pimon-${uid ?? "user"}`, "statusline");
}

export function usageCacheFile(dir: string, provider: string, agentDir: string): string {
	const account = createHash("sha256").update(agentDir).digest("hex").slice(0, 8);
	return join(dir, `usage-${provider}-${account}.json`);
}

/** mkdir's mode does not narrow an existing directory, and a shared /tmp fallback may hold another user's. */
function preparePrivateDir(dir: string): void {
	const self = process.getuid?.();
	for (const path of [dirname(dir), dir]) {
		try {
			mkdirSync(path, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const stat = lstatSync(path);
		if (!stat.isDirectory()) throw new Error(`${path} is not a directory`);
		if (self !== undefined && stat.uid !== self)
			throw new Error(`${path} is owned by uid ${stat.uid}, not by this user`);
		chmodSync(path, 0o700);
	}
}

interface CacheFile {
	version: number;
	fetchedAt: number;
	parts: UsagePart[];
	backoffUntil?: number;
}

async function readCache(path: string): Promise<CacheFile | undefined> {
	try {
		const data = JSON.parse(await readFile(path, "utf8")) as Partial<CacheFile>;
		if (data.version !== FILE_VERSION || typeof data.fetchedAt !== "number" || !Array.isArray(data.parts))
			return undefined;
		return {
			version: FILE_VERSION,
			fetchedAt: data.fetchedAt,
			parts: data.parts,
			...(typeof data.backoffUntil === "number" ? { backoffUntil: data.backoffUntil } : {}),
		};
	} catch {
		return undefined;
	}
}

async function writeCache(path: string, data: CacheFile): Promise<void> {
	const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/** Returns the owner token written into the new file, or undefined when the file exists. */
function createExclusive(path: string): string | undefined {
	let fd: number;
	try {
		fd = openSync(path, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
		throw error;
	}
	const owner = randomBytes(8).toString("hex");
	try {
		writeSync(fd, owner);
	} finally {
		closeSync(fd);
	}
	return owner;
}

/** One fetch per host and interval: the winner of an exclusive create fetches, the others read its file. */
function claim(path: string, now: number): string | undefined {
	const owner = createExclusive(path);
	if (owner) return owner;
	let age: number;
	try {
		age = now - statSync(path).mtimeMs;
	} catch {
		age = Number.POSITIVE_INFINITY;
	}
	// A claim from the future comes from a clock jump. Waiting for it would stall polling for the jump.
	if (age >= 0 && age < CLAIM_STALE_MS) return undefined;
	rmSync(path, { force: true });
	return createExclusive(path);
}

/** A holder slower than the stale limit must not remove the claim of the process that took it over. */
function releaseClaim(path: string, owner: string): void {
	try {
		if (readFileSync(path, "utf8") === owner) rmSync(path, { force: true });
	} catch {
		// Already gone.
	}
}

/** Deadlines that make a fresh check unnecessary. Values from a clock jump do not count. */
function holdUntil(file: CacheFile | undefined, now: number, pollMs: number): number | undefined {
	if (!file) return undefined;
	const deadlines: number[] = [];
	if (file.fetchedAt <= now && now - file.fetchedAt < pollMs) deadlines.push(file.fetchedAt + pollMs);
	const backoff = file.backoffUntil;
	if (backoff !== undefined && now < backoff && backoff <= now + MAX_BACKOFF_MS) deadlines.push(backoff);
	return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		if (signal.aborted) return onAbort();
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

function retryAfterMs(header: string | null, now: number): number {
	if (!header) return 0;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return seconds * 1000;
	const date = Date.parse(header);
	return Number.isFinite(date) ? date - now : 0;
}

export interface UsagePollerOptions {
	dir: string;
	agentDir: string;
	pollMs: number;
	fetch: typeof fetch;
	now: () => number;
	/** Aborted at session shutdown. */
	signal: AbortSignal;
	onChange: () => void;
	/** Limit for the token and for the request, each. Tests shorten it. */
	requestTimeoutMs?: number;
}

export interface UsagePoller {
	/** Last good reading, or none when it is older than 15 min. */
	parts(provider: string): UsagePart[];
	/** Reads the shared file, and fetches when this process wins the claim. Returns at once while the gate is closed. */
	check(provider: string, loadToken: () => Promise<string | undefined>): Promise<void>;
}

interface ProviderState {
	parts: UsagePart[];
	fetchedAt: number;
	nextCheckAt: number;
	busy: boolean;
}

export function createUsagePoller(options: UsagePollerOptions): UsagePoller {
	const states = new Map<string, ProviderState>();
	const stateOf = (provider: string) => {
		let state = states.get(provider);
		if (!state) {
			state = { parts: [], fetchedAt: 0, nextCheckAt: 0, busy: false };
			states.set(provider, state);
		}
		return state;
	};

	const timed = () =>
		AbortSignal.any([options.signal, AbortSignal.timeout(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS)]);

	const refresh = async (
		provider: string,
		source: UsageSource,
		state: ProviderState,
		loadToken: () => Promise<string | undefined>,
	) => {
		// Yield first: render() starts this check, and the dir checks below are sync.
		await Promise.resolve();
		preparePrivateDir(options.dir);
		const path = usageCacheFile(options.dir, provider, options.agentDir);
		const adopt = (file: CacheFile | undefined) => {
			if (!file) return;
			state.parts = file.parts;
			state.fetchedAt = file.fetchedAt;
		};
		let file = await readCache(path);
		adopt(file);
		const now = options.now();
		const held = holdUntil(file, now, options.pollMs);
		if (held !== undefined) {
			state.nextCheckAt = held;
			return;
		}
		const claimPath = `${path}.claim`;
		const owner = claim(claimPath, now);
		if (!owner) {
			state.nextCheckAt = now + CLAIM_RETRY_MS;
			return;
		}
		try {
			// Another process may have written the file between the read above and the claim.
			file = await readCache(path);
			adopt(file);
			const heldNow = holdUntil(file, options.now(), options.pollMs);
			if (heldNow !== undefined) {
				state.nextCheckAt = heldNow;
				return;
			}
			const kept = { version: FILE_VERSION, fetchedAt: file?.fetchedAt ?? 0, parts: file?.parts ?? [] };
			try {
				const token = await withSignal(loadToken(), timed());
				if (!token) throw new Error(`no ${provider} token`);
				const response = await options.fetch(source.url, {
					headers: source.headers(token),
					signal: timed(),
				});
				if (response.status === 429) {
					const at = options.now();
					const wait = retryAfterMs(response.headers.get("retry-after"), at);
					const backoffUntil = at + Math.min(Math.max(wait, MIN_429_BACKOFF_MS), MAX_BACKOFF_MS);
					await writeCache(path, { ...kept, backoffUntil });
					state.nextCheckAt = backoffUntil;
					return;
				}
				if (!response.ok) throw new Error(`usage request failed with ${response.status}`);
				const parts = source.parse(await response.json());
				const at = options.now();
				await writeCache(path, { version: FILE_VERSION, fetchedAt: at, parts });
				state.parts = parts;
				state.fetchedAt = at;
				state.nextCheckAt = at + options.pollMs;
			} catch {
				if (options.signal.aborted) return;
				// A failure holds every process for one interval, so an outage costs one request per interval per host.
				const backoffUntil = options.now() + options.pollMs;
				state.nextCheckAt = backoffUntil;
				await writeCache(path, { ...kept, backoffUntil }).catch(() => undefined);
			}
		} finally {
			releaseClaim(claimPath, owner);
		}
	};

	return {
		parts(provider) {
			const state = states.get(provider);
			if (!state || options.now() - state.fetchedAt > STALE_AFTER_MS) return [];
			return state.parts;
		},
		async check(provider, loadToken) {
			const source = SOURCES[provider];
			if (!source || options.signal.aborted) return;
			const state = stateOf(provider);
			if (state.busy || options.now() < state.nextCheckAt) return;
			state.busy = true;
			try {
				await refresh(provider, source, state, loadToken);
			} catch {
				// The cache dir is unusable. Wait one interval before the next try.
				state.nextCheckAt = options.now() + options.pollMs;
			} finally {
				state.busy = false;
				if (!options.signal.aborted) options.onChange();
			}
		},
	};
}

interface WindowUsage {
	usedPercent?: number | undefined;
	resetsAt?: number | string | undefined;
}

function numberAt(obj: unknown, paths: string[][]): number | undefined {
	for (const path of paths) {
		let current: unknown = obj;
		for (const key of path) current = (current as Record<string, unknown> | undefined)?.[key];
		if (typeof current === "number" && Number.isFinite(current)) return current;
	}
	return undefined;
}

function normalizeWindow(obj: unknown, names: string[]): WindowUsage {
	const used = numberAt(
		obj,
		names.flatMap((name) => [
			[name, "used_percent"],
			[name, "usedPercent"],
			[name, "used_percentage"],
			["rate_limit", name, "used_percent"],
			["rate_limit", name, "usedPercent"],
			["rateLimits", name, "usedPercent"],
			["rateLimits", name, "used_percent"],
		]),
	);
	const left = numberAt(
		obj,
		names.flatMap((name) => [
			[name, "leftPercent"],
			[name, "left_percent"],
			["rate_limit", name, "leftPercent"],
			["rate_limit", name, "left_percent"],
			["rateLimits", name, "leftPercent"],
		]),
	);
	const reset = numberAt(
		obj,
		names.flatMap((name) => [
			[name, "reset_at"],
			[name, "resets_at"],
			[name, "resetsAt"],
			["rate_limit", name, "reset_at"],
			["rate_limit", name, "resets_at"],
			["rate_limit", name, "resetsAt"],
			["rateLimits", name, "resetsAt"],
			["rateLimits", name, "reset_at"],
		]),
	);
	return {
		usedPercent: used ?? (left === undefined ? undefined : Math.max(0, Math.min(100, 100 - left))),
		resetsAt: reset,
	};
}

/** Epoch ms of a reset given as epoch seconds or as a date string. */
function resetTime(value: number | string | undefined): number | undefined {
	if (value === undefined || (typeof value === "number" && value <= 0)) return undefined;
	const timestamp = typeof value === "number" ? value * 1000 : Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function durationUntil(timestamp: number, now: number): string {
	const minutes = Math.ceil(Math.max(0, timestamp - now) / 60_000);
	if (minutes < 60) return `${minutes}m`;
	if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
	return `${Math.floor(minutes / 1440)}d${Math.floor((minutes % 1440) / 60)}h`;
}

/** The countdown is formatted at render, so a reading shared for an interval does not show a frozen reset. */
export function formatUsagePart(part: UsagePart, now: number): string {
	return typeof part.resetsAt === "number" ? `${part.text}:${durationUntil(part.resetsAt, now)}` : part.text;
}

function partsForWindows(windows: WindowUsage[]): UsagePart[] {
	const parts: UsagePart[] = [];
	for (const window of windows) {
		if (window.usedPercent === undefined) continue;
		const percent = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
		const resetsAt = resetTime(window.resetsAt);
		parts.push({ text: `${percent}%`, percent, ...(resetsAt === undefined ? {} : { resetsAt }) });
	}
	return parts;
}

export function codexLine(data: unknown): UsagePart[] {
	return partsForWindows([
		normalizeWindow(data, ["primary", "primary_window", "five_hour", "fiveHour", "five_hour_limit"]),
		normalizeWindow(data, ["secondary", "secondary_window", "seven_day", "sevenDay", "weekly", "weekly_limit"]),
	]);
}

export function claudeLine(data: unknown): UsagePart[] {
	const value = data as
		| {
				five_hour?: { utilization?: unknown; resets_at?: unknown };
				seven_day?: { utilization?: unknown; resets_at?: unknown };
		  }
		| undefined;
	const window = (raw: { utilization?: unknown; resets_at?: unknown } | undefined): WindowUsage => ({
		usedPercent: typeof raw?.utilization === "number" ? raw.utilization : undefined,
		resetsAt: typeof raw?.resets_at === "string" ? raw.resets_at : undefined,
	});
	return partsForWindows([window(value?.five_hour), window(value?.seven_day)]);
}

function decodeJwt(token: string): Record<string, unknown> | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export function accountIdFromAccess(access: string): string | undefined {
	const auth = decodeJwt(access)?.["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
	return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}
