import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecFn } from "../../core/exec.ts";
import type { NotifyRequest } from "../notify/index.ts";
import { adjudicateWithCheck } from "./adjudicate.ts";
import { CHECK_CHANGED_TEXT, checkFailedText, checkPassedText, GOAL_DONE_TEXT, stalePauseText } from "./policy.ts";
import type { GoalSession } from "./session.ts";
import {
	achieve,
	clipText,
	countRejection,
	exceededBudget,
	type GoalRecord,
	isActive,
	objectiveOf,
	pause,
	type PauseReason,
} from "./state.ts";

const NO_GOAL = "No goal is active.";
const PENDING_TEXT = 'Nothing changed: the goal has no objective yet. Call goal_set action="edit" first.';
const EMPTY_EVIDENCE_TEXT = "Nothing changed: give the commands that ran and what they showed.";
const SESSION_ENDED_TEXT = "The session was reloaded or ended while this claim was checked. The verdict was discarded.";
const CHECK_TIMEOUT_MS = 15 * 60_000;
const DETAIL_CHARS = 300;

interface GoalClaimHost {
	session: GoalSession;
	exec: ExecFn;
	see(extensionCtx: ExtensionContext): void;
	/** Saves a transition. On a failed save nothing changes. */
	save(next: GoalRecord): boolean;
	notice(message: string, level: "info" | "warning" | "error"): void;
	report(request: NotifyRequest): void;
	announceStop(reason: PauseReason, detail: string, phone: boolean): void;
	markTerminal(): void;
}

type Text = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
const text = (value: string, details: Record<string, unknown> = {}): Text => ({
	content: [{ type: "text", text: value }],
	details,
});

/** Saves the achieved state and tells the human. Returns false on a failed save. */
function finish(host: GoalClaimHost, record: GoalRecord, evidence: string): boolean {
	const detail = clipText(evidence, DETAIL_CHARS);
	if (!host.save(achieve(record, detail, Date.now()))) return false;
	host.session.cancel?.abort();
	host.session.cancel = undefined;
	host.notice(`Goal done: ${detail}`, "info");
	host.report({ kind: "done", title: "pi goal: achieved", message: detail });
	host.markTerminal();
	return true;
}

const SAVE_FAILED_TEXT =
	"The goal is done, but the achieved state could not be saved. Keep the goal active and call goal_done again after the persistence failure is resolved.";

export async function executeClaim(
	host: GoalClaimHost,
	params: { evidence: string },
	signal: AbortSignal | undefined,
	onUpdate: ((partial: Text) => void) | undefined,
	extensionCtx: ExtensionContext,
) {
	const session = host.session;
	host.see(extensionCtx);
	const current = session.life.record;
	if (!isActive(current)) return text(NO_GOAL);
	if (objectiveOf(current) === undefined) return text(PENDING_TEXT);
	const evidence = (params.evidence ?? "").trim();
	if (!evidence) return text(EMPTY_EVIDENCE_TEXT);
	if (session.claimInFlight) return text("A claim is already being checked. Wait for its verdict.");

	if (!current.check) return text(finish(host, current, evidence) ? GOAL_DONE_TEXT : SAVE_FAILED_TEXT);

	session.claimInFlight = true;
	const goalId = current.id;
	const generation = current.generation;
	try {
		onUpdate?.(text("running the check command"));
		const stops: AbortSignal[] = [];
		if (signal) stops.push(signal);
		if (session.cancel) stops.push(session.cancel.signal);
		const epoch = session.sessionEpoch;

		const outcome = await adjudicateWithCheck({
			check: current.check,
			exec: host.exec,
			cwd: extensionCtx.cwd,
			timeoutMs: CHECK_TIMEOUT_MS,
			signal: AbortSignal.any(stops),
		});
		// A reload or shutdown during the check replaced this session's state. Write nothing.
		if (epoch !== session.sessionEpoch) return text(SESSION_ENDED_TEXT);

		// /goal-check, pause, clear, or a new goal may have replaced the record during the check.
		const fresh = session.life.record;
		if (!fresh || fresh.id !== goalId || fresh.generation !== generation || fresh.state !== "active") {
			if (isActive(fresh) && fresh.id === goalId) return text(CHECK_CHANGED_TEXT);
			host.markTerminal();
			return {
				...text(`The goal changed while this claim was checked, so the verdict was discarded. ${stalePauseText()}`),
				terminate: true,
			};
		}

		if (outcome.verdict === "accepted")
			return text(finish(host, fresh, evidence) ? checkPassedText(current.check) : SAVE_FAILED_TEXT);

		if (outcome.verdict === "unverified") {
			if (!host.save(pause(fresh, "unverified", outcome.reason, Date.now())))
				return text(
					"The claim could not be verified, and the pause state could not be saved. Keep working or report the persistence failure with notify kind=blocked.",
				);
			host.announceStop("unverified", outcome.reason, true);
			host.markTerminal();
			return {
				...text(
					`The claim could not be checked, so the goal is paused rather than accepted: ${outcome.reason}\nStop here.`,
				),
				terminate: true,
			};
		}

		const failed = checkFailedText(outcome.code ?? 1, outcome.tail ?? "");
		const rejected = countRejection(fresh, outcome.reason, Date.now());
		const budget = exceededBudget(rejected);
		if (budget) {
			if (!host.save(pause(rejected, budget.reason, budget.detail, Date.now())))
				return text(
					"The rejection budget was exhausted, but the pause state could not be saved. Report the persistence failure with notify kind=blocked.",
				);
			host.announceStop(budget.reason, `${budget.detail} ${outcome.reason}`, true);
			host.markTerminal();
			return { ...text(`Claim rejected: ${outcome.reason}\n${budget.detail}\nStop here.`), terminate: true };
		}
		if (!host.save(rejected))
			return text(
				"The claim was rejected, but the updated goal state could not be saved. Continue working and report the persistence failure if it persists.",
			);
		return text(failed);
	} finally {
		session.claimInFlight = false;
	}
}
