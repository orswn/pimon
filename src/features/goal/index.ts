import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CustomMessageEntryDraft, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createProcessRunner, type ExecFn } from "../../core/exec.ts";
import { defineFeature, type WakeMessage } from "../../core/feature.ts";
import { clockTime } from "../background/timers.ts";
import { checkOnlyCall, formatOutcome, type NotifyRequest } from "../notify/index.ts";
import { adjudicateWithCheck, adjudicateWithModel, type ModelResponse, type Usage } from "./adjudicate.ts";
import { buildEvidence } from "./evidence.ts";
import {
	CONDITION_MESSAGE,
	CONTINUE_MESSAGE,
	type Effect,
	goalDetails,
	initialLifecycle,
	type Lifecycle,
	type LifecycleInput,
	START_MESSAGE,
	step,
} from "./lifecycle.ts";
import {
	CHECK_CHANGED_TEXT,
	conditionChangedText,
	continuationText,
	rejectionHint,
	stalePauseText,
	startText,
} from "./policy.ts";
import { GOAL_PROMPT } from "./prompt.ts";
import {
	achieve,
	clear,
	countRejection,
	createGoal,
	describe,
	exceededBudget,
	type GoalRecord,
	isActive,
	latestFromEntries,
	pause,
	type PauseReason,
	resume,
	setCheck,
	validateCondition,
} from "./state.ts";
import { expandGoalTemplate, goalTemplateCompletions } from "./template.ts";

const ENTRY_TYPE = "goal";
const CLAIM_TOOL = "goal_done";
const NO_GOAL = "No goal is active.";
export const NO_TIMER_WARNING = "The active goal has no armed timer. Run /goal resume to continue it.";
const SESSION_ENDED_TEXT =
	"The session was reloaded or ended while this claim was adjudicated. The verdict was discarded.";
const ADJUDICATION_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 15 * 60_000;

export const CLAIM_DESCRIPTION =
	"Claim that the active goal's completion condition is met. An independent check runs before the claim is accepted. Must be the only tool call in its message.";

export interface GoalStatePayload {
	state?: GoalRecord["state"];
	turns?: number;
	/** Epoch ms of the earliest armed timer of this session. */
	timerDueAt?: number;
}

export interface GoalFeatureOptions {
	/** Runs check commands. Tests inject a recorder. */
	exec?: ExecFn;
	/** Upper bound of one model adjudication. Tests shorten it. */
	modelTimeoutMs?: number;
}

const STOP_VERBS = new Set(["clear", "stop", "cancel", "pause", "resume"]);

/** A short argument that holds a verb word is likely a mistyped verb, such as "/goal l resume". */
export function typoVerb(input: string): string | undefined {
	const words = input.split(/\s+/).filter(Boolean);
	if (words.length > 3) return undefined;
	return words.find((word) => STOP_VERBS.has(word));
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

type Text = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
const text = (value: string, details: Record<string, unknown> = {}): Text => ({
	content: [{ type: "text", text: value }],
	details,
});

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

			let life: Lifecycle = initialLifecycle();
			let ui: ExtensionContext | undefined;
			let sessionId: string | undefined;
			// Cancels the adjudication of the current goal: check command and model call.
			let cancel: AbortController | undefined;
			// A later command wins over an earlier one that is still awaiting.
			let operation = 0;
			let claimInFlight = false;

			const notice = (message: string, level: "info" | "warning" | "error") => {
				try {
					if (ui?.hasUI) ui.ui.notify(message, level);
				} catch {
					// A context from a replaced session can no longer show notices.
				}
			};

			const see = (extensionCtx: ExtensionContext) => {
				ui = extensionCtx;
				sessionId = extensionCtx.sessionManager.getSessionId();
			};

			/** Armed timers and fired timers that wait for the next runtime bind. Both still wake this session. */
			const timerArmed = () =>
				sessionId !== undefined && (timers.armed(sessionId).length > 0 || timers.pending(sessionId).length > 0);
			// Set while the goal cancels its own timers, so that cancel raises no warning.
			let releasing = false;

			// TODO(okka): remove when the statusline moves into pimon.
			const publish = () => {
				const record = life.record;
				const payload: GoalStatePayload = record ? { state: record.state, turns: record.turns } : {};
				const due = sessionId === undefined ? [] : timers.armed(sessionId).map((timer) => timer.dueAt);
				if (record && due.length > 0) payload.timerDueAt = Math.min(...due);
				pi.events.emit("goal:state", payload);
			};

			/** A goal that ends, pauses, or is replaced takes the timers set since it started with it. */
			const releaseTimers = (previous: GoalRecord | undefined, next: GoalRecord | undefined) => {
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
				if (!live || payload.sessionId !== sessionId) return;
				publish();
				if (releasing || !isActive(life.record) || timerArmed() || !isIdle()) return;
				notice(NO_TIMER_WARNING, "warning");
			});

			const goalTimerLines = (record: GoalRecord | undefined): string[] => {
				if (!isActive(record) || sessionId === undefined) return [];
				return timers
					.armed(sessionId)
					.filter((timer) => timer.createdAt >= record.startedAt)
					.map((timer) => `timer ${timer.name}: fires at ${clockTime(timer.dueAt)}. Reason: ${timer.reason}`);
			};

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
				const previous = life.record;
				life = { ...life, record: next };
				releaseTimers(previous, next);
				publish();
				return true;
			};

			const wake = (message: WakeMessage) => ctx.wake(message);
			// Bumped on shutdown, so an adjudication that outlives its session writes nothing.
			let sessionEpoch = 0;
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
				cancel?.abort();
				cancel = undefined;
				notice(`Goal paused: ${reason}. ${detail}`, "warning");
				if (phone) report({ kind: "paused", title: "pi goal: paused", message: `Goal paused: ${reason}`, detail });
			};

			/** Runs one reducer step and its effects. Returns the drafts for a before-settle boundary. */
			const run = (input: LifecycleInput, extensionCtx?: ExtensionContext): CustomMessageEntryDraft[] => {
				if (extensionCtx) see(extensionCtx);
				const previous = life.record;
				const result = step(life, input, Date.now());
				life = result.state;
				releaseTimers(previous, life.record);
				const drafts: CustomMessageEntryDraft[] = [];
				for (const effect of result.effects) apply(effect, drafts);
				if (life.record !== previous) publish();
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
				cancel?.abort();
				cancel = undefined;
				see(extensionCtx);
				const found = latestFromEntries(extensionCtx.sessionManager.getBranch(), ENTRY_TYPE);
				run({ type: "recover", found, kind, timerArmed: timerArmed() }, extensionCtx);
				publish();
			};

			/** Stops goal-owned work only. The running step of the model is never interrupted. */
			const stopWork = () => {
				cancel?.abort();
				cancel = undefined;
			};

			const markTerminal = () => run({ type: "terminal" });

			ctx.promptSection({ name: "goal", render: () => GOAL_PROMPT });

			// TODO(okka): remove when the statusline moves into pimon.
			pi.events.on("goal:refresh", () => {
				if (live) publish();
			});

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
				sessionEpoch++;
				live = false;
				cancel?.abort();
				cancel = undefined;
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

			const callModel = async (
				extensionCtx: ExtensionContext,
				prompt: string,
				signal?: AbortSignal,
			): Promise<ModelResponse> => {
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
				async execute(_id, params, signal, onUpdate, extensionCtx) {
					see(extensionCtx);
					const current = life.record;
					if (!isActive(current)) return text(NO_GOAL);
					if (claimInFlight) return text("A claim is already being adjudicated. Wait for its verdict.");

					claimInFlight = true;
					const goalId = current.id;
					const generation = current.generation;
					try {
						onUpdate?.(text("adjudicating the claim"));
						const stops: AbortSignal[] = [];
						if (signal) stops.push(signal);
						if (cancel) stops.push(cancel.signal);
						// A check is bounded by its own timeout. The short cap is for a hung model call only.
						const checkSignal = AbortSignal.any(stops);
						const modelSignal = AbortSignal.any([
							...stops,
							AbortSignal.timeout(options.modelTimeoutMs ?? ADJUDICATION_TIMEOUT_MS),
						]);
						const epoch = sessionEpoch;

						const outcome = current.check
							? await adjudicateWithCheck({
									check: current.check,
									exec,
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
						if (epoch !== sessionEpoch) return withUsage(text(SESSION_ENDED_TEXT));

						// /goal-check, pause, clear, or a new goal may have replaced the record during the verdict.
						const fresh = life.record;
						if (!fresh || fresh.id !== goalId || fresh.generation !== generation || fresh.state !== "active") {
							if (isActive(fresh) && fresh.id === goalId) return withUsage(text(CHECK_CHANGED_TEXT));
							markTerminal();
							return withUsage({
								...text(
									`The goal changed while this claim was adjudicated, so the verdict was discarded. ${stalePauseText()}`,
								),
								terminate: true,
							});
						}

						if (outcome.verdict === "accepted") {
							if (!save(achieve(fresh, true, outcome.reason, Date.now())))
								return withUsage(
									text(
										"The claim was accepted by adjudication, but the achieved state could not be saved. Keep the goal active and retry the claim after the persistence failure is resolved.",
									),
								);
							cancel?.abort();
							cancel = undefined;
							notice(`Goal achieved: ${outcome.reason}`, "info");
							report({ kind: "done", title: "pi goal: achieved", message: "Goal achieved", detail: outcome.reason });
							markTerminal();
							return withUsage({ ...text(`Goal accepted (${outcome.via}): ${outcome.reason}`), terminate: true });
						}

						if (outcome.verdict === "unverified") {
							if (!save(pause(fresh, "unverified", outcome.reason, Date.now())))
								return withUsage(
									text(
										"The claim could not be verified, and the pause state could not be saved. Keep working or report the persistence failure with notify kind=blocked.",
									),
								);
							announceStop("unverified", outcome.reason, true);
							markTerminal();
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
							if (!save(pause(rejected, budget.reason, budget.detail, Date.now())))
								return withUsage(
									text(
										"The rejection budget was exhausted, but the pause state could not be saved. Report the persistence failure with notify kind=blocked.",
									),
								);
							announceStop(budget.reason, `${budget.detail} ${outcome.reason}`, true);
							markTerminal();
							return withUsage({
								...text(`Claim rejected: ${outcome.reason}\n${budget.detail}\nStop here.`),
								terminate: true,
							});
						}
						if (!save(rejected))
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
						claimInFlight = false;
					}
				},
			});

			/** Kickoff never saves an active goal it cannot start, and never interrupts a running step. */
			const kickoff = (next: GoalRecord, extensionCtx: ExtensionContext, headline: string) => {
				if (!extensionCtx.model) {
					extensionCtx.ui.notify("No model is selected, so a goal cannot run.", "error");
					return;
				}
				// The evidence boundary is stamped when the start message lands, so a late tool result
				// of the replaced goal never counts as proof for this one.
				const started = { ...next, evidenceFrom: undefined };
				if (!save(started)) return;
				life = { ...life, cycle: { ...life.cycle, stalls: 0 } };
				cancel?.abort();
				cancel = new AbortController();
				extensionCtx.ui.notify(`${headline} ${next.condition}`, "info");
				wake({
					customType: START_MESSAGE,
					content: startText(started, headline),
					display: true,
					details: goalDetails(started),
				});
			};

			const stopNotice = (extensionCtx: ExtensionContext, done: string, idle: string) =>
				extensionCtx.isIdle() ? idle : `${done} The current step finishes first. Press Esc to stop it now.`;

			const confirmed = async (extensionCtx: ExtensionContext, title: string, message: string) => {
				const token = operation;
				const answer = await extensionCtx.ui.confirm(title, message);
				return answer && token === operation;
			};

			const clip = (condition: string) => (condition.length > 300 ? `${condition.slice(0, 300)}…` : condition);

			pi.registerCommand("goal", {
				description: "Set an autonomous goal, or inspect, pause, resume, or clear one",
				getArgumentCompletions: (prefix) => goalTemplateCompletions(prefix, pi.getCommands()),
				async handler(args, extensionCtx) {
					see(extensionCtx);
					const input = (args ?? "").trim();
					const record = life.record;
					if (!input) {
						extensionCtx.ui.notify([describe(record, Date.now()), ...goalTimerLines(record)].join("\n"), "info");
						return;
					}
					operation++;
					if (input === "clear" || input === "stop" || input === "cancel") {
						if (!record || record.state === "cleared") {
							extensionCtx.ui.notify("No goal set.", "info");
							return;
						}
						if (!save(clear(record, Date.now()))) return;
						stopWork();
						extensionCtx.ui.notify(
							stopNotice(extensionCtx, "Goal cleared.", `Goal cleared: ${record.condition}`),
							"info",
						);
						return;
					}
					if (input === "pause") {
						if (!isActive(record)) {
							extensionCtx.ui.notify("No active goal to pause.", "warning");
							return;
						}
						if (!save(pause(record, "user-input", "you paused it", Date.now()))) return;
						stopWork();
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
						if (isActive(record) && extensionCtx.isIdle() && sessionId !== undefined) {
							const fired = timers.fireNow({ sessionId, createdSince: record.startedAt });
							if (fired === 0) {
								const hint = record.detail && record.rejected > 0 ? rejectionHint(record.detail) : undefined;
								wake({
									customType: CONTINUE_MESSAGE,
									content: continuationText(record, hint),
									display: true,
									details: goalDetails(record),
								});
							}
							extensionCtx.ui.notify(
								fired > 0 ? `Fired ${fired} goal timer(s) now.` : "The goal continues now.",
								"info",
							);
							return;
						}
						const attempt = resume(record, Date.now());
						if (attempt.error || !attempt.record) {
							extensionCtx.ui.notify(attempt.error ?? "Cannot resume.", "warning");
							return;
						}
						kickoff(attempt.record, extensionCtx, "Resuming the goal.");
						return;
					}

					const verb = typoVerb(input);
					if (verb) {
						if (!extensionCtx.hasUI) {
							extensionCtx.ui.notify(`"${input}" looks like /goal ${verb}. Nothing changed.`, "warning");
							return;
						}
						if (!(await confirmed(extensionCtx, "Set this as the goal?", `It looks like /goal ${verb}.`))) return;
					}

					let expanded: ReturnType<typeof expandGoalTemplate>;
					try {
						expanded = expandGoalTemplate(input, pi.getCommands(), (path) => readFileSync(path, "utf8"));
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
					const current = life.record;
					if (
						!verb &&
						extensionCtx.hasUI &&
						(current?.state === "active" || current?.state === "paused") &&
						!(await confirmed(
							extensionCtx,
							"Replace the current goal?",
							`Current: ${clip(current.condition)}\n\nNew: ${clip(expanded.condition.trim())}`,
						))
					)
						return;
					const headline = expanded.template ? `Goal set from /${expanded.template}.` : "Goal set.";
					kickoff(
						createGoal({ condition: expanded.condition, now: Date.now(), id: randomUUID() }),
						extensionCtx,
						headline,
					);
				},
			});

			pi.registerCommand("goal-check", {
				description: "Set the verification command of the goal, or clear it with no argument",
				async handler(args, extensionCtx) {
					see(extensionCtx);
					const command = (args ?? "").trim();
					const record = life.record;
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
