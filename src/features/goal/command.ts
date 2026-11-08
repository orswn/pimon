import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WakeMessage } from "../../core/feature.ts";
import type { BackgroundService } from "../background/index.ts";
import { clockTime } from "../background/timers.ts";
import { CONTINUE_MESSAGE, goalDetails, START_MESSAGE } from "./lifecycle.ts";
import { continuationText, rejectionHint, startText } from "./policy.ts";
import type { GoalSession } from "./session.ts";
import {
	clear,
	countContinuation,
	createGoal,
	describe,
	type GoalRecord,
	isActive,
	objectiveOf,
	pause,
	resume,
	validateCondition,
} from "./state.ts";
import { expandGoalTemplate, type TemplateCommand } from "./template.ts";

interface GoalCommandHost {
	session: GoalSession;
	timers: BackgroundService["timers"];
	commands(): readonly TemplateCommand[];
	see(extensionCtx: ExtensionContext): void;
	/** Saves a transition. On a failed save nothing changes. */
	save(next: GoalRecord): boolean;
	wake(message: WakeMessage): void;
	/** True when the model can write the objective of a goal the human sets. */
	canDefineObjective(): boolean;
	/** Ends a wait after an interrupted run. */
	woken(): void;
	waiting(): boolean;
}

const STOP_VERBS = new Set(["clear", "stop", "cancel", "pause", "resume"]);

/** A short argument that holds a verb word is likely a mistyped verb, such as "/goal l resume". */
export function typoVerb(input: string): string | undefined {
	const words = input.split(/\s+/).filter(Boolean);
	if (words.length > 3) return undefined;
	return words.find((word) => STOP_VERBS.has(word));
}

function goalTimerLines(host: GoalCommandHost, record: GoalRecord | undefined): string[] {
	const sessionId = host.session.sessionId;
	if (!isActive(record) || sessionId === undefined) return [];
	return host.timers
		.armed(sessionId)
		.filter((timer) => timer.createdAt >= record.startedAt)
		.map((timer) => `timer ${timer.name}: fires at ${clockTime(timer.dueAt)}. Reason: ${timer.reason}`);
}

/** Stops goal-owned work only. The running step of the model is never interrupted. */
function stopWork(session: GoalSession): void {
	session.cancel?.abort();
	session.cancel = undefined;
}

/** Kickoff never saves an active goal it cannot start, and never interrupts a running step. */
function kickoff(
	host: GoalCommandHost,
	next: GoalRecord,
	extensionCtx: ExtensionContext,
	headline: string,
	modelHeadline = headline,
): void {
	if (!extensionCtx.model) {
		extensionCtx.ui.notify("No model is selected, so a goal cannot run.", "error");
		return;
	}
	if (!host.save(next)) return;
	const session = host.session;
	session.life = { ...session.life, cycle: { ...session.life.cycle, stalls: 0 }, waiting: undefined };
	session.cancel?.abort();
	session.cancel = new AbortController();
	extensionCtx.ui.notify(`${headline} ${shownObjective(next)}`, "info");
	host.wake({
		customType: START_MESSAGE,
		content: startText(next, modelHeadline),
		display: true,
		details: goalDetails(next),
	});
}

const shownObjective = (record: GoalRecord) => objectiveOf(record) ?? record.condition;

const stopNotice = (extensionCtx: ExtensionContext, done: string, idle: string) =>
	extensionCtx.isIdle() ? idle : `${done} The current step finishes first. Press Esc to stop it now.`;

async function confirmed(session: GoalSession, extensionCtx: ExtensionContext, title: string, message: string) {
	const token = session.operation;
	const answer = await extensionCtx.ui.confirm(title, message);
	return answer && token === session.operation;
}

const clip = (condition: string) => (condition.length > 300 ? `${condition.slice(0, 300)}…` : condition);

export async function handleGoalCommand(
	host: GoalCommandHost,
	args: string | undefined,
	extensionCtx: ExtensionContext,
): Promise<void> {
	const session = host.session;
	host.see(extensionCtx);
	const input = (args ?? "").trim();
	const record = session.life.record;
	if (!input) {
		const waiting = host.waiting() ? ["waiting: continues after your next message"] : [];
		extensionCtx.ui.notify(
			[describe(record, Date.now()), ...waiting, ...goalTimerLines(host, record)].join("\n"),
			"info",
		);
		return;
	}
	session.operation++;
	if (input === "clear" || input === "stop" || input === "cancel") {
		if (!record || record.state === "cleared") {
			extensionCtx.ui.notify("No goal set.", "info");
			return;
		}
		if (!host.save(clear(record, Date.now()))) return;
		stopWork(session);
		extensionCtx.ui.notify(
			stopNotice(extensionCtx, "Goal cleared.", `Goal cleared: ${shownObjective(record)}`),
			"info",
		);
		return;
	}
	if (input === "pause") {
		if (!isActive(record)) {
			extensionCtx.ui.notify("No active goal to pause.", "warning");
			return;
		}
		if (!host.save(pause(record, "user-input", "you paused it", Date.now()))) return;
		stopWork(session);
		extensionCtx.ui.notify(
			stopNotice(extensionCtx, "Goal paused.", "Goal paused. Resume it with /goal resume."),
			"info",
		);
		return;
	}
	if (input === "resume") {
		if (!record) {
			extensionCtx.ui.notify("No goal to resume.", "warning");
			return;
		}
		const sessionId = session.sessionId;
		if (isActive(record) && !extensionCtx.isIdle() && host.waiting()) {
			host.woken();
			extensionCtx.ui.notify("The goal continues after this run.", "info");
			return;
		}
		if (isActive(record) && extensionCtx.isIdle() && sessionId !== undefined) {
			host.woken();
			const fired = host.timers.fireNow({ sessionId, createdSince: record.startedAt });
			if (fired === 0) {
				const hint = record.detail && record.rejected > 0 ? rejectionHint(record.detail) : undefined;
				const counted = countContinuation(record, Date.now());
				session.life = { ...session.life, record: counted };
				host.wake({
					customType: CONTINUE_MESSAGE,
					content: continuationText(counted, hint),
					display: true,
					details: goalDetails(counted),
				});
			}
			extensionCtx.ui.notify(fired > 0 ? `Fired ${fired} goal timer(s) now.` : "The goal continues now.", "info");
			return;
		}
		const attempt = resume(record, Date.now());
		if (attempt.error || !attempt.record) {
			extensionCtx.ui.notify(attempt.error ?? "Cannot resume.", "warning");
			return;
		}
		kickoff(host, attempt.record, extensionCtx, "Resuming the goal.");
		return;
	}

	const verb = typoVerb(input);
	if (verb) {
		if (!extensionCtx.hasUI) {
			extensionCtx.ui.notify(`"${input}" looks like /goal ${verb}. Nothing changed.`, "warning");
			return;
		}
		if (!(await confirmed(session, extensionCtx, "Set this as the goal?", `It looks like /goal ${verb}.`))) return;
	}

	let expanded: ReturnType<typeof expandGoalTemplate>;
	try {
		expanded = expandGoalTemplate(input, host.commands(), (path) => readFileSync(path, "utf8"));
	} catch (error) {
		extensionCtx.ui.notify(
			`The prompt template could not be read: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}
	const problem = validateCondition(expanded.condition);
	if (problem) {
		extensionCtx.ui.notify(problem, "warning");
		return;
	}
	const current = session.life.record;
	if (
		!verb &&
		extensionCtx.hasUI &&
		(current?.state === "active" || current?.state === "paused") &&
		!(await confirmed(
			session,
			extensionCtx,
			"Replace the current goal?",
			`Current: ${clip(shownObjective(current))}\n\nNew: ${clip(expanded.condition.trim())}`,
		))
	)
		return;
	const from = expanded.template ? ` from /${expanded.template}` : "";
	const condition = expanded.condition;
	kickoff(
		host,
		createGoal({
			condition,
			// Without goal_set the model cannot write an objective, so the human's words are the objective.
			objective: host.canDefineObjective() ? undefined : condition,
			setBy: "human",
			now: Date.now(),
			id: randomUUID(),
		}),
		extensionCtx,
		`Goal set${from}.`,
		`Goal set by the human${from}.`,
	);
}
