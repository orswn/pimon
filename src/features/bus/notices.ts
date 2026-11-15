import type { PendingResult, PresenceEvent } from "@orswn/a2a-hub-protocol";
import { ago } from "./digest.ts";
import type { WakePolicy } from "./identity.ts";
import { shortId, withoutAskedTasks } from "./protocol.ts";

/** Open work between this session and one other agent, in both directions. */
export interface OpenWork {
	/** Questions and tasks this session waits for from the agent. */
	waiting: number;
	/** Questions and tasks the agent waits for from this session. */
	owed: number;
}

export function openWorkWith(agent: string, pending: PendingResult, owed: PendingResult): OpenWork {
	const count = (raw: PendingResult) => {
		const result = withoutAskedTasks(raw);
		return (
			result.expectReply.filter((entry) => entry.agent === agent).length +
			result.tasks.filter((task) => task.agent === agent).length
		);
	};
	return { waiting: count(pending), owed: count(owed) };
}

export function offlineNotice(event: PresenceEvent, work: OpenWork): string {
	const what = `${event.name} (id:${shortId(event.agent)}) went offline.`;
	return work.waiting > 0 ? `${what} It had ${work.waiting} unanswered request(s).` : what;
}

export function lapseNotice(name: string, askedAt: number, title: string, now = Date.now()): string {
	return `No reply yet from ${name} after ${ago(askedAt, now)} on "${title}". Do not resend. Wait, or probe once.`;
}

export interface OfflineContext {
	/** The parent session id of this session. */
	parent: string | undefined;
	policy: WakePolicy;
}

/** An offline notice wakes only when work is open with that agent, or it is a child, and the wake policy allows it. */
export function offlineWakes(event: PresenceEvent, work: OpenWork, context: OfflineContext): boolean {
	const child = event.relation === "child";
	if (work.waiting === 0 && work.owed === 0 && !child) return false;
	if (context.policy === "none") return false;
	if (context.policy === "parent") return Boolean(context.parent) && event.agent === context.parent;
	return true;
}

const EXPECTED_EXIT_MS = 10 * 60_000;

/** Agents whose next offline notice was asked for, so it must not start a run. */
export class ExpectedExits {
	private readonly marks = new Map<string, { at: number }>();

	/** Returns a cancel that drops only this mark. */
	expect(agent: string, now = Date.now()): () => void {
		const mark = { at: now };
		this.marks.set(agent, mark);
		return () => {
			if (this.marks.get(agent) === mark) this.marks.delete(agent);
		};
	}

	/** Any offline event uses up the mark. Only a mark inside the window matches. */
	take(agent: string, now = Date.now()): boolean {
		const mark = this.marks.get(agent);
		this.marks.delete(agent);
		return Boolean(mark) && now - (mark?.at ?? 0) <= EXPECTED_EXIT_MS;
	}

	clear(agent: string): void {
		this.marks.delete(agent);
	}
}
