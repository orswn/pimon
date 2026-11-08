import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SPAWN_ENTRY } from "../agents/spawn-file.ts";
import type { NotifyRequest } from "../notify/index.ts";
import { objectiveReplacedText, resumedText } from "./policy.ts";
import type { GoalSession } from "./session.ts";
import {
	clear,
	clipText,
	createGoal,
	type GoalRecord,
	isActive,
	objectiveOf,
	pause,
	resume,
	setObjective,
	validateObjective,
} from "./state.ts";

export interface GoalSetParams {
	action: "create" | "edit" | "pause" | "resume" | "clear";
	objective?: string | undefined;
}

export const GOAL_SET_DESCRIPTION =
	'Create or change the autonomous goal. Only on a direct human message in the current run. create: the human wants work carried on unattended across runs or external waits, such as "keep going until", "until it is deployed", "I\'ll be away". Do not create one for a question, an explanation, a review, or a task that one run can finish. edit: the human changed what done means, also in a message sent mid-goal, or a goal set with /goal has no objective yet. Change only what the human asked; never narrow or widen it on your own. pause, resume, clear: the human asked for it. Clear only when the human ends the goal itself, not one step.';

export const OBJECTIVE_DESCRIPTION =
	"Required for create and edit. The full end state, self-contained: what must be true, the command or result that shows it, constraints, and when to stop as blocked. Name things.";

const TEXT = {
	created:
		"Goal created and active. Keep working toward it. Each run end gets a continuation until goal_done or a blocker.",
	defined: "Objective saved. Keep working toward it. Call goal_done when it holds now.",
	same: "Nothing changed: the new objective is the same as the current one.",
	savedPaused: "Objective saved. The goal stays paused until the human runs /goal resume.",
	noAuthority:
		"Nothing changed: goal_set needs a human message in the current run. Continue the current work. If the goal should change, ask the human in your reply.",
	child:
		"Nothing changed: a child agent cannot set goals. Do the task you were given and report the result to your parent.",
	active: 'Nothing changed: a goal is already active. Use action="edit" if the human asked to change it.',
	paused:
		'Nothing changed: a paused goal exists. Use action="edit" if the human asked to change it. Else ask the human to run /goal resume or /goal clear.',
	noGoal: 'Nothing changed: no goal is active or paused. Use action="create".',
	pausedOk: "Goal paused. No continuation follows until the human resumes it.",
	notActive: "Nothing changed: no goal is active.",
	alreadyActive: "Nothing changed: the goal is already active.",
	notPaused: "Nothing changed: no goal is paused.",
	clearedOk: "Goal cleared. No continuation follows.",
	nothingToClear: "Nothing changed: no goal is active or paused.",
	saveFailed: "Nothing changed: the goal state could not be saved.",
} as const;

const REQUEST_CHARS = 4000;
const NOTICE_CHARS = 300;
const LINE_CHARS = 200;

interface GoalSetHost {
	session: GoalSession;
	see(extensionCtx: ExtensionContext): void;
	/** Saves a transition. On a failed save nothing changes. */
	save(next: GoalRecord): boolean;
	notice(message: string, level: "info" | "warning" | "error"): void;
	report(request: NotifyRequest): void;
	markTerminal(): void;
}

type Result = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
const text = (value: string): Result => ({ content: [{ type: "text", text: value }], details: {} });

const clipped = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value);
const firstLine = (value: string) => clipped(value.trim().split("\n")[0] ?? "", LINE_CHARS);
const oneLine = (value: string) => clipped(value.replace(/\s+/g, " ").trim(), LINE_CHARS);

function isChild(extensionCtx: ExtensionContext): boolean {
	return extensionCtx.sessionManager
		.getBranch()
		.some((entry) => entry.type === "custom" && (entry as { customType?: string }).customType === SPAWN_ENTRY);
}

/** A goal that starts or resumes runs with fresh goal-owned work and a fresh stall count. */
function start(session: GoalSession): void {
	session.life = { ...session.life, cycle: { ...session.life.cycle, stalls: 0 }, waiting: undefined };
	session.cancel?.abort();
	session.cancel = new AbortController();
}

function stopWork(session: GoalSession): void {
	session.cancel?.abort();
	session.cancel = undefined;
}

export function executeGoalSet(host: GoalSetHost, params: GoalSetParams, extensionCtx: ExtensionContext): Result {
	host.see(extensionCtx);
	const session = host.session;
	const record = session.life.record;
	const open = record?.state === "active" || record?.state === "paused" ? record : undefined;
	const objective = (params.objective ?? "").trim();

	// The human authorized this goal with /goal, so its first objective needs no other human message.
	if (params.action === "edit" && open && objectiveOf(open) === undefined) {
		const problem = validateObjective(objective);
		if (problem) return text(problem);
		if (!host.save(setObjective(open, objective, undefined, Date.now()))) return text(TEXT.saveFailed);
		host.notice(`Goal objective: ${clipped(objective, NOTICE_CHARS)}`, "info");
		return text(open.state === "active" ? TEXT.defined : TEXT.savedPaused);
	}
	if (isChild(extensionCtx)) return text(TEXT.child);
	const request = session.authority.window;
	if (request === undefined) return text(TEXT.noAuthority);

	switch (params.action) {
		case "create": {
			if (open?.state === "active") return text(TEXT.active);
			if (open) return text(TEXT.paused);
			const problem = validateObjective(objective);
			if (problem) return text(problem);
			const created = createGoal({
				condition: clipText(request, REQUEST_CHARS),
				objective,
				setBy: "model",
				now: Date.now(),
				id: randomUUID(),
			});
			if (!host.save(created)) return text(TEXT.saveFailed);
			start(session);
			const shown = clipped(objective, NOTICE_CHARS);
			host.notice(`Goal set by the model: ${shown}\nUndo with /goal clear.`, "info");
			host.report({ kind: "info", title: "pi goal: set by the model", message: shown });
			return text(TEXT.created);
		}
		case "edit": {
			if (!open) return text(TEXT.noGoal);
			const problem = validateObjective(objective);
			if (problem) return text(problem);
			const previous = objectiveOf(open) ?? open.condition;
			if (previous === objective) return text(TEXT.same);
			const updated = setObjective(open, objective, request, Date.now());
			if (!host.save(updated)) return text(TEXT.saveFailed);
			host.notice(
				[
					`Goal changed at your request: ${firstLine(objective)}`,
					`was: ${firstLine(previous)}`,
					`you said: ${oneLine(request)}`,
					"Full text: /goal",
				].join("\n"),
				"info",
			);
			return text(isActive(updated) ? objectiveReplacedText(updated) : TEXT.savedPaused);
		}
		case "pause": {
			if (open?.state !== "active") return text(TEXT.notActive);
			if (!host.save(pause(open, "user-input", "you paused it", Date.now()))) return text(TEXT.saveFailed);
			stopWork(session);
			host.markTerminal();
			host.notice("Goal paused at your request. Resume: say so, or /goal resume.", "info");
			return text(TEXT.pausedOk);
		}
		case "resume": {
			if (!open) return text(TEXT.notPaused);
			if (open.state === "active") return text(TEXT.alreadyActive);
			const attempt = resume(open, Date.now());
			if (!attempt.record || !host.save(attempt.record)) return text(TEXT.saveFailed);
			start(session);
			host.notice("Goal resumed at your request.", "info");
			return text(resumedText(attempt.record));
		}
		case "clear": {
			if (!open) return text(TEXT.nothingToClear);
			if (!host.save(clear(open, Date.now()))) return text(TEXT.saveFailed);
			stopWork(session);
			host.markTerminal();
			host.notice(
				`Goal cleared at your request: ${clipped(objectiveOf(open) ?? open.condition, NOTICE_CHARS)}`,
				"info",
			);
			return text(TEXT.clearedOk);
		}
	}
}
