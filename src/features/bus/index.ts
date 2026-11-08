import { randomUUID } from "node:crypto";
import { type ExtensionContext, formatSize, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { defineFeature, type FeatureContext } from "../../core/feature.ts";
import { registerCommands } from "./commands.ts";
import { controlAction, controlAllowed, scheduleForcedClose } from "./control.ts";
import { renderDigest, renderOpenState, truncate } from "./digest.ts";
import {
	adoptOwner,
	busLabels,
	controlPolicyOf,
	defaultName,
	deleteIdentityEnv,
	type LaunchEnv,
	readLaunchEnv,
	wakePolicyOf,
} from "./identity.ts";
import { BusNode, type PeerGone, type SendInit } from "./node.ts";
import { ExpectedExits, lapseNotice, peerGoneNotice, peerGoneWakes } from "./notices.ts";
import type { Envelope, PeerRecord, PendingQuestion, ProbeResult, SendResult } from "./protocol.ts";
import { BUS_PROMPT } from "./prompt.ts";
import type { QueuedDigest } from "./queue.ts";
import { type BusDirs, busDirs, sessionTag } from "./registry.ts";
import { BusStore, prepareHistory, type StoreSnapshot } from "./store.ts";
import {
	type ActionHost,
	BUS_TOOL_DESCRIPTION,
	BUS_TOOL_SNIPPET,
	type BusToolInput,
	busToolSchema,
	runToolAction,
	statusText,
} from "./tool.ts";

export const DIGEST_TYPE = "pi-bus";
export const STATE_TYPE = "pi-bus-state";
const DIGEST_DEBOUNCE_MS = 1_200;
const MAX_SAVED_SESSIONS = 8;

export interface BusService {
	/** Environment values read once at the first load in this process. Identity keys are gone from `process.env`. */
	readonly launch: Readonly<LaunchEnv>;
	readonly owner: string;
	readonly started: boolean;
	/** Throw when the node is not started. */
	readonly name: string;
	readonly instanceId: string;
	readonly labels: Readonly<Record<string, string>>;
	resolve(selector: string): PeerRecord[];
	watch(peer: PeerRecord | string): boolean;
	unwatch(instanceId: string): void;
	/**
	 * The next exit notice of this watched owner for one of `reasons` starts no run. No `reasons` means any.
	 * The notice still wakes when the peer owed answers. Returns a cancel.
	 */
	expectExit(owner: string, reasons?: readonly PeerGone["reason"][]): () => void;
	probe(selector: string): Promise<ProbeResult[]>;
	send(to: string, init: SendInit): Promise<SendResult>;
	sendTo(peer: PeerRecord, init: SendInit): Promise<SendResult>;
	onPeerGone(handler: (event: PeerGone) => void): () => void;
	onReady(handler: (event: BusReady) => void): () => void;
	/** Called at each node start. A result replaces the launch env name, labels, and control token. */
	setSpawnIdentity(provider: SpawnIdentityProvider): void;
}

export interface SpawnIdentity {
	name?: string | undefined;
	/** Includes `role` and `parent` when the instance was spawned. */
	labels: Readonly<Record<string, string>>;
	controlToken?: string | undefined;
}

export type SpawnIdentityProvider = (extCtx: ExtensionContext) => SpawnIdentity | undefined;

export interface BusReady {
	instanceId: string;
	name: string;
	owner: string;
}

declare module "../../core/services.ts" {
	interface ServiceMap {
		bus: BusService;
	}
}

declare module "../../core/events.ts" {
	interface PimonEvents {
		"bus:ready": BusReady;
		"bus:peer-gone": PeerGone;
		/** Sent on start, on each change, and at each session start. `{}` means no endpoint. */
		"bus:identity": { name?: string; role?: string };
	}
}

const configSchema = Type.Object(
	{ historyRetentionDays: Type.Integer({ minimum: 0, default: 30 }) },
	{ additionalProperties: false },
);

interface Identity {
	launch: LaunchEnv;
	owner: string;
}

/** Kept per session across reload, so unread state and undelivered digests survive it. */
interface SavedSession extends StoreSnapshot {
	requeue: Envelope[];
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map((block: unknown) =>
			block && typeof block === "object" && (block as { type?: string }).type === "text"
				? textOf((block as { text?: unknown }).text)
				: "",
		)
		.join("\n");
}

function collapse(value: string): string {
	const lines = value.split("\n");
	if (lines.length <= 10 && value.length <= 1_400) return value;
	return `${lines.slice(0, 10).join("\n")}\n\n[pi_bus output collapsed: ${lines.length} lines, ${formatSize(Buffer.byteLength(value, "utf8"))}. ${keyHint("app.tools.expand", "to expand")}]`;
}

class BusRuntime implements ActionHost {
	readonly dirs: BusDirs;
	readonly wakePolicy;
	private readonly controlPolicy;
	private extCtx: ExtensionContext | undefined;
	private current: BusNode | undefined;
	private starting: Promise<void> | undefined;
	private currentStore: BusStore;
	private sessionKey: string | undefined;
	private queue: QueuedDigest = { envelopes: [], notices: [] };
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly undelivered = new Map<string, Envelope[]>();
	/** Digest ids in the context of the current run. Read once a completed assistant message follows. */
	private inRun: string[] = [];
	private shuttingDown = false;
	private cancelClose: (() => void) | undefined;
	private lastIdentity: string | undefined;
	private identitySent = false;
	private readonly ctx: FeatureContext<{ historyRetentionDays: number }>;
	readonly identity: Identity;
	private readonly sessions: Map<string, SavedSession>;
	spawnIdentity: SpawnIdentityProvider | undefined;
	private controlToken: string | undefined;
	/** A spawned instance obeys only its token. A resumed one has none, so its parent falls back to kill. */
	private tokenRequired = false;

	constructor(
		ctx: FeatureContext<{ historyRetentionDays: number }>,
		identity: Identity,
		sessions: Map<string, SavedSession>,
	) {
		this.ctx = ctx;
		this.identity = identity;
		this.sessions = sessions;
		this.dirs = busDirs(ctx.agentDir, identity.launch.dir);
		this.wakePolicy = wakePolicyOf(identity.launch);
		this.controlPolicy = controlPolicyOf(identity.launch);
		this.currentStore = new BusStore(undefined, this.dirs);
		this.controlToken = identity.launch.controlToken;
	}

	private launchFor(extCtx: ExtensionContext): {
		launch: LaunchEnv;
		labels: Record<string, string>;
		spawned: boolean;
	} {
		const launch = this.identity.launch;
		const spawned = this.spawnIdentity?.(extCtx);
		if (!spawned) return { launch, labels: busLabels(launch, extCtx.cwd), spawned: false };
		return {
			launch: {
				...launch,
				name: spawned.name,
				role: spawned.labels["role"],
				parent: spawned.labels["parent"],
				controlToken: spawned.controlToken,
			},
			labels: { ...spawned.labels, cwd: extCtx.cwd },
			spawned: true,
		};
	}

	get events(): FeatureContext<unknown>["events"] {
		return this.ctx.events;
	}

	get started(): BusNode | undefined {
		return this.current?.isStarted ? this.current : undefined;
	}

	node(): BusNode {
		const node = this.started;
		if (!node) throw new Error("pi-bus is not started yet.");
		return node;
	}

	store(): BusStore {
		return this.currentStore;
	}

	markRead(ids: Iterable<string>): void {
		const set = new Set(ids);
		this.currentStore.markRead(set);
		this.queue.envelopes = this.queue.envelopes.filter((envelope) => !set.has(envelope.id));
	}

	changed(): void {
		const node = this.started;
		if (!node || this.shuttingDown) return;
		this.guard(() => {
			if (this.extCtx?.hasUI) this.extCtx.ui.setStatus("pi-bus", statusText(this, node));
		});
		this.emitIdentity(false);
	}

	/** Emits only when the name or role changed, unless forced. */
	emitIdentity(force: boolean): void {
		if (this.shuttingDown) return;
		const node = this.started;
		const role = node?.labels["role"];
		const identity = node ? { name: node.name, ...(role ? { role } : {}) } : {};
		const key = JSON.stringify(identity);
		if (!force && key === this.lastIdentity) return;
		this.lastIdentity = key;
		this.identitySent = true;
		this.ctx.events.emit("bus:identity", identity);
	}

	/** A listener that keeps the last identity needs it again after a session replacement or a failed start. */
	async startSession(extCtx: ExtensionContext): Promise<void> {
		this.identitySent = false;
		await this.start(extCtx);
		if (!this.identitySent) this.emitIdentity(true);
	}

	bind(extCtx: ExtensionContext): void {
		this.extCtx = extCtx;
	}

	/** A stale context throws after session replacement. */
	private guard(action: () => void): void {
		try {
			action();
		} catch (error) {
			this.debug(`context call failed: ${(error as Error).message}`);
		}
	}

	private notify(text: string, level: "info" | "warning" | "error"): void {
		this.guard(() => {
			if (this.extCtx?.hasUI) this.extCtx.ui.notify(text, level);
		});
	}

	private debug(message: string): void {
		if (this.identity.launch.debug === "1") process.stderr.write(`[pi-bus] ${message}\n`);
	}

	async start(extCtx: ExtensionContext): Promise<void> {
		this.bind(extCtx);
		this.shuttingDown = false;
		if (this.started) return;
		if (this.starting) return this.starting;
		this.starting = this.startNode(extCtx).finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async startNode(extCtx: ExtensionContext): Promise<void> {
		const sessionFile = extCtx.sessionManager.getSessionFile();
		this.sessionKey = sessionFile ?? `memory:${extCtx.sessionManager.getSessionId()}`;
		const saved = this.sessions.get(this.sessionKey);
		this.sessions.delete(this.sessionKey);
		if (saved) {
			this.currentStore = BusStore.restore(sessionFile, this.dirs, saved);
		} else {
			this.currentStore = new BusStore(sessionFile, this.dirs);
			this.currentStore.load();
		}

		const { owner } = this.identity;
		let node: BusNode;
		try {
			const { launch, labels, spawned } = this.launchFor(extCtx);
			this.controlToken = launch.controlToken;
			this.tokenRequired = spawned;
			node =
				this.current ??
				new BusNode({
					owner,
					desiredName: defaultName(launch, sessionFile, owner),
					session: sessionTag(sessionFile),
					labels,
					cwd: extCtx.cwd,
					sessionFile,
					model: extCtx.model?.id,
					dirs: this.dirs,
					onEnvelope: (envelope) => this.onEnvelope(envelope),
					onPeerGone: (event) => this.onPeerGone(event),
					onPeersChanged: () => this.changed(),
					onPendingOverdue: (pending) => this.onPendingOverdue(pending),
					log: (message) => this.debug(message),
				});
			this.current = node;
			const { removed } = prepareHistory(this.dirs, this.ctx.config.historyRetentionDays, {
				keep: this.currentStore.historyFile,
			});
			if (removed > 0) this.debug(`removed ${removed} old history file(s)`);
			await node.start();
		} catch (error) {
			this.current = undefined;
			this.ctx.log.error("bus failed to start", error);
			this.notify(`pi-bus failed to start: ${(error as Error).message}`, "error");
			return;
		}
		for (const envelope of saved?.requeue ?? []) {
			if (this.currentStore.unread.has(envelope.id)) this.queueForDigest(envelope);
		}
		this.ctx.events.emit("bus:ready", { instanceId: node.instanceId, name: node.name, owner: node.owner });
		this.lastIdentity = undefined;
		this.changed();
	}

	async stop(): Promise<void> {
		// No flush here: a digest would start a run on a session that is being replaced.
		this.shuttingDown = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.cancelClose?.();
		this.cancelClose = undefined;
		if (this.sessionKey) {
			const requeue = [...this.queue.envelopes, ...[...this.undelivered.values()].flat()];
			this.sessions.set(this.sessionKey, { ...this.currentStore.snapshot(), requeue });
			while (this.sessions.size > MAX_SAVED_SESSIONS) {
				const oldest = this.sessions.keys().next().value;
				if (oldest === undefined) break;
				this.sessions.delete(oldest);
			}
		}
		this.queue = { envelopes: [], notices: [] };
		this.undelivered.clear();
		this.inRun = [];
		await this.starting;
		await this.current?.stop();
	}

	private mayWake(envelope: Envelope): boolean {
		if (this.wakePolicy === "all") return true;
		if (this.wakePolicy === "none") return false;
		const parent = this.current?.labels["parent"];
		return Boolean(parent) && (envelope.from.owner === parent || envelope.from.instanceId === parent);
	}

	private onEnvelope(raw: Envelope): void {
		const envelope = this.currentStore.addInbound(raw);
		if (raw.kind === "control") {
			this.handleControl(raw);
			this.changed();
			return;
		}
		if (envelope.kind !== "event") {
			this.notify(
				`bus: ${envelope.from.name} sent ${envelope.kind}`,
				envelope.priority === "urgent" ? "warning" : "info",
			);
		}
		if (envelope.wake === "never" || !this.mayWake(envelope)) {
			this.changed();
			return;
		}
		this.queueForDigest(envelope);
	}

	private handleControl(envelope: Envelope): void {
		const node = this.current;
		const action = controlAction(envelope);
		const allowed = controlAllowed(
			envelope,
			this.controlPolicy,
			this.controlToken,
			node?.labels["parent"],
			this.tokenRequired,
		);
		if (!allowed) {
			this.notify(`bus: refused ${action} from ${envelope.from.name}`, "warning");
			void node?.tryReply(envelope.from, {
				body: `Refused control request "${action}": not permitted by this instance.`,
				kind: "result",
				wake: "now",
				corrId: envelope.id,
				threadId: envelope.threadId,
			});
			return;
		}
		if (action === "shutdown" || action === "close") {
			this.notify(`bus: ${envelope.from.name} asked this instance to close`, "info");
			// No digest: a run would delay the exit. pi defers the shutdown until idle.
			this.guard(() => this.extCtx?.shutdown());
			if (this.cancelClose) return;
			this.cancelClose = scheduleForcedClose({
				retired: () => this.shuttingDown,
				shutdown: () => this.guard(() => this.extCtx?.shutdown()),
				isIdle: () => {
					if (!this.extCtx) throw new Error("no context");
					return this.extCtx.isIdle();
				},
				exit: async () => {
					try {
						await this.current?.stop();
					} catch {
						// Exiting anyway.
					}
					this.debug(`forced exit after close request from ${envelope.from.name}`);
					process.exit(0);
				},
			});
			return;
		}
		if (action === "interrupt" || action === "abort") {
			this.notify(`bus: ${envelope.from.name} interrupted this instance`, "warning");
			this.guard(() => this.extCtx?.abort());
			this.queueForDigest(undefined, `${envelope.from.name} interrupted you: ${truncate(envelope.body, 200)}`);
			return;
		}
		this.queueForDigest(undefined, `Unknown control request "${action}" from ${envelope.from.name}.`);
	}

	readonly expectedExits = new ExpectedExits();

	unwatch(instanceId: string): void {
		const node = this.node();
		const watched = node.watching().find((peer) => peer.instanceId === instanceId);
		if (watched?.owner) this.expectedExits.clear(watched.owner);
		node.unwatch(instanceId);
	}

	private onPeerGone(event: PeerGone): void {
		this.ctx.events.emit("bus:peer-gone", event);
		const node = this.current;
		const notice = peerGoneNotice(event);
		const expected = event.record.owner ? this.expectedExits.take(event.record.owner, event.reason) : false;
		const wakes =
			node !== undefined &&
			peerGoneWakes(event, {
				selfOwner: node.owner,
				selfInstanceId: node.instanceId,
				parent: node.labels["parent"],
				policy: this.wakePolicy,
				unansweredInbound: this.currentStore.unansweredInbound(),
			});
		if (wakes && expected && event.pending.length === 0) this.addWithoutWake(notice);
		else if (wakes) this.queueForDigest(undefined, notice);
		else this.notify(`bus: ${notice}`, "info");
		this.changed();
	}

	/** Stored now when idle, or after the current turn of a run. */
	private addWithoutWake(notice: string): void {
		this.notify(`bus: ${notice}`, "info");
		this.guard(() =>
			this.ctx.pi.sendMessage(
				{ customType: DIGEST_TYPE, content: notice, display: true, details: { wake: "never", notices: 1 } },
				{ triggerTurn: false },
			),
		);
	}

	private onPendingOverdue(pending: PendingQuestion[]): void {
		for (const entry of pending) this.queueForDigest(undefined, lapseNotice(entry));
		this.changed();
	}

	private queueForDigest(envelope?: Envelope, notice?: string): void {
		if (this.shuttingDown) return;
		if (envelope) this.queue.envelopes.push(envelope);
		if (notice) this.queue.notices.push(notice);
		if (this.timer) return;
		this.timer = setTimeout(() => this.flush(), DIGEST_DEBOUNCE_MS);
		this.timer.unref?.();
	}

	private flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.shuttingDown) return;
		const queued = this.queue;
		this.queue = { envelopes: [], notices: [] };
		if (queued.envelopes.length === 0 && queued.notices.length === 0) return;

		const rendered = renderDigest(this.currentStore, queued);
		if (rendered.text) {
			const digestId = randomUUID();
			this.undelivered.set(digestId, rendered.included);
			this.ctx.wake({
				customType: DIGEST_TYPE,
				content: rendered.text,
				display: true,
				details: {
					digestId,
					wake: "now",
					count: rendered.included.length,
					omitted: rendered.omitted.length,
					notices: queued.notices.length,
					messageIds: rendered.included.map((envelope) => envelope.id),
					threadIds: [...new Set(rendered.included.map((envelope) => envelope.threadId))],
				},
			});
		}
		if (rendered.omitted.length > 0) {
			this.queue.envelopes.unshift(...rendered.omitted);
			this.timer = setTimeout(() => this.flush(), DIGEST_DEBOUNCE_MS);
			this.timer.unref?.();
		}
		this.changed();
	}

	digestSeen(digestId: string | undefined): void {
		if (!digestId) return;
		const envelopes = this.undelivered.get(digestId);
		if (!envelopes) return;
		this.undelivered.delete(digestId);
		this.inRun.push(...envelopes.map((envelope) => envelope.id));
	}

	assistantCompleted(): void {
		if (this.inRun.length === 0) return;
		this.currentStore.markRead(this.inRun);
		this.inRun = [];
		this.changed();
	}

	runEnded(): void {
		// An aborted or failed run leaves its digests unread. No automatic re-wake.
		this.inRun = [];
	}

	openState(): string | undefined {
		const node = this.started;
		return renderOpenState(
			this.currentStore.unread.size,
			node?.pendingQuestions() ?? [],
			this.currentStore.unansweredInbound(),
		);
	}

	setState(state: "busy" | "idle", activity?: string): void {
		this.started?.setState(state, activity);
		this.changed();
	}

	service(): BusService {
		return createService(this);
	}
}

function createService(runtime: BusRuntime): BusService {
	const { launch, owner } = runtime.identity;
	return {
		launch,
		owner,
		get started() {
			return runtime.started !== undefined;
		},
		get name() {
			return runtime.node().name;
		},
		get instanceId() {
			return runtime.node().instanceId;
		},
		get labels() {
			return runtime.node().labels;
		},
		resolve: (selector) => runtime.node().resolve(selector),
		watch: (peer) => runtime.node().watch(peer),
		unwatch: (instanceId) => runtime.unwatch(instanceId),
		expectExit: (owner, reasons) => runtime.expectedExits.expect(owner, reasons),
		probe: (selector) => runtime.node().probe(selector),
		send: (to, init) => runtime.node().send(to, init),
		sendTo: (peer, init) => runtime.node().sendTo(peer, init),
		onPeerGone: (handler) => runtime.events.on("bus:peer-gone", handler),
		onReady: (handler) => runtime.events.on("bus:ready", handler),
		setSpawnIdentity: (provider) => {
			runtime.spawnIdentity = provider;
		},
	};
}

export const bus = defineFeature({
	id: "bus",
	description: "Local messaging between pi instances on this host: the pi_bus tool, digests, and presence",
	defaultEnabled: true,
	configSchema,
	setup(ctx) {
		const identity = ctx.reloadState<Identity>("identity", 1, () => {
			const launch = readLaunchEnv(process.env);
			deleteIdentityEnv(process.env);
			return { launch, owner: adoptOwner(launch) };
		});
		const sessions = ctx.reloadState("sessions", 2, () => new Map<string, SavedSession>());
		const runtime = new BusRuntime(ctx, identity, sessions);
		const pi = ctx.pi;

		ctx.promptSection({ name: "bus", requiresTools: ["pi_bus"], render: () => BUS_PROMPT });

		const renderer: Parameters<typeof pi.registerMessageRenderer>[1] = (message, { expanded }, theme) => {
			const content = textOf(message.content);
			const details = message.details as { wake?: string; count?: number; notices?: number } | undefined;
			const title = theme.fg("toolTitle", theme.bold("pi_bus"));
			const wake = details?.wake ? theme.fg("muted", ` ${details.wake}`) : "";
			const count = details?.count
				? theme.fg("dim", ` · ${details.count} message${details.count === 1 ? "" : "s"}`)
				: "";
			const notices = details?.notices
				? theme.fg("dim", ` · ${details.notices} notice${details.notices === 1 ? "" : "s"}`)
				: "";
			const body = expanded ? content : collapse(content);
			return new Text(`${title}${wake}${count}${notices}\n${body}`, 1, 1, (value) =>
				theme.bg("customMessageBg", value),
			);
		};
		pi.registerMessageRenderer(DIGEST_TYPE, renderer);
		pi.registerMessageRenderer(STATE_TYPE, renderer);

		pi.registerTool({
			name: "pi_bus",
			label: "Pi Bus",
			description: BUS_TOOL_DESCRIPTION,
			promptSnippet: BUS_TOOL_SNIPPET,
			parameters: busToolSchema,
			prepareArguments(args) {
				if (!args || typeof args !== "object") return args as never;
				const input = args as { wake?: unknown };
				return (input.wake === "next-turn" ? { ...input, wake: "now" } : args) as never;
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) return new Text(theme.fg("muted", "running..."), 0, 0);
				const value = textOf(result.content);
				return new Text(expanded ? value : collapse(value), 0, 0);
			},
			async execute(_toolCallId, params, _signal, _onUpdate, extensionCtx) {
				runtime.bind(extensionCtx);
				const result = await runToolAction(runtime, params as BusToolInput);
				return { content: [{ type: "text", text: result.text }], details: result.details };
			},
		});

		registerCommands(pi, runtime);

		ctx.onSessionStart(async (_event, extensionCtx) => {
			await runtime.startSession(extensionCtx);
		});
		ctx.onSessionShutdown(async () => {
			await runtime.stop();
		});

		// pi skips session_start on an SDK reload without UI bindings.
		pi.on("before_agent_start", async (_event, extensionCtx) => {
			if (!runtime.started) await runtime.start(extensionCtx);
		});

		pi.on("message_end", (event) => {
			const message = event.message as { role?: string; customType?: string; details?: { digestId?: string } };
			if (message.role !== "custom" || message.customType !== DIGEST_TYPE) return;
			runtime.digestSeen(message.details?.digestId);
		});

		pi.on("turn_end", (event) => {
			const message = event.message as { role?: string; stopReason?: string };
			if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") return;
			runtime.assistantCompleted();
		});

		pi.on("agent_start", (_event, extensionCtx) => {
			runtime.bind(extensionCtx);
			runtime.setState("busy");
		});
		pi.on("agent_end", (_event, extensionCtx) => {
			runtime.bind(extensionCtx);
			runtime.runEnded();
			runtime.setState("idle");
		});
		pi.on("tool_execution_start", (event) => {
			runtime.setState("busy", event.toolName);
		});

		pi.on("session_compact", () => {
			const text = runtime.openState();
			if (!text) return;
			pi.sendMessage({ customType: STATE_TYPE, content: text, display: true }, { triggerTurn: false });
		});

		return runtime.service();
	},
});
