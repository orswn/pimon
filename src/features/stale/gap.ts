export interface ClockMark {
	wall: number;
	mono: bigint;
	/** Seconds since boot, suspend included. */
	uptime: number;
}

export interface Clock {
	now(): ClockMark;
	/** Minutes east of UTC for the given wall time. */
	offsetMinutes(wall: number): number;
	/** Kernel boot id where the host has one. */
	bootId(): string | undefined;
}

export interface BootStamp {
	bootTime: number;
	bootId?: string;
}

export type HostFact = { kind: "host-restart" } | { kind: "suspend"; ms: number };
export type PiFact = "restart" | "reload";

export interface Gap {
	gapMs: number;
	/** The gap reached the idle threshold. */
	idle: boolean;
	now: number;
	offsetMinutes: number;
	host?: HostFact;
	pi?: PiFact;
}

export interface GapInput {
	now: ClockMark;
	offsetMinutes: number;
	/** Wall time of the last activity in the session, if any. */
	lastActivity: number | undefined;
	/** Clock sample of this process at its last activity or session start. */
	mark: ClockMark | undefined;
	idleMs: number;
	hostRestarted: boolean;
	pi: PiFact | undefined;
}

export const SUSPEND_MIN_MS = 60_000;
export const BOOT_TOLERANCE_S = 5;

export const bootTimeOf = (mark: ClockMark): number => Math.round((mark.wall - mark.uptime * 1000) / 1000);

export const bootChanged = (saved: number | undefined, current: number): boolean =>
	saved !== undefined && Math.abs(current - saved) > BOOT_TOLERANCE_S;

/** A boot id on both sides wins, because a wall clock step moves the boot time. */
export function hostRebooted(saved: BootStamp | undefined, current: BootStamp): boolean {
	if (!saved) return false;
	if (saved.bootId !== undefined && current.bootId !== undefined) return saved.bootId !== current.bootId;
	return bootChanged(saved.bootTime, current.bootTime);
}

export const bootNeedsSave = (saved: BootStamp | undefined, current: BootStamp): boolean =>
	!saved || hostRebooted(saved, current) || (saved.bootId === undefined && current.bootId !== undefined);

export function suspendedMs(mark: ClockMark, now: ClockMark): number {
	const uptimeMs = (now.uptime - mark.uptime) * 1000;
	const monoMs = Number(now.mono - mark.mono) / 1e6;
	return Math.max(0, Math.round(uptimeMs - monoMs));
}

export function detectGap(input: GapInput): Gap | undefined {
	const reference = input.lastActivity ?? input.mark?.wall;
	const gapMs = reference === undefined ? 0 : Math.max(0, input.now.wall - reference);
	const idle = input.lastActivity !== undefined && gapMs >= input.idleMs;
	let host: HostFact | undefined;
	if (input.hostRestarted) host = { kind: "host-restart" };
	else if (input.mark) {
		const ms = suspendedMs(input.mark, input.now);
		if (ms >= SUSPEND_MIN_MS) host = { kind: "suspend", ms };
	}
	const pi = input.hostRestarted ? "restart" : input.pi;
	if (!idle && !host && !pi) return undefined;
	return {
		gapMs,
		idle,
		now: input.now.wall,
		offsetMinutes: input.offsetMinutes,
		...(host ? { host } : {}),
		...(pi ? { pi } : {}),
	};
}

export function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
	const days = Math.floor(hours / 24);
	return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

export function formatOffset(offsetMinutes: number): string {
	const sign = offsetMinutes < 0 ? "-" : "+";
	const abs = Math.abs(offsetMinutes);
	const hours = String(Math.floor(abs / 60)).padStart(2, "0");
	const minutes = abs % 60;
	return minutes === 0 ? `${sign}${hours}` : `${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

export function formatNow(wall: number, offsetMinutes: number): string {
	const local = new Date(wall + offsetMinutes * 60_000).toISOString();
	return `${local.slice(0, 10)} ${local.slice(11, 16)} ${formatOffset(offsetMinutes)}`;
}

function hostText(host: HostFact): string {
	return host.kind === "host-restart" ? "the host restarted" : `the host was suspended for ${formatDuration(host.ms)}`;
}

const PI_TEXT: Record<PiFact, string> = { restart: "pi restarted", reload: "pi reloaded its extensions" };

export function gapText(gap: Gap): string {
	const facts = [gap.host ? hostText(gap.host) : undefined, gap.pi ? PI_TEXT[gap.pi] : undefined].filter(
		(fact) => fact !== undefined,
	);
	const lines = [
		"<session-gap>",
		`Last activity: ${formatDuration(gap.gapMs)} ago. Now: ${formatNow(gap.now, gap.offsetMinutes)}.`,
	];
	if (facts.length > 0) lines.push(`Since then: ${facts.join(". ")}.`);
	if (gap.pi === "restart")
		lines.push("Lost with the old pi process: background jobs, monitors, timers, bus endpoints.");
	// A reload alone keeps jobs, timers, and the session, so nothing needs a check.
	const reloadOnly = gap.pi === "reload" && !gap.host && !gap.idle;
	if (!reloadOnly) lines.push("Check facts from before the gap before you act on them.");
	lines.push("</session-gap>");
	return lines.join("\n");
}

const PI_SUMMARY: Record<PiFact, string> = { restart: "pi restarted", reload: "pi reloaded" };

export function gapSummary(gap: Gap): string {
	const parts = [`session gap: ${formatDuration(gap.gapMs)}`];
	if (gap.host)
		parts.push(gap.host.kind === "host-restart" ? "host restarted" : `suspended ${formatDuration(gap.host.ms)}`);
	if (gap.pi) parts.push(PI_SUMMARY[gap.pi]);
	return parts.join(" · ");
}
