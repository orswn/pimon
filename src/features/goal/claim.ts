import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExecFn } from "../../core/exec.ts";
import type { NotifyRequest } from "../notify/index.ts";
import { adjudicateWithCheck, adjudicateWithModel, type ModelResponse, type Usage } from "./adjudicate.ts";
import { buildEvidence } from "./evidence.ts";
import { CHECK_CHANGED_TEXT, stalePauseText } from "./policy.ts";
import type { GoalSession } from "./session.ts";
import {
	achieve,
	countRejection,
	exceededBudget,
	type GoalRecord,
	isActive,
	pause,
	type PauseReason,
} from "./state.ts";

const NO_GOAL = "No goal is active.";
const SESSION_ENDED_TEXT =
	"The session was reloaded or ended while this claim was adjudicated. The verdict was discarded.";
const ADJUDICATION_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 15 * 60_000;

interface GoalClaimHost {
	session: GoalSession;
	exec: ExecFn;
	/** Upper bound of one model adjudication. */
	modelTimeoutMs?: number;
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

async function callModel(extensionCtx: ExtensionContext, prompt: string, signal?: AbortSignal): Promise<ModelResponse> {
	const model = extensionCtx.model;
	if (!model) throw new Error("no model is selected");
	const message = await extensionCtx.modelRegistry
		.streamSimple(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
			signal ? { signal } : {},
		)
		.result();
	const body = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const failed = message.stopReason === "error" || message.stopReason === "aborted";
	return {
		text: body,
		usage: message.usage,
		error: failed ? (message.errorMessage ?? `the model call ended with ${message.stopReason}`) : undefined,
	};
}

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
	if (session.claimInFlight) return text("A claim is already being adjudicated. Wait for its verdict.");

	session.claimInFlight = true;
	const goalId = current.id;
	const generation = current.generation;
	try {
		onUpdate?.(text("adjudicating the claim"));
		const stops: AbortSignal[] = [];
		if (signal) stops.push(signal);
		if (session.cancel) stops.push(session.cancel.signal);
		// A check is bounded by its own timeout. The short cap is for a hung model call only.
		const checkSignal = AbortSignal.any(stops);
		const modelSignal = AbortSignal.any([
			...stops,
			AbortSignal.timeout(host.modelTimeoutMs ?? ADJUDICATION_TIMEOUT_MS),
		]);
		const epoch = session.sessionEpoch;

		const outcome = current.check
			? await adjudicateWithCheck({
					check: current.check,
					exec: host.exec,
					cwd: extensionCtx.cwd,
					timeoutMs: CHECK_TIMEOUT_MS,
					signal: checkSignal,
				})
			: await adjudicateWithModel({
					condition: current.condition,
					evidence: buildEvidence(
						extensionCtx.sessionManager.getBranch() as never[],
						undefined,
						current.evidenceFrom ?? current.createdAt,
					),
					claim: params.evidence,
					signal: modelSignal,
					complete: (prompt, callSignal) => callModel(extensionCtx, prompt, callSignal),
				});
		const usage = outcome.usage as Usage | undefined;
		const withUsage = <T extends object>(result: T) => (usage ? { ...result, usage } : result);
		// A reload or shutdown during the verdict replaced this session's state. Write nothing.
		if (epoch !== session.sessionEpoch) return withUsage(text(SESSION_ENDED_TEXT));

		// /goal-check, pause, clear, or a new goal may have replaced the record during the verdict.
		const fresh = session.life.record;
		if (!fresh || fresh.id !== goalId || fresh.generation !== generation || fresh.state !== "active") {
			if (isActive(fresh) && fresh.id === goalId) return withUsage(text(CHECK_CHANGED_TEXT));
			host.markTerminal();
			return withUsage({
				...text(`The goal changed while this claim was adjudicated, so the verdict was discarded. ${stalePauseText()}`),
				terminate: true,
			});
		}

		if (outcome.verdict === "accepted") {
			if (!host.save(achieve(fresh, true, outcome.reason, Date.now())))
				return withUsage(
					text(
						"The claim was accepted by adjudication, but the achieved state could not be saved. Keep the goal active and retry the claim after the persistence failure is resolved.",
					),
				);
			session.cancel?.abort();
			session.cancel = undefined;
			host.notice(`Goal achieved: ${outcome.reason}`, "info");
			host.report({ kind: "done", title: "pi goal: achieved", message: "Goal achieved", detail: outcome.reason });
			host.markTerminal();
			return withUsage({ ...text(`Goal accepted (${outcome.via}): ${outcome.reason}`), terminate: true });
		}

		if (outcome.verdict === "unverified") {
			if (!host.save(pause(fresh, "unverified", outcome.reason, Date.now())))
				return withUsage(
					text(
						"The claim could not be verified, and the pause state could not be saved. Keep working or report the persistence failure with notify kind=blocked.",
					),
				);
			host.announceStop("unverified", outcome.reason, true);
			host.markTerminal();
			return withUsage({
				...text(
					`The claim could not be adjudicated, so the goal is paused rather than accepted: ${outcome.reason}\nStop here.`,
				),
				terminate: true,
			});
		}

		const rejected = countRejection(fresh, outcome.reason, Date.now());
		const budget = exceededBudget(rejected);
		if (budget) {
			if (!host.save(pause(rejected, budget.reason, budget.detail, Date.now())))
				return withUsage(
					text(
						"The rejection budget was exhausted, but the pause state could not be saved. Report the persistence failure with notify kind=blocked.",
					),
				);
			host.announceStop(budget.reason, `${budget.detail} ${outcome.reason}`, true);
			host.markTerminal();
			return withUsage({
				...text(`Claim rejected: ${outcome.reason}\n${budget.detail}\nStop here.`),
				terminate: true,
			});
		}
		if (!host.save(rejected))
			return withUsage(
				text(
					"The claim was rejected, but the updated goal state could not be saved. Continue working and report the persistence failure if it persists.",
				),
			);
		return withUsage(
			text(
				`Claim rejected (${outcome.via}): ${outcome.reason}\nKeep working: close that specific gap, then claim again.`,
			),
		);
	} finally {
		session.claimInFlight = false;
	}
}
