// Timers live in reload state. A fire callback holds only the store and an id, so it never
// reaches a context of a replaced runtime. The current runtime binds `wake`, `notice`, `changed`, and `sessionId`.
import { formatDuration } from "./digest.ts";

export const TIMER_LIMITS = {
	maxPerSession: 20,
	maxDelaySeconds: 604_800,
	maxNameChars: 64,
	maxReasonChars: 500,
} as const;

const TIMER_LIFETIME_NOTE = "Timers end with the pi process.";

export interface TimerInfo {
	id: number;
	name: string;
	sessionId: string;
	reason: string;
	createdAt: number;
	dueAt: number;
}

interface ArmedTimer extends TimerInfo {
	handle: ReturnType<typeof setTimeout>;
}

export interface TimerFilter {
	sessionId: string;
	/** Only timers created at or after this epoch ms. */
	createdSince?: number | undefined;
}

export interface TimerWake {
	customType: "timer";
	content: string;
	display: true;
	details: { name: string; reason: string; createdAt: number; dueAt: number };
}

export interface TimerStore {
	armed: Map<number, ArmedTimer>;
	seq: number;
	/** Per session counter for default names. */
	counters: Map<string, number>;
	/** Fired while no runtime was bound. Delivered at the next bind. */
	queue: TimerInfo[];
	sessionId: string | undefined;
	wake: ((message: TimerWake) => void) | undefined;
	notice: ((text: string) => void) | undefined;
	/** Called after the timers of a session changed: set, replace, cancel, fire, or quit. */
	changed: ((sessionId: string) => void) | undefined;
}

export interface TimerResult {
	ok: boolean;
	text: string;
}

export function createTimerStore(): TimerStore {
	return {
		armed: new Map(),
		seq: 0,
		counters: new Map(),
		queue: [],
		sessionId: undefined,
		wake: undefined,
		notice: undefined,
		changed: undefined,
	};
}

const fail = (text: string): TimerResult => ({ ok: false, text });
const done = (text: string): TimerResult => ({ ok: true, text });

export function clockTime(epochMs: number): string {
	return new Date(epochMs).toTimeString().slice(0, 8);
}

function firedText(timer: TimerInfo, now: number): string {
	return `Timer "${timer.name}" fired (set ${formatDuration(now - timer.createdAt)} ago). Reason: ${timer.reason}`;
}

export function armedTimers(store: TimerStore, sessionId: string): TimerInfo[] {
	return [...store.armed.values()]
		.filter((timer) => timer.sessionId === sessionId)
		.map(info)
		.sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
}

/** Fired timers of a session that wait for the next runtime bind. */
export function pendingTimers(store: TimerStore, sessionId: string): TimerInfo[] {
	return store.queue.filter((timer) => timer.sessionId === sessionId);
}

function info(timer: ArmedTimer): TimerInfo {
	const { handle: _handle, ...rest } = timer;
	return rest;
}

function findByName(store: TimerStore, sessionId: string, name: string): ArmedTimer | undefined {
	for (const timer of store.armed.values()) if (timer.sessionId === sessionId && timer.name === name) return timer;
	return undefined;
}

function matches(timer: TimerInfo, filter: TimerFilter): boolean {
	return (
		timer.sessionId === filter.sessionId &&
		(filter.createdSince === undefined || timer.createdAt >= filter.createdSince)
	);
}

interface SetParams {
	name?: unknown;
	delaySeconds?: unknown;
	reason?: unknown;
}

export function setTimer(store: TimerStore, sessionId: string, params: SetParams, now: number): TimerResult {
	const delay = params.delaySeconds;
	if (delay === undefined) return fail("set requires delaySeconds.");
	if (typeof delay !== "number" || !Number.isInteger(delay) || delay < 1 || delay > TIMER_LIMITS.maxDelaySeconds)
		return fail(`delaySeconds must be an integer from 1 to ${TIMER_LIMITS.maxDelaySeconds}.`);
	const reason = typeof params.reason === "string" ? params.reason.trim() : "";
	if (!reason) return fail("set requires a reason.");
	if (reason.length > TIMER_LIMITS.maxReasonChars)
		return fail(`reason is at most ${TIMER_LIMITS.maxReasonChars} characters.`);
	const named = checkName(params.name);
	if (typeof named === "object") return named;

	const existing = named === undefined ? undefined : findByName(store, sessionId, named);
	if (!existing && armedTimers(store, sessionId).length >= TIMER_LIMITS.maxPerSession)
		return fail(`This session has ${TIMER_LIMITS.maxPerSession} armed timers, the limit. Cancel one first.`);
	if (existing) disarm(store, existing);

	const name = named ?? nextName(store, sessionId);
	store.seq += 1;
	const id = store.seq;
	const dueAt = now + delay * 1000;
	const handle = setTimeout(() => fire(store, id), delay * 1000);
	handle.unref();
	store.armed.set(id, { id, name, sessionId, reason, createdAt: now, dueAt, handle });
	store.changed?.(sessionId);
	const verb = existing ? "replaced" : "set";
	return done(
		`Timer "${name}" ${verb}: fires at ${clockTime(dueAt)} (in ${formatDuration(dueAt - now)}). ${TIMER_LIFETIME_NOTE}`,
	);
}

function checkName(raw: unknown): string | undefined | TimerResult {
	if (raw === undefined) return undefined;
	const name = typeof raw === "string" ? raw.trim() : "";
	if (!name || name.length > TIMER_LIMITS.maxNameChars)
		return fail(`name must be 1 to ${TIMER_LIMITS.maxNameChars} characters.`);
	return name;
}

function nextName(store: TimerStore, sessionId: string): string {
	for (;;) {
		const count = (store.counters.get(sessionId) ?? 0) + 1;
		store.counters.set(sessionId, count);
		const name = `timer-${count}`;
		if (!findByName(store, sessionId, name)) return name;
	}
}

export function listTimers(store: TimerStore, sessionId: string, now: number): TimerResult {
	const timers = armedTimers(store, sessionId);
	if (timers.length === 0) return done("No timers are armed in this session.");
	return done(
		timers
			.map(
				(timer) =>
					`- ${timer.name}: fires at ${clockTime(timer.dueAt)} (in ${formatDuration(timer.dueAt - now)}). Reason: ${timer.reason}`,
			)
			.join("\n"),
	);
}

export function cancelTimer(store: TimerStore, sessionId: string, rawName: unknown): TimerResult {
	const name = typeof rawName === "string" ? rawName.trim() : "";
	if (!name) return fail("cancel requires name.");
	const timer = findByName(store, sessionId, name);
	if (!timer) {
		const names = armedTimers(store, sessionId).map((item) => item.name);
		return fail(
			`No timer named "${name}" in this session.${names.length > 0 ? ` Armed: ${names.join(", ")}.` : " No timer is armed."}`,
		);
	}
	disarm(store, timer);
	store.changed?.(sessionId);
	return done(`Timer "${name}" cancelled.`);
}

export function cancelTimers(store: TimerStore, filter: TimerFilter): number {
	let count = 0;
	for (const timer of store.armed.values()) {
		if (!matches(timer, filter)) continue;
		disarm(store, timer);
		count++;
	}
	if (count > 0) store.changed?.(filter.sessionId);
	return count;
}

/** Fires the matching timers at once, in creation order. */
export function fireTimersNow(store: TimerStore, filter: TimerFilter, now = Date.now()): number {
	const due = [...store.armed.values()].filter((timer) => matches(timer, filter)).sort((a, b) => a.id - b.id);
	for (const timer of due) {
		disarm(store, timer);
		route(store, info(timer), now);
	}
	if (due.length > 0) store.changed?.(filter.sessionId);
	return due.length;
}

/** Ends every timer. Used when the pi process quits. */
export function clearAllTimers(store: TimerStore): void {
	const sessions = new Set([...store.armed.values(), ...store.queue].map((timer) => timer.sessionId));
	for (const timer of store.armed.values()) clearTimeout(timer.handle);
	store.armed.clear();
	store.queue = [];
	for (const sessionId of sessions) store.changed?.(sessionId);
}

/** Delivers the timers that fired while no runtime was bound. */
export function flushTimers(store: TimerStore, now = Date.now()): void {
	const queue = store.queue;
	store.queue = [];
	for (const timer of queue) route(store, timer, now);
}

function disarm(store: TimerStore, timer: ArmedTimer): void {
	clearTimeout(timer.handle);
	store.armed.delete(timer.id);
}

function fire(store: TimerStore, id: number): void {
	const timer = store.armed.get(id);
	if (!timer) return;
	store.armed.delete(id);
	route(store, info(timer), Date.now());
	store.changed?.(timer.sessionId);
}

function route(store: TimerStore, timer: TimerInfo, now: number): void {
	const wake = store.wake;
	if (!wake || store.sessionId === undefined) {
		store.queue.push(timer);
		return;
	}
	if (timer.sessionId !== store.sessionId) {
		try {
			store.notice?.(`Timer "${timer.name}" of another session fired: ${timer.reason}`);
		} catch {
			// A context of a replaced runtime can no longer show notices.
		}
		return;
	}
	try {
		wake({
			customType: "timer",
			content: firedText(timer, now),
			display: true,
			details: { name: timer.name, reason: timer.reason, createdAt: timer.createdAt, dueAt: timer.dueAt },
		});
	} catch {
		// A runtime that is still loading cannot send messages yet. Keep the timer for the next bind.
		store.queue.push(timer);
	}
}
