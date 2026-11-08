// Two channels, because a desktop toast is invisible once the human leaves the room and a phone
// ping is invisible when the phone is not paired. A total failure is reported to the caller.
import type { ExecFn, ExecResult } from "../../core/exec.ts";

export type NotifyKind = "info" | "blocked" | "paused" | "done" | "unverified";

export interface NotifyRequest {
	kind: NotifyKind;
	message: string;
	detail?: string | undefined;
	title?: string | undefined;
	signal?: AbortSignal | undefined;
}

export interface NotifyOutcome {
	ok: boolean;
	delivered: string[];
	failed: string[];
	suppressed?: "duplicate" | "rate-limit";
}

export interface NotifyService {
	notify(request: NotifyRequest): Promise<NotifyOutcome>;
}

export interface NotifierOptions {
	exec: ExecFn;
	now?: () => number;
	dedupeMs?: number;
	maxPerMinute?: number;
	cooldownMs?: number;
	timeoutMs?: number;
}

const URGENT: readonly NotifyKind[] = ["blocked", "paused", "unverified"];

export function defaultTitle(kind: NotifyKind): string {
	switch (kind) {
		case "blocked":
			return "pi: blocked, needs you";
		case "paused":
			return "pi: paused";
		case "unverified":
			return "pi: stopped, unverified";
		case "done":
			return "pi: done";
		default:
			return "pi";
	}
}

interface Channel {
	delivered: string[];
	failed: string[];
}

export function createNotifier(options: NotifierOptions): NotifyService {
	const now = options.now ?? (() => Date.now());
	const dedupeMs = options.dedupeMs ?? 60_000;
	const maxPerMinute = options.maxPerMinute ?? 6;
	const cooldownMs = options.cooldownMs ?? 60_000;
	const timeoutMs = options.timeoutMs ?? 10_000;

	const lastSent = new Map<string, number>();
	let windowStart = now();
	let windowCount = 0;
	let mutedUntil = 0;

	const run = async (command: string, args: string[], signal: AbortSignal | undefined): Promise<ExecResult> => {
		try {
			return await options.exec(command, args, { timeoutMs, signal });
		} catch (error) {
			return { code: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error), failed: "spawn" };
		}
	};

	const outcomeLabel = (result: ExecResult) =>
		result.failed && result.code === -1 && result.stderr ? result.stderr.split("\n")[0] : String(result.code);

	async function desktop(urgency: string, heading: string, body: string, signal?: AbortSignal): Promise<Channel> {
		const result = await run(
			"notify-send",
			["-a", "pi", "-u", urgency, "-i", "dialog-information", heading, body],
			signal,
		);
		if (result.code === 0 && !result.failed) return { delivered: ["desktop"], failed: [] };
		return { delivered: [], failed: [`desktop(${outcomeLabel(result)})`] };
	}

	// A failed listing is not the same as having no devices. The failure report must tell them apart.
	async function phones(text: string, signal?: AbortSignal): Promise<Channel> {
		const listing = await run("kdeconnect-cli", ["-a", "--id-only"], signal);
		if (listing.failed) return { delivered: [], failed: [`device-listing-${listing.failed}`] };
		if (listing.code !== 0) {
			const why = listing.stderr ? `: ${listing.stderr.trim().split("\n")[0]}` : "";
			return { delivered: [], failed: [`device-listing-exit-${listing.code}${why}`] };
		}
		// An id is one token on its own line. Prose lines such as "2 devices found" contain spaces.
		const ids = listing.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length >= 4 && !/\s/.test(line));
		if (ids.length === 0) return { delivered: [], failed: ["no-reachable-device"] };
		const pings = await Promise.all(
			ids.map(async (id) => ({
				id: id.slice(0, 8),
				result: await run("kdeconnect-cli", ["-d", id, "--ping-msg", text], signal),
			})),
		);
		const channel: Channel = { delivered: [], failed: [] };
		for (const { id, result } of pings) {
			if (result.code === 0 && !result.failed) channel.delivered.push(id);
			else channel.failed.push(`${id}(${outcomeLabel(result)})`);
		}
		return channel;
	}

	async function notify(request: NotifyRequest): Promise<NotifyOutcome> {
		const stamp = now();
		const key = `${request.kind}|${request.message}|${request.detail ?? ""}`;
		for (const [sentKey, sentAt] of lastSent) if (stamp - sentAt >= dedupeMs) lastSent.delete(sentKey);
		const previous = lastSent.get(key);
		// Only a delivered notification suppresses a repeat. A failure must stay retryable.
		if (previous !== undefined && stamp - previous < dedupeMs)
			return { ok: false, delivered: [], failed: [], suppressed: "duplicate" };
		// An urgent kind means the human must act, so it counts against the window but is never muted.
		const urgent = URGENT.includes(request.kind);
		if (!urgent && stamp < mutedUntil) return { ok: false, delivered: [], failed: [], suppressed: "rate-limit" };
		if (stamp - windowStart >= 60_000) {
			windowStart = stamp;
			windowCount = 0;
		}
		windowCount++;
		if (windowCount > maxPerMinute) {
			mutedUntil = Math.max(mutedUntil, stamp + cooldownMs);
			if (!urgent) return { ok: false, delivered: [], failed: [], suppressed: "rate-limit" };
		}

		const heading = request.title ?? defaultTitle(request.kind);
		const body = request.detail ? `${request.message}\n${request.detail}` : request.message;
		const urgency = urgent ? "critical" : "normal";
		const settled = await Promise.allSettled([
			desktop(urgency, heading, body, request.signal),
			phones(`${heading}: ${body}`, request.signal),
		]);
		const delivered: string[] = [];
		const failed: string[] = [];
		for (const [index, item] of settled.entries()) {
			if (item.status === "fulfilled") {
				delivered.push(...item.value.delivered);
				failed.push(...item.value.failed);
			} else {
				failed.push(`${index === 0 ? "desktop" : "phone"}(${String(item.reason)})`);
			}
		}
		const ok = delivered.length > 0;
		if (ok) lastSent.set(key, stamp);
		return { ok, delivered, failed };
	}

	return { notify };
}

export function formatOutcome(outcome: NotifyOutcome): string {
	if (outcome.suppressed === "duplicate") return "Not sent: the same notification went out moments ago.";
	if (outcome.suppressed === "rate-limit") return "Not sent: too many notifications, muted for a minute.";
	if (outcome.ok)
		return `Notified via ${outcome.delivered.join(", ")}${outcome.failed.length ? ` (failed: ${outcome.failed.join(", ")})` : ""}.`;
	return `Notification was NOT delivered anywhere: ${outcome.failed.join(", ")}. Assume the user has not seen it.`;
}
