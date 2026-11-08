import type { CustomMessageEntryDraft, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createProcessRunner, type ExecFn } from "../../core/exec.ts";
import { defineFeature, type WakeMessage } from "../../core/feature.ts";
import { checkOnlyCall, formatOutcome, type NotifyRequest } from "../notify/index.ts";
import { executeClaim } from "./claim.ts";
import { handleGoalCommand } from "./command.ts";
import {
	CONDITION_MESSAGE,
	CONTINUE_MESSAGE,
	type Effect,
	goalDetails,
	initialLifecycle,
	type LifecycleInput,
	START_MESSAGE,
	step,
} from "./lifecycle.ts";
import { conditionChangedText } from "./policy.ts";
import { GOAL_PROMPT } from "./prompt.ts";
import type { GoalSession } from "./session.ts";
import { type GoalRecord, isActive, latestFromEntries, type PauseReason, setCheck } from "./state.ts";
import { goalTemplateCompletions } from "./template.ts";

export { typoVerb } from "./command.ts";

const ENTRY_TYPE = "goal";
const CLAIM_TOOL = "goal_done";
export const NO_TIMER_WARNING = "The active goal has no armed timer. Run /goal resume to continue it.";

export const CLAIM_DESCRIPTION =
	"Claim that the active goal's completion condition is met. An independent check runs before the claim is accepted. Must be the only tool call in its message.";

export interface GoalStatePayload {
	state?: GoalRecord["state"];
	turns?: number;
	/** Epoch ms of the earliest armed timer of this session. */
	timerDueAt?: number;
}

declare module "../../core/events.ts" {
	interface PimonEvents {
		/** Sent on each change and at each session start. `{}` means no goal. */
		"goal:state": { state?: string; turns?: number; timerDueAt?: number };
	}
}

export interface GoalFeatureOptions {
	/** Runs check commands. Tests inject a recorder. */
	exec?: ExecFn;
	/** Upper bound of one model adjudication. Tests shorten it. */
	modelTimeoutMs?: number;
}

/** Entry times have millisecond resolution, so a result that ties with the landing must still be excluded. */
function evidenceStart(extensionCtx: ExtensionContext): number {
	const branch = extensionCtx.sessionManager.getBranch();
	const last = branch.at(-1) as { timestamp?: string } | undefined;
	const lastTime = last?.timestamp ? Date.parse(last.timestamp) : Number.NaN;
	return Number.isNaN(lastTime) ? Date.now() : Math.max(Date.now(), lastTime + 1);
}

function lastErrorMessage(extensionCtx: ExtensionContext): string | undefined {
	const branch = extensionCtx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index] as {
			type?: string;
			message?: { role?: string; stopReason?: string; errorMessage?: string };
		};
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const message = entry.message;
		return message.stopReason === "error" && message.errorMessage?.trim() ? message.errorMessage.trim() : undefined;
	}
	return undefined;
}

export function createGoalFeature(options: GoalFeatureOptions = {}) {
	return defineFeature({
		id: "goal",
		description: "Autonomous goals: unattended work toward a condition, finished by an independent check",
		dependsOn: ["notify", "background"],
		defaultEnabled: true,
		setup(ctx) {
			const pi = ctx.pi;
			const runner = createProcessRunner();
			const exec = options.exec ?? runner.run;
			const notifier = ctx.service("notify");
			const timers = ctx.service("background").timers;

			const session: GoalSession = {
				life: initialLifecycle(),
				sessionId: undefined,
				cancel: undefined,
				operation: 0,
				claimInFlight: false,
				sessionEpoch: 0,
			};
			let ui: ExtensionContext | undefined;

			const notice = (message: string, level: "info" | "warning" | "error") => {
				try {
					if (ui?.hasUI) ui.ui.notify(message, level);
				} catch {
					// A context from a replaced session can no longer show notices.
				}
			};

			const see = (extensionCtx: ExtensionContext) => {
				ui = extensionCtx;
				session.sessionId = extensionCtx.sessionManager.getSessionId();
			};

			/** Armed timers and fired timers that wait for the next runtime bind. Both still wake this session. */
			const timerArmed = () => {
				const sessionId = session.sessionId;
				return sessionId !== undefined && (timers.armed(sessionId).length > 0 || timers.pending(sessionId).length > 0);
			};
			// Set while the goal cancels its own timers, so that cancel raises no warning.
			let releasing = false;

			const publish = () => {
				const record = session.life.record;
				const sessionId = session.sessionId;
				const payload: GoalStatePayload = record ? { state: record.state, turns: record.turns } : {};
				const due = sessionId === undefined ? [] : timers.armed(sessionId).map((timer) => timer.dueAt);
				if (record && due.length > 0) payload.timerDueAt = Math.min(...due);
				ctx.events.emit("goal:state", payload);
			};

			/** A goal that ends, pauses, or is replaced takes the timers set since it started with it. */
			const releaseTimers = (previous: GoalRecord | undefined, next: GoalRecord | undefined) => {
				const sessionId = session.sessionId;
				if (!isActive(previous) || sessionId === undefined) return;
				if (isActive(next) && next.id === previous.id) return;
				releasing = true;
				try {
					timers.cancel({ sessionId, createdSince: previous.startedAt });
				} finally {
					releasing = false;
				}
			};

			const isIdle = () => {
				try {
					return ui?.isIdle() ?? false;
				} catch {
					// A context from a replaced session cannot answer.
					return false;
				}
			};

			ctx.events.on("timers:changed", (payload) => {
				if (!live || payload.sessionId !== session.sessionId) return;
				publish();
				if (releasing || !isActive(session.life.record) || timerArmed() || !isIdle()) return;
				notice(NO_TIMER_WARNING, "warning");
			});

			const append = (record: GoalRecord): boolean => {
				try {
					pi.appendEntry(ENTRY_TYPE, record);
					return true;
				} catch (error) {
					notice(`Goal state could not be saved: ${error instanceof Error ? error.message : String(error)}`, "error");
					return false;
				}
			};

			/** Saves a transition. On a failed save nothing changes, so the caller can report it. */
			const save = (next: GoalRecord): boolean => {
				if (!append(next)) return false;
				const previous = session.life.record;
				session.life = { ...session.life, record: next };
				releaseTimers(previous, next);
				publish();
				return true;
			};

			const wake = (message: WakeMessage) => ctx.wake(message);
			// The run that was active at a reload still sends events to this instance. Its context is stale.
			let live = true;

			const report = (request: NotifyRequest) => {
				void notifier.notify(request).then(
					(outcome) => {
						if (!outcome.ok && !outcome.suppressed) notice(formatOutcome(outcome), "warning");
					},
					(error: unknown) => notice(`Goal notification failed: ${String(error)}`, "warning"),
				);
			};

			const announceStop = (reason: PauseReason, detail: string, phone: boolean) => {
				session.cancel?.abort();
				session.cancel = undefined;
				notice(`Goal paused: ${reason}. ${detail}`, "warning");
				if (phone) report({ kind: "paused", title: "pi goal: paused", message: `Goal paused: ${reason}`, detail });
			};

			/** Runs one reducer step and its effects. Returns the drafts for a before-settle boundary. */
			const run = (input: LifecycleInput, extensionCtx?: ExtensionContext): CustomMessageEntryDraft[] => {
				if (extensionCtx) see(extensionCtx);
				const previous = session.life.record;
				const result = step(session.life, input, Date.now());
				session.life = result.state;
				releaseTimers(previous, session.life.record);
				const drafts: CustomMessageEntryDraft[] = [];
				for (const effect of result.effects) apply(effect, drafts);
				if (session.life.record !== previous) publish();
				return drafts;
			};

			const apply = (effect: Effect, drafts: CustomMessageEntryDraft[]) => {
				switch (effect.type) {
					case "persist":
						append(effect.record);
						return;
					case "remember":
						return;
					case "continue":
						drafts.push({
							type: "custom_message",
							customType: CONTINUE_MESSAGE,
							content: effect.text,
							display: true,
							details: effect.details,
						});
						return;
					case "stopped":
						announceStop(effect.reason, effect.detail, effect.phone);
						return;
					case "condition":
						// TODO(okka): the reminder lands one turn late after an in-run threshold compaction.
						pi.sendMessage(
							{ customType: CONDITION_MESSAGE, content: effect.text, display: true, details: effect.details },
							{ triggerTurn: false },
						);
						return;
				}
			};

			const reconstruct = (extensionCtx: ExtensionContext, kind: "restart" | "navigation") => {
				session.cancel?.abort();
				session.cancel = undefined;
				see(extensionCtx);
				const found = latestFromEntries(extensionCtx.sessionManager.getBranch(), ENTRY_TYPE);
				run({ type: "recover", found, kind, timerArmed: timerArmed() }, extensionCtx);
				publish();
			};

			const markTerminal = () => run({ type: "terminal" });

			ctx.promptSection({ name: "goal", render: () => GOAL_PROMPT });

			ctx.events.on("notify:blocked", (payload) => {
				if (!live) return undefined;
				run({ type: "blocked", message: payload.message, detail: payload.detail });
			});

			ctx.onSessionStart((_event, extensionCtx) => {
				live = true;
				reconstruct(extensionCtx, "restart");
			});
			pi.on("session_tree", (_event, extensionCtx) => {
				if (live) reconstruct(extensionCtx, "navigation");
			});
			ctx.onSessionShutdown(() => {
				session.sessionEpoch++;
				live = false;
				session.cancel?.abort();
				session.cancel = undefined;
				// Check commands run in their own process groups, which outlive pi unless killed here.
				runner.terminateAll();
			});

			pi.on("turn_start", () => {
				if (!live) return undefined;
				run({ type: "turn-start" });
			});

			pi.on("message_start", (event, extensionCtx) => {
				if (!live) return undefined;
				const message = event.message as { role?: string; customType?: string; details?: unknown };
				if (message.role === "custom" && message.customType === START_MESSAGE) {
					const goalId = (message.details as { goal?: unknown } | undefined)?.goal;
					if (typeof goalId === "string")
						run({ type: "start-landed", goal: goalId, at: evidenceStart(extensionCtx) }, extensionCtx);
				}
			});

			pi.on("turn_end", (event) => {
				if (!live) return undefined;
				run({ type: "turn-end", stopReason: (event.message as { stopReason?: string }).stopReason });
				return undefined;
			});

			pi.on("agent_before_settle", (event, extensionCtx) => {
				if (!live) return undefined;
				const errorMessage = event.outcome === "error" ? lastErrorMessage(extensionCtx) : undefined;
				see(extensionCtx);
				const drafts = run(
					{ type: "before-settle", outcome: event.outcome, errorMessage, timerArmed: timerArmed() },
					extensionCtx,
				);
				if (drafts.length === 0) return undefined;
				return { entries: [...event.entries, ...drafts], continue: true };
			});

			pi.on("agent_settled", (event, extensionCtx) => {
				if (!live) return undefined;
				see(extensionCtx);
				run({ type: "settled", aborted: event.aborted, timerArmed: timerArmed() }, extensionCtx);
			});

			pi.on("session_compact", (_event, extensionCtx) => {
				if (!live) return undefined;
				run({ type: "compacted" }, extensionCtx);
			});

			pi.on("tool_call", (event, extensionCtx) => {
				if (!live) return undefined;
				run({ type: "tool-call" });
				if (event.toolName !== CLAIM_TOOL) return undefined;
				const problem = checkOnlyCall(event, extensionCtx);
				if (!problem) return undefined;
				const drop = problem.nested
					? "Call it directly, not from a script"
					: `Drop ${problem.siblings.join(", ")}, let those finish first`;
				return {
					block: true,
					reason: `${event.toolName} must be the only tool call in its message. ${drop}, then call it again. This does not count against the goal.`,
				};
			});

			const host = {
				session,
				timers,
				exec,
				modelTimeoutMs: options.modelTimeoutMs,
				commands: () => pi.getCommands(),
				see,
				save,
				wake,
				notice,
				report,
				announceStop,
				markTerminal,
			};

			pi.registerTool({
				name: CLAIM_TOOL,
				label: "Goal Done",
				description: CLAIM_DESCRIPTION,
				promptSnippet: "Claim the active goal is complete, with evidence, for independent adjudication",
				executionMode: "sequential",
				exposure: "model-only",
				parameters: Type.Object({
					evidence: Type.String({
						description:
							"What in this conversation proves the condition holds: which commands ran and what they output",
					}),
				}),
				execute: (_id, params, signal, onUpdate, extensionCtx) =>
					executeClaim(host, params, signal, onUpdate, extensionCtx),
			});

			pi.registerCommand("goal", {
				description: "Set an autonomous goal, or inspect, pause, resume, or clear one",
				getArgumentCompletions: (prefix) => goalTemplateCompletions(prefix, pi.getCommands()),
				handler: (args, extensionCtx) => handleGoalCommand(host, args, extensionCtx),
			});

			pi.registerCommand("goal-check", {
				description: "Set the verification command of the goal, or clear it with no argument",
				async handler(args, extensionCtx) {
					see(extensionCtx);
					const command = (args ?? "").trim();
					const record = session.life.record;
					if (!record || (record.state !== "active" && record.state !== "paused")) {
						extensionCtx.ui.notify("Set a goal first, then attach a check command.", "warning");
						return;
					}
					const updated = setCheck(record, command || undefined, Date.now());
					if (!save(updated)) {
						extensionCtx.ui.notify("The check command could not be saved.", "error");
						return;
					}
					if (isActive(updated))
						pi.sendMessage(
							{
								customType: CONDITION_MESSAGE,
								content: conditionChangedText(updated),
								display: true,
								details: goalDetails(updated),
							},
							{ triggerTurn: false },
						);
					extensionCtx.ui.notify(command ? `Check command set: ${command}` : "Check command removed.", "info");
				},
			});
		},
	});
}

export const goal = createGoalFeature();
