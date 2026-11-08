import { readFileSync } from "node:fs";
import { uptime } from "node:os";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defineFeature } from "../../core/feature.ts";
import {
	type BootStamp,
	bootNeedsSave,
	bootTimeOf,
	type Clock,
	type ClockMark,
	detectGap,
	type Gap,
	gapText,
	hostRebooted,
	type PiFact,
} from "./gap.ts";
import { renderGap } from "./render.ts";

const STALE_TYPE = "pimon-stale";

const configSchema = Type.Object(
	{
		idleMinutes: Type.Integer({ minimum: 1, default: 30 }),
	},
	{ additionalProperties: false },
);

function linuxBootId(): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

export const systemClock: Clock = {
	now: () => ({ wall: Date.now(), mono: process.hrtime.bigint(), uptime: uptime() }),
	offsetMinutes: (wall) => -new Date(wall).getTimezoneOffset(),
	bootId: linuxBootId,
};

interface StaleState {
	/** Clock sample of this process, for suspend math. */
	mark: ClockMark | undefined;
	/** Facts for the next run. A reload keeps them, so a reload before the first run loses nothing. */
	pending: PiFact | undefined;
	hostRestarted: boolean;
	/** Sessions this process has started, so a switch back is no restart. */
	seen: Set<string>;
}

// Only runs add message entries. Custom messages can be stored while nobody works.
const isActivity = (entry: SessionEntry) => entry.type === "message";

function lastActivity(branch: readonly SessionEntry[]): number | undefined {
	const entry = branch.findLast(isActivity);
	return entry ? Date.parse(entry.timestamp) : undefined;
}

function savedStamp(branch: readonly SessionEntry[]): BootStamp | undefined {
	const entry = branch.findLast((item) => item.type === "custom" && item.customType === STALE_TYPE);
	const data =
		entry?.type === "custom" ? (entry.data as { bootTime?: unknown; bootId?: unknown } | undefined) : undefined;
	if (typeof data?.bootTime !== "number") return undefined;
	return typeof data.bootId === "string"
		? { bootTime: data.bootTime, bootId: data.bootId }
		: { bootTime: data.bootTime };
}

export function createStale(clock: Clock = systemClock) {
	return defineFeature({
		id: "stale",
		description: "Tell the model about a session gap: idle time, a pi reload or restart, a host suspend or restart",
		defaultEnabled: true,
		configSchema,
		setup(ctx) {
			const idleMs = ctx.config.idleMinutes * 60_000;
			const clockState = ctx.reloadState<StaleState>("state", 1, () => ({
				mark: undefined,
				pending: undefined,
				hostRestarted: false,
				seen: new Set(),
			}));
			const touch = () => {
				clockState.mark = clock.now();
			};

			ctx.onSessionStart((event, extensionCtx) => {
				const manager = extensionCtx.sessionManager;
				const branch = manager.getBranch();
				const sessionId = manager.getSessionId();
				const now = clock.now();
				const bootId = clock.bootId();
				const current: BootStamp = bootId ? { bootTime: bootTimeOf(now), bootId } : { bootTime: bootTimeOf(now) };
				const saved = savedStamp(branch);
				if (event.reason === "reload") {
					if (clockState.pending !== "restart") clockState.pending = "reload";
				} else {
					// The jobs of a session this process ran before are still here. Other sessions lost theirs.
					const firstHere =
						event.reason === "startup" || (event.reason === "resume" && !clockState.seen.has(sessionId));
					const restart = firstHere && branch.some(isActivity);
					clockState.pending = restart ? "restart" : undefined;
					clockState.hostRestarted = restart && hostRebooted(saved, current);
				}
				clockState.seen.add(sessionId);
				// A suspend before a reload still counts.
				if (event.reason !== "reload" || !clockState.mark) clockState.mark = now;
				if (bootNeedsSave(saved, current)) ctx.pi.appendEntry(STALE_TYPE, current);
			});

			ctx.pi.on("message_end", touch);
			ctx.pi.on("agent_settled", touch);

			// pi emits before_agent_start before it adds the starting message to the session.
			ctx.pi.on("before_agent_start", (_event, extensionCtx) => {
				const now = clock.now();
				const gap = detectGap({
					now,
					offsetMinutes: clock.offsetMinutes(now.wall),
					lastActivity: lastActivity(extensionCtx.sessionManager.getBranch()),
					mark: clockState.mark,
					idleMs,
					hostRestarted: clockState.hostRestarted,
					pi: clockState.pending,
				});
				clockState.pending = undefined;
				clockState.hostRestarted = false;
				clockState.mark = now;
				if (!gap) return;
				return { message: { customType: STALE_TYPE, content: gapText(gap), display: true, details: gap } };
			});

			ctx.pi.registerMessageRenderer<Gap>(STALE_TYPE, renderGap);
		},
	});
}

export const stale = createStale();
