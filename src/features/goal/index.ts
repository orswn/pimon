import { StringEnum } from "@earendil-works/pi-ai";
import type { CustomMessageEntryDraft, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createProcessRunner, type ExecFn } from "../../core/exec.ts";
import { defineFeature, type WakeMessage } from "../../core/feature.ts";
import { checkOnlyCall, formatOutcome, type NotifyRequest } from "../notify/index.ts";
import { closeAuthority, onInput, onUserMessage, openAuthority } from "./authority.ts";
import { executeClaim } from "./claim.ts";
import { handleGoalCommand } from "./command.ts";
import {
	CONDITION_MESSAGE,
	CONTINUE_MESSAGE,
	type Effect,
	goalDetails,
	initialLifecycle,
	isWaiting,
	type LifecycleInput,
	step,
} from "./lifecycle.ts";
import { checkCommandChangedText } from "./policy.ts";
import { GOAL_PROMPT } from "./prompt.ts";
import type { GoalSession } from "./session.ts";
import { executeGoalSet, GOAL_SET_DESCRIPTION, type GoalSetParams, OBJECTIVE_DESCRIPTION } from "./set.ts";
import {
	copiedFromAnotherSession,
	type GoalRecord,
	isActive,
	latestFromEntries,
	type PauseReason,
	type RecoverKind,
	setCheck,
} from "./state.ts";
import { goalTemplateCompletions } from "./template.ts";

export { typoVerb } from "./command.ts";

const ENTRY_TYPE = "goal";
const CLAIM_TOOL = "goal_done";
const GOAL_SET_TOOL = "goal_set";
const NO_TIMER_WARNING = "The active goal has no armed timer. Run /goal resume to continue it.";
const WAITING_NOTICE = "Goal still active. It continues after your next message. /goal pause stops it.";

const CLAIM_DESCRIPTION =
	"Mark the active goal done. Call it only when the objective holds now. Must be the only tool call in its message.";

export interface GoalStatePayload {
	state?: GoalRecord["state"];
	turns?: number;
	/** Epoch ms of the earliest armed timer of this session. */
	timerDueAt?: number;
	/** Set while an active goal waits for the next human message after an interrupted run. */
	waiting?: true;
}

declare module "../../core/events.ts" {
	interface PimonEvents {
		/** Sent on each change and at each session start. `{}` means no goal. */
		"goal:state": { state?: string; turns?: number; timerDueAt?: number; waiting?: true };
	}
}

interface GoalFeatureOptions {
	/** Runs check commands. Tests inject a recorder. */
	exec?: ExecFn;
}

/**
 * The in-memory goal state at the last shutdown. /reload keeps it, so turn and continuation counts
 * and a wait survive. A restart derives the wait again from the armed timers.
 */
interface ReloadSlot {
	sessionId: string | undefined;
	waiting: string | undefined;
	record: GoalRecord | undefined;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => (part as { type?: string })?.type === "text")
		.map((part) => part.text)
		.join("\n");
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
		description: "Autonomous goals that the human or the model sets. The model marks a goal done",
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
				authority: openAuthority(),
			};
			const slot = ctx.reloadState<ReloadSlot>("session", 1, () => ({
				sessionId: undefined,
				waiting: undefined,
				record: undefined,
			}));
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
				if (isWaiting(session.life)) payload.waiting = true;
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
				if (releasing || !isActive(session.life.record) || isWaiting(session.life) || timerArmed() || !isIdle()) return;
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
				session.life = { ...session.life, record: next, waiting: isActive(next) ? session.life.waiting : undefined };
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
				if (phone) report({ kind: "paused", title: "pi goal: paused", message: reason, detail });
			};

			/** Runs one reducer step and its effects. Returns the drafts for a before-settle boundary. */
			const run = (input: LifecycleInput, extensionCtx?: ExtensionContext): CustomMessageEntryDraft[] => {
				if (extensionCtx) see(extensionCtx);
				const previous = session.life.record;
				const wasWaiting = session.life.waiting;
				const result = step(session.life, input, Date.now());
				session.life = result.state;
				releaseTimers(previous, session.life.record);
				const drafts: CustomMessageEntryDraft[] = [];
				for (const effect of result.effects) apply(effect, drafts);
				if (session.life.record !== previous || session.life.waiting !== wasWaiting) publish();
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
					case "waiting":
						notice(WAITING_NOTICE, "info");
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

			const reconstruct = (extensionCtx: ExtensionContext, kind: RecoverKind) => {
				session.cancel?.abort();
				session.cancel = undefined;
				session.authority = closeAuthority();
				see(extensionCtx);
				const branch = extensionCtx.sessionManager.getBranch();
				const saved = latestFromEntries(branch, ENTRY_TYPE);
				const kept = kind === "reload" && slot.sessionId === session.sessionId ? slot.record : undefined;
				const sameState =
					kept !== undefined &&
					saved !== undefined &&
					kept.id === saved.id &&
					kept.generation === saved.generation &&
					kept.state === saved.state;
				const found = sameState ? kept : saved;
				const waiting = sameState && slot.waiting === saved.id;
				const copied =
					kind === "restart" &&
					copiedFromAnotherSession(branch, extensionCtx.sessionManager.getHeader()?.timestamp, ENTRY_TYPE);
				run({ type: "recover", found, kind: copied ? "fork" : kind, timerArmed: timerArmed(), waiting }, extensionCtx);
				publish();
			};

			const markTerminal = () => run({ type: "terminal" });

			ctx.promptSection({ name: "goal", requiresTools: ["goal_done"], render: () => GOAL_PROMPT });

			ctx.events.on("notify:blocked", (payload) => {
				if (!live) return undefined;
				run({ type: "blocked", message: payload.message, detail: payload.detail });
			});

			ctx.onSessionStart((event, extensionCtx) => {
				live = true;
				const kind = event.reason === "reload" || event.reason === "fork" ? event.reason : "restart";
				reconstruct(extensionCtx, kind);
			});
			pi.on("session_tree", (_event, extensionCtx) => {
				if (live) reconstruct(extensionCtx, "navigation");
			});
			ctx.onSessionShutdown(() => {
				slot.sessionId = session.sessionId;
				slot.waiting = session.life.waiting;
				slot.record = session.life.record;
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

			pi.on("input", (event) => {
				if (!live) return undefined;
				session.authority = onInput(session.authority, event.source, event.streamingBehavior);
				return undefined;
			});

			pi.on("message_start", (event) => {
				if (!live) return undefined;
				const message = event.message as { role?: string; customType?: string; content?: unknown; details?: unknown };
				if (message.role === "user") {
					const human = session.authority.queue[0] === true;
					session.authority = onUserMessage(session.authority, messageText(message.content));
					if (human) run({ type: "woken" });
					return undefined;
				}
				const record = session.life.record;
				if (message.role === "custom" && message.customType === "timer" && isActive(record)) {
					const createdAt = (message.details as { createdAt?: unknown } | undefined)?.createdAt;
					if (typeof createdAt === "number" && createdAt >= record.startedAt) run({ type: "woken" });
				}
				return undefined;
			});

			pi.on("turn_end", (event) => {
				if (!live) return undefined;
				run({ type: "turn-end", stopReason: (event.message as { stopReason?: string }).stopReason });
				return undefined;
			});

			pi.on("agent_before_settle", (event, extensionCtx) => {
				if (!live) return undefined;
				session.authority = closeAuthority();
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
				session.authority = closeAuthority();
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
				commands: () => pi.getCommands(),
				canDefineObjective: () => pi.getActiveTools().includes(GOAL_SET_TOOL),
				woken: () => {
					run({ type: "woken" });
				},
				waiting: () => isWaiting(session.life),
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
				executionMode: "sequential",
				exposure: "model-only",
				parameters: Type.Object({
					evidence: Type.String({
						description: "Which commands ran in this goal and what they showed, proving the objective holds now",
					}),
				}),
				execute: (_id, params, signal, onUpdate, extensionCtx) =>
					executeClaim(host, params, signal, onUpdate, extensionCtx),
			});

			pi.registerTool({
				name: GOAL_SET_TOOL,
				label: "Goal Set",
				description: GOAL_SET_DESCRIPTION,
				executionMode: "sequential",
				exposure: "model-only",
				parameters: Type.Object({
					action: StringEnum(["create", "edit", "pause", "resume", "clear"] as const),
					objective: Type.Optional(Type.String({ description: OBJECTIVE_DESCRIPTION })),
				}),
				execute: async (_id, params, _signal, _onUpdate, extensionCtx) =>
					executeGoalSet(host, params as GoalSetParams, extensionCtx),
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
								content: checkCommandChangedText(updated),
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
