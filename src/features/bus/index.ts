import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type ExtensionContext, formatSize, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { defineFeature, type FeatureContext } from "../../core/feature.ts";
import type {
	ControlEvent,
	LinkEvent,
	MessageEvent,
	PresenceEvent,
	RegisterResult,
	UpdateEvent,
} from "@orswn/a2a-hub-protocol";
import { registerCommands } from "./commands.ts";
import { scheduleForcedClose } from "./control.ts";
import { type QueuedDigest, renderDigest, renderOpenState, truncate } from "./digest.ts";
import { HUB_PROTOCOL, HubClient, HubHttpError } from "./hub/client.ts";
import { HubLink, type LinkStatus, type Registration } from "./hub/link.ts";
import { defaultHubTokenFile, readHubToken } from "./hub/token.ts";
import {
	busLabels,
	controlPolicyOf,
	defaultName,
	deleteIdentityEnv,
	type LaunchEnv,
	readLaunchEnv,
	wakePolicyOf,
} from "./identity.ts";
import { ExpectedExits, lapseNotice, offlineNotice, offlineWakes, openWorkWith } from "./notices.ts";
import {
	AGENTS_CACHE_MS,
	type AgentInfo,
	type BusMessage,
	PENDING_NUDGE_MS,
	shortId,
	withoutAskedTasks,
} from "./protocol.ts";
import { BUS_PROMPT } from "./prompt.ts";
import {
	type ActionHost,
	BUS_TOOL_DESCRIPTION,
	type BusToolInput,
	busToolSchema,
	hubErrorText,
	resolveTargets,
	runToolAction,
	type SelfInfo,
	type SendInit,
	type SendResult,
	sendToAgents,
} from "./tool.ts";

export type { SendInit, SendResult } from "./tool.ts";
export type { AgentInfo, BusMessage } from "./protocol.ts";

export const DIGEST_TYPE = "pi-bus";
export const STATE_TYPE = "pi-bus-state";
/** The last status text of a session, so a restart can restore it. */
export const STATUS_ENTRY = "pimon-bus-status";
const STATUS_TEXT_MAX = 160;
const DIGEST_DEBOUNCE_MS = 1_200;
const COUNTS_DEBOUNCE_MS = 250;
const ARTIFACT_NOTICE_CHARS = 4_000;
/** A drop that heals within this many attempts shows only in the status line. */
const WARN_AFTER_FAILURES = 3;
const MAX_TASK_SENDERS = 500;
const STATE_DEBOUNCE_MS = 500;
const OFFLINE_TIMEOUT_MS = 2_000;
const FIRST_TASK_HOLD_MS = 60_000;
const MAX_SAVED_SESSIONS = 8;
const MAX_SENT_TITLES = 200;
export const NO_HUB_ERROR = "pi_bus: no hub configured. Set features.bus.hub.url in pimon.json.";
export const REPLACED_NOTICE =
	"Another pi process took over this session id. This process no longer receives bus messages.";

export interface BusService {
	/** Environment values read once at the first load in this process. Identity keys are gone from `process.env`. */
	readonly launch: Readonly<LaunchEnv>;
	/** True when this session has a hub client: a url, a usable token, and a session id. The link may be offline. */
	readonly started: boolean;
	/** True while the link to the hub is up. */
	readonly online: boolean;
	/** The session id. Throws before the first session start. */
	readonly id: string;
	readonly name: string;
	readonly labels: Readonly<Record<string, string>>;
	/** The short error that says why the bus cannot work now, or undefined. */
	unavailable(): string | undefined;
	errorText(error: unknown): string;
	agents(includeOffline?: boolean): Promise<AgentInfo[]>;
	agent(id: string): Promise<AgentInfo | undefined>;
	resolve(selector: string): Promise<AgentInfo[]>;
	/** The next offline notice of this agent starts no run, unless work is still open with it. Returns a cancel. */
	expectOffline(agent: string): () => void;
	send(targets: AgentInfo[], init: SendInit): Promise<SendResult>;
	/** Asks a child to finish and exit. The hub accepts it only from the child's parent. */
	close(agent: string): Promise<void>;
	/** Makes an offline hub row for a child before it starts, so its first task can wait in its mailbox. */
	addChild(child: {
		id: string;
		name?: string;
		role?: string;
		labels?: Record<string, string>;
		cwd?: string;
	}): Promise<void>;
	onPresence(handler: (event: PresenceEvent) => void): () => void;
	onUpdate(handler: (event: UpdateEvent) => void): () => void;
	onReady(handler: (event: BusReady) => void): () => void;
	/** Called at each session start. A result replaces the launch env name, role, parent, and labels. */
	setSpawnIdentity(provider: SpawnIdentityProvider): void;
	/** Gets the first task named by the spawn identity. Digests wait until it came, for at most a minute. */
	onFirstTask(handler: (message: BusMessage) => void): void;
}

export interface SpawnIdentity {
	name?: string | undefined;
	role?: string | undefined;
	/** The parent session id. */
	parent?: string | undefined;
	labels: Readonly<Record<string, string>>;
	/** The message id of a first task that is not taken yet. */
	firstTask?: string | undefined;
}

export type SpawnIdentityProvider = (extCtx: ExtensionContext) => SpawnIdentity | undefined;

export interface BusReady {
	id: string;
	name: string;
}

declare module "../../core/services.ts" {
	interface ServiceMap {
		bus: BusService;
	}
}

declare module "../../core/events.ts" {
	interface PimonEvents {
		"bus:ready": BusReady;
		/** An agent with a relation to this session went online or offline. */
		"bus:presence": PresenceEvent;
		/** A task that this session sent changed state. */
		"bus:update": UpdateEvent;
		/** Sent on start, on each change, and at each session start. `{}` means no endpoint. */
		"bus:identity": { name?: string; role?: string };
	}
}

const configSchema = Type.Object(
	{
		hub: Type.Optional(
			Type.Object(
				{ url: Type.Optional(Type.String({ minLength: 1 })), tokenFile: Type.Optional(Type.String({ minLength: 1 })) },
				{ additionalProperties: false },
			),
		),
		// Accepted so an older pimon.json keeps the feature enabled. The hub owns retention now.
		historyRetentionDays: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: false },
);

type BusConfig = { hub?: { url?: string; tokenFile?: string }; historyRetentionDays?: number };

interface Identity {
	launch: LaunchEnv;
}

interface Deadline {
	messageId: string;
	askedAt: number;
	dueAt: number;
	title: string;
	names: string;
}

/** Kept per session across reload, so undelivered digests, titles, and deadlines survive it. */
interface SavedSession {
	queue: BusMessage[];
	notices: string[];
	sent: [string, string][];
	deadlines: Deadline[];
	lastSeq?: number | undefined;
	/** Inbound task id to sender id, so a cancel after a reload obeys the wake policy. */
	taskSenders?: [string, string | undefined][] | undefined;
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

function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

function fromMessage(event: MessageEvent): BusMessage {
	return {
		id: event.messageId,
		threadId: event.contextId,
		taskId: event.taskId,
		from: { id: event.from.agent, name: event.from.name },
		direction: "in",
		kind: event.kind,
		wake: event.wake,
		priority: event.priority,
		subject: event.subject,
		body: event.text,
		data: event.data,
		expectReply: event.expectReply,
		replyTo: event.replyTo,
		taskState: event.taskState,
		createdAt: Date.now(),
	};
}

const WAKING_UPDATE_STATES = new Set([
	"completed",
	"failed",
	"canceled",
	"rejected",
	"input-required",
	"auth-required",
]);

function fromUpdate(event: UpdateEvent): BusMessage | undefined {
	if (!event.messageId || event.text === undefined) return undefined;
	return {
		id: event.messageId,
		threadId: event.contextId,
		taskId: event.taskId,
		from: { id: event.from.agent, name: event.from.name },
		direction: "in",
		kind: event.kind ?? "status",
		wake: WAKING_UPDATE_STATES.has(event.state) ? "now" : "never",
		body: event.text,
		taskState: event.state,
		createdAt: Date.now(),
	};
}

interface Session extends SelfInfo {
	spawned: boolean;
}

/** The newest status entry of this session. A fork copies the entries of its source session; those do not count. */
function savedStatus(extCtx: ExtensionContext): { text: string; send: "restore" } | undefined {
	const id = extCtx.sessionManager.getSessionId();
	const branch = extCtx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== STATUS_ENTRY) continue;
		const data = entry.data as { text?: unknown; session?: unknown } | undefined;
		if (data?.session !== id) continue;
		return typeof data.text === "string" && data.text ? { text: data.text, send: "restore" } : undefined;
	}
	return undefined;
}

class BusRuntime implements ActionHost {
	readonly wakePolicy;
	private readonly controlPolicy;
	private readonly ctx: FeatureContext<BusConfig>;
	readonly identity: Identity;
	private readonly sessions: Map<string, SavedSession>;
	private extCtx: ExtensionContext | undefined;
	private session: Session | undefined;
	private client: HubClient | undefined;
	private link: HubLink | undefined;
	private linkStatus: LinkStatus | undefined;
	private wasOnline = false;
	private warnedOffline = false;
	/** Why this session has no client: a token problem. */
	private setupError: string | undefined;
	private queue: QueuedDigest = { messages: [], notices: [] };
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly undelivered = new Map<string, BusMessage[]>();
	/** Digest ids in the context of the current run. Read once a completed assistant message follows. */
	private inRun: BusMessage[] = [];
	private sentTitles = new Map<string, string>();
	/** Sender of each inbound task in this runtime. A cancel event names only the task. */
	private taskSenders = new Map<string, string | undefined>();
	private deadlines: Deadline[] = [];
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	private shuttingDown = false;
	private cancelClose: (() => void) | undefined;
	private lastIdentity: string | undefined;
	private lastStatus: string | undefined;
	private counts = { unread: 0, awaiting: 0 };
	private countsTimer: ReturnType<typeof setTimeout> | undefined;
	private state: { state: "busy" | "idle"; activity?: string | undefined } = { state: "idle" };
	private sentState: string | undefined;
	private stateTimer: ReturnType<typeof setTimeout> | undefined;
	private agentsCache = new Map<boolean, { at: number; agents: Promise<AgentInfo[]> }>();
	spawnIdentity: SpawnIdentityProvider | undefined;
	firstTaskHandler: ((message: BusMessage) => void) | undefined;
	/** A spawned child waits for this first task before any digest wakes it. */
	private firstTask: { messageId: string; until: number } | undefined;
	/** Status text the hub does not have yet. "restore" is sent only when the hub has no text. */
	private statusText: { text: string; send: "set" | "restore" } | undefined;
	readonly expectedExits = new ExpectedExits();

	constructor(ctx: FeatureContext<BusConfig>, identity: Identity, sessions: Map<string, SavedSession>) {
		this.ctx = ctx;
		this.identity = identity;
		this.sessions = sessions;
		this.wakePolicy = wakePolicyOf(identity.launch);
		this.controlPolicy = controlPolicyOf(identity.launch);
	}

	get events(): FeatureContext<unknown>["events"] {
		return this.ctx.events;
	}

	hubUrl(): string | undefined {
		return this.ctx.config.hub?.url;
	}

	tokenFile(): string {
		const configured = this.ctx.config.hub?.tokenFile;
		return configured
			? resolve(this.ctx.agentDir, expandHome(configured))
			: defaultHubTokenFile(homedir(), resolve(this.ctx.agentDir));
	}

	get started(): boolean {
		return this.client !== undefined && !this.shuttingDown;
	}

	get online(): boolean {
		return this.linkStatus?.state === "online";
	}

	unavailable(): string | undefined {
		if (!this.hubUrl()) return NO_HUB_ERROR;
		if (this.setupError) return `pi_bus: ${this.setupError}`;
		const status = this.linkStatus;
		if (status?.state === "stopped" && status.fatal) return this.fatalText(status);
		if (status?.state === "stopped" && status.reason === "replaced") return `pi_bus: ${REPLACED_NOTICE}`;
		if (!this.client) return "pi_bus: the bus is not started yet.";
		return undefined;
	}

	private fatalText(status: LinkStatus): string {
		if (status.fatal === 401) return `pi_bus: the hub rejected the token in ${this.tokenFile()}.`;
		if (status.fatal === 426)
			return `pi_bus: ${status.reason ?? "protocol mismatch"}. This pimon speaks hub protocol ${HUB_PROTOCOL}. Update pimon or the hub.`;
		if (status.fatal === 403)
			return `pi_bus: the hub refused this host (403): session ${shortId(this.session?.id ?? "")} belongs to another host.`;
		return `pi_bus: the hub refused the link: ${status.reason ?? status.fatal}`;
	}

	hub(): HubClient {
		const reason = this.unavailable();
		if (reason || !this.client) throw new Error(reason);
		return this.client;
	}

	self(): Session {
		if (!this.session) throw new Error("pi_bus: no session yet.");
		return this.session;
	}

	linkText(): string {
		if (!this.hubUrl()) return "no hub";
		if (this.setupError) return "not started";
		const status = this.linkStatus;
		if (!status) return "not started";
		if (status.state === "online") return "online";
		if (status.state === "connecting") return "connecting";
		if (status.state === "retrying")
			return `${this.wasOnline ? "reconnecting" : "hub offline"}${status.reason ? ` (${status.reason})` : ""}`;
		return `stopped${status.reason ? ` (${status.reason})` : ""}`;
	}

	statusLine(): string {
		if (!this.hubUrl()) return "bus: no hub";
		if (this.setupError) return "bus: no token";
		const status = this.linkStatus;
		if (status?.state === "stopped") return status.reason === "closed" ? "bus: offline" : "bus: stopped";
		if (status?.state === "retrying") return this.wasOnline ? "bus: reconnecting" : "bus: hub offline";
		if (status?.state !== "online") return "bus: connecting";
		const parts: string[] = [];
		if (this.counts.unread > 0) parts.push(`${this.counts.unread} unread`);
		if (this.counts.awaiting > 0) parts.push(`${this.counts.awaiting} awaiting reply`);
		return `bus: ${parts.join(", ") || "online"}`;
	}

	agents(includeOffline: boolean): Promise<AgentInfo[]> {
		const cached = this.agentsCache.get(includeOffline);
		if (cached && Date.now() - cached.at < AGENTS_CACHE_MS) return cached.agents;
		const agents = this.hub().agents(includeOffline);
		this.agentsCache.set(includeOffline, { at: Date.now(), agents });
		agents.catch(() => this.agentsCache.delete(includeOffline));
		return agents;
	}

	async markRead(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		const set = new Set(ids);
		this.queue.messages = this.queue.messages.filter((message) => !set.has(message.id));
		try {
			await this.client?.read(ids);
		} catch (error) {
			this.debug(`read failed: ${(error as Error).message}`);
		}
		this.refreshCounts();
	}

	setTopics(topics: string[]): void {
		if (this.session) this.session.topics = topics;
	}

	async setStatus(raw: string): Promise<{ text: string; sent: boolean }> {
		const client = this.hub();
		const text = raw
			.replace(/\s*[\r\n]+\s*/g, " ")
			.trim()
			.slice(0, STATUS_TEXT_MAX)
			.trim();
		const save = () => this.ctx.pi.appendEntry(STATUS_ENTRY, { text, at: Date.now(), session: this.session?.id });
		this.statusText = { text, send: "set" };
		if (this.linkStatus?.state !== "online") {
			save();
			return { text, sent: false };
		}
		try {
			const stored = await client.status(text);
			save();
			if (this.statusText?.text === text) this.statusText = undefined;
			this.agentsCache.clear();
			return { text: stored, sent: true };
		} catch (error) {
			if (error instanceof HubHttpError) {
				this.statusText = undefined;
				throw error;
			}
			save();
			return { text, sent: false };
		}
	}

	/** Sends a status text that was set offline, or restores the saved one when the hub has none. */
	private async flushStatus(): Promise<void> {
		const pending = this.statusText;
		const client = this.client;
		if (!pending || !client || !this.session) return;
		try {
			if (pending.send === "restore") {
				const own = await client.agentInfo(this.session.id);
				if (own.status.text) {
					if (this.statusText === pending) this.statusText = undefined;
					return;
				}
			}
			await client.status(pending.text);
			if (this.statusText === pending) this.statusText = undefined;
			this.agentsCache.clear();
		} catch (error) {
			this.debug(`status not sent: ${(error as Error).message}`);
		}
	}

	sent(entry: { messageId: string; taskIds: string[]; title: string; expectReply: boolean; to: AgentInfo[] }): void {
		this.remember(entry.messageId, entry.title);
		for (const taskId of entry.taskIds) this.remember(taskId, entry.title);
		if (entry.expectReply && entry.to.length > 0) {
			const askedAt = Date.now();
			this.deadlines.push({
				messageId: entry.messageId,
				askedAt,
				dueAt: askedAt + PENDING_NUDGE_MS,
				title: entry.title,
				names: entry.to.map((agent) => agent.name).join(", "),
			});
			this.scheduleDeadline();
		}
		this.agentsCache.clear();
		this.refreshCounts();
	}

	private remember(id: string, title: string): void {
		this.sentTitles.delete(id);
		this.sentTitles.set(id, title);
		while (this.sentTitles.size > MAX_SENT_TITLES) {
			const oldest = this.sentTitles.keys().next().value;
			if (oldest === undefined) break;
			this.sentTitles.delete(oldest);
		}
	}

	private scheduleDeadline(): void {
		if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
		this.deadlineTimer = undefined;
		if (this.shuttingDown || this.deadlines.length === 0) return;
		const next = Math.min(...this.deadlines.map((entry) => entry.dueAt));
		this.deadlineTimer = setTimeout(() => void this.checkDeadlines(), Math.max(0, next - Date.now()));
		this.deadlineTimer.unref?.();
	}

	private async checkDeadlines(): Promise<void> {
		this.deadlineTimer = undefined;
		const now = Date.now();
		const due = this.deadlines.filter((entry) => entry.dueAt <= now);
		this.deadlines = this.deadlines.filter((entry) => entry.dueAt > now);
		if (due.length > 0 && this.client) {
			try {
				const open = new Set((await this.client.pending()).expectReply.map((entry) => entry.messageId));
				for (const entry of due) {
					if (open.has(entry.messageId))
						this.queueForDigest(undefined, lapseNotice(entry.names, entry.askedAt, entry.title, now));
				}
			} catch (error) {
				this.debug(`lapse check failed: ${(error as Error).message}`);
			}
		}
		this.scheduleDeadline();
	}

	changed(): void {
		if (this.shuttingDown) return;
		this.guard(() => {
			if (!this.extCtx?.hasUI) return;
			const text = this.statusLine();
			if (text === this.lastStatus) return;
			this.extCtx.ui.setStatus("pi-bus", text);
			this.lastStatus = text;
		});
		this.emitIdentity(false);
	}

	/** Emits only when the name or role changed, unless forced. */
	emitIdentity(force: boolean): void {
		if (this.shuttingDown) return;
		const session = this.session;
		const identity = session ? { name: session.name, ...(session.role ? { role: session.role } : {}) } : {};
		const key = JSON.stringify(identity);
		if (!force && key === this.lastIdentity) return;
		this.lastIdentity = key;
		this.ctx.events.emit("bus:identity", identity);
	}

	private refreshCounts(): void {
		if (this.countsTimer || this.shuttingDown) return;
		this.countsTimer = setTimeout(() => {
			this.countsTimer = undefined;
			void this.loadCounts();
		}, COUNTS_DEBOUNCE_MS);
		this.countsTimer.unref?.();
	}

	private async loadCounts(): Promise<void> {
		const client = this.client;
		if (!client || !this.online) return;
		try {
			// TODO(okka): ask the hub for an unread count instead of fetching up to 200 bodies.
			const [unread, raw] = await Promise.all([client.inbox({ unread: true, limit: 200 }), client.pending()]);
			const pending = withoutAskedTasks(raw);
			this.counts = { unread: unread.length, awaiting: pending.expectReply.length + pending.tasks.length };
		} catch (error) {
			this.debug(`counts failed: ${(error as Error).message}`);
		}
		this.changed();
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

	private identityFor(extCtx: ExtensionContext): Session {
		const launch = this.identity.launch;
		const id = extCtx.sessionManager.getSessionId();
		const spawned = this.spawnIdentity?.(extCtx);
		this.firstTask = spawned?.firstTask
			? { messageId: spawned.firstTask, until: Date.now() + FIRST_TASK_HOLD_MS }
			: undefined;
		const role = spawned ? spawned.role : launch.role;
		const name = defaultName(
			{ name: spawned ? spawned.name : launch.name, sessionName: this.ctx.pi.getSessionName(), role },
			id,
		);
		return {
			id,
			name,
			role: role || undefined,
			parent: (spawned ? spawned.parent : launch.parent) || undefined,
			labels: spawned ? { ...spawned.labels } : busLabels(launch),
			topics: this.session?.id === id ? this.session.topics : [],
			cwd: extCtx.cwd,
			ephemeral: !extCtx.sessionManager.getSessionFile(),
			spawned: spawned !== undefined,
		};
	}

	private registration(): Registration {
		const session = this.self();
		const body: Registration = {
			name: session.name,
			cwd: session.cwd,
			labels: { ...session.labels },
			topics: [...session.topics],
			ephemeral: session.ephemeral,
		};
		if (session.role) body.role = session.role;
		if (session.parent) body.parent = session.parent;
		return body;
	}

	/** Called at each session start. A session that is already linked keeps its link. */
	async startSession(extCtx: ExtensionContext): Promise<void> {
		this.bind(extCtx);
		const id = extCtx.sessionManager.getSessionId();
		if (this.client && this.session?.id === id && !this.shuttingDown) {
			// A session start can bring a new UI, so the status and identity go out again.
			this.lastStatus = undefined;
			this.emitIdentity(true);
			this.changed();
			return;
		}
		this.shuttingDown = false;
		this.lastStatus = undefined;
		this.lastIdentity = undefined;
		this.session = this.identityFor(extCtx);
		const saved = this.sessions.get(id);
		this.sessions.delete(id);
		this.queue = { messages: [], notices: [] };
		this.statusText = savedStatus(extCtx);
		this.sentTitles = new Map(saved?.sent ?? []);
		this.deadlines = saved?.deadlines ?? [];
		this.emitIdentity(true);
		this.setupError = undefined;
		this.linkStatus = undefined;
		this.wasOnline = false;
		this.warnedOffline = false;
		const url = this.hubUrl();
		if (!url) {
			this.changed();
			return;
		}
		const token = readHubToken(this.tokenFile());
		if ("error" in token) {
			this.setupError = token.error;
			// The feature log shows the error once in the UI and in /pimon.
			this.ctx.log.error(`bus not started: ${token.error}`);
			this.changed();
			return;
		}
		this.client = new HubClient({ url, token: token.token, agent: id });
		this.link = new HubLink({
			client: this.client,
			registration: () => this.registration(),
			onEvent: (event) => this.onEvent(event),
			onStatus: (status) => this.onLinkStatus(status),
			onLinked: (result) => this.onLinked(result),
			lastSeq: saved?.lastSeq,
			log: (message) => this.debug(message),
		});
		this.taskSenders = new Map(saved?.taskSenders ?? []);
		for (const message of saved?.queue ?? []) this.queueForDigest(message);
		for (const notice of saved?.notices ?? []) this.queueForDigest(undefined, notice);
		this.scheduleDeadline();
		this.link.start();
		this.changed();
	}

	/** pi skips session_start on an SDK reload without UI bindings. */
	async startForPrompt(extCtx: ExtensionContext): Promise<void> {
		if (this.session && this.session.id === extCtx.sessionManager.getSessionId()) return;
		await this.startSession(extCtx);
	}

	async renamed(name: string | undefined): Promise<void> {
		const session = this.session;
		if (!session || !this.extCtx || this.identity.launch.name || session.spawned) return;
		session.name = defaultName({ sessionName: name, role: session.role }, session.id);
		this.changed();
		await this.link?.reregister();
	}

	private onLinked(result: RegisterResult): void {
		if (this.session) this.session.name = result.name;
		this.agentsCache.clear();
		this.ctx.events.emit("bus:ready", { id: result.agent, name: result.name });
		this.sentState = undefined;
		this.pushState();
		void this.flushStatus();
		this.refreshCounts();
		this.changed();
	}

	private onLinkStatus(status: LinkStatus): void {
		const before = this.linkStatus;
		this.linkStatus = status;
		const url = this.hubUrl() ?? "";
		if (status.state === "online") {
			if (this.warnedOffline) this.notify(`pimon bus: hub ${url} is reachable again`, "info");
			this.warnedOffline = false;
			this.wasOnline = true;
		} else if (
			status.state === "retrying" &&
			!this.warnedOffline &&
			!this.shuttingDown &&
			(!this.wasOnline || status.failures >= WARN_AFTER_FAILURES)
		) {
			this.warnedOffline = true;
			this.notify(`pimon bus: hub ${url} unreachable, retrying`, "warning");
		} else if (status.state === "stopped" && status.fatal && before?.fatal !== status.fatal) {
			this.ctx.log.error(this.fatalText(status));
		}
		this.changed();
	}

	private mayWake(message: BusMessage): boolean {
		if (this.wakePolicy === "all") return true;
		if (this.wakePolicy === "none") return false;
		const parent = this.session?.parent;
		return Boolean(parent) && message.from.id === parent;
	}

	/** An event that comes while this runtime stops stays unacked, so the next runtime gets it again. */
	private onEvent(event: LinkEvent): boolean {
		if (this.shuttingDown) return false;
		switch (event.type) {
			case "message":
				this.onMessage(fromMessage(event.payload as MessageEvent));
				break;
			case "update":
				this.onUpdate(event.payload as UpdateEvent);
				break;
			case "cancel": {
				const { taskId } = event.payload as { taskId: string };
				const notice = `The sender canceled task ${shortId(taskId)}. Stop work on it.`;
				const sender = this.taskSenders.get(taskId);
				this.taskSenders.delete(taskId);
				if (this.mayWake({ from: { id: sender } } as BusMessage)) this.queueForDigest(undefined, notice);
				else this.addWithoutWake(notice);
				break;
			}
			case "presence":
				void this.onPresence(event.payload as PresenceEvent);
				break;
			case "control":
				this.onControl(event.payload as ControlEvent);
				break;
			case "replaced":
				this.notify(`pimon bus: ${REPLACED_NOTICE}`, "warning");
				this.addWithoutWake(REPLACED_NOTICE);
				break;
		}
		this.refreshCounts();
		return true;
	}

	private onMessage(message: BusMessage): void {
		if (message.taskId && message.direction === "in") {
			this.taskSenders.set(message.taskId, message.from.id);
			for (const oldest of this.taskSenders.keys()) {
				if (this.taskSenders.size <= MAX_TASK_SENDERS) break;
				this.taskSenders.delete(oldest);
			}
		}
		if (this.firstTask && message.id === this.firstTask.messageId) {
			this.firstTask = undefined;
			this.firstTaskHandler?.(message);
			void this.markRead([message.id]);
			if (message.taskId) this.markWorking(message.taskId);
			if (message.subject && !this.statusText) this.firstStatus(message.subject);
			if (this.queue.messages.length > 0 || this.queue.notices.length > 0) this.scheduleFlush(DIGEST_DEBOUNCE_MS);
			return;
		}
		if (message.kind !== "event") {
			this.notify(`bus: ${message.from.name} sent ${message.kind}`, message.priority === "urgent" ? "warning" : "info");
		}
		if (message.wake === "never" || !this.mayWake(message)) return;
		this.queueForDigest(message);
	}

	private onUpdate(update: UpdateEvent): void {
		this.ctx.events.emit("bus:update", update);
		const message = fromUpdate(update);
		if (message) {
			if (message.wake === "now" && this.mayWake(message)) this.queueForDigest(message);
			return;
		}
		if (!WAKING_UPDATE_STATES.has(update.state)) return;
		const title = this.sentTitles.get(update.taskId);
		// An agent outside the hub, such as Hermes, can answer with artifacts only. No inbox row holds them.
		const artifacts = (update.artifacts ?? []).map((artifact) => artifact.text ?? "").filter(Boolean);
		const joined = artifacts.join("\n\n").trim();
		const cut = joined.length > ARTIFACT_NOTICE_CHARS ? `${joined.slice(0, ARTIFACT_NOTICE_CHARS - 1)}…` : joined;
		const result = cut ? ` Result: ${cut}` : "";
		const notice = `${update.from.name} (id:${shortId(update.from.agent)}) set task ${shortId(update.taskId)}${title ? ` "${title}"` : ""} to ${update.state}.${result}`;
		if (this.mayWake({ from: { id: update.from.agent } } as BusMessage)) this.queueForDigest(undefined, notice);
	}

	private async onPresence(event: PresenceEvent): Promise<void> {
		this.agentsCache.clear();
		this.ctx.events.emit("bus:presence", event);
		if (event.online) return;
		const expected = this.expectedExits.take(event.agent);
		let work = { waiting: 0, owed: 0 };
		const client = this.client;
		if (client) {
			try {
				const [pending, owed] = await Promise.all([client.pending(), client.owed()]);
				work = openWorkWith(event.agent, pending, owed);
			} catch (error) {
				this.debug(`open work check failed: ${(error as Error).message}`);
			}
		}
		const notice = offlineNotice(event, work);
		const wakes = offlineWakes(event, work, { parent: this.session?.parent, policy: this.wakePolicy });
		if (wakes && expected && work.waiting === 0) this.addWithoutWake(notice);
		else if (wakes) this.queueForDigest(undefined, notice);
		else this.notify(`bus: ${notice}`, "info");
		this.changed();
	}

	private onControl(event: ControlEvent): void {
		if (this.controlPolicy === "none") {
			this.notify(`bus: refused close from ${event.from.name}`, "warning");
			return;
		}
		this.notify(`bus: ${event.from.name} asked this session to close`, "info");
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
					await this.stop("quit");
				} catch {
					// Exiting anyway.
				}
				this.debug(`forced exit after close request from ${event.from.name}`);
				process.exit(0);
			},
		});
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

	private queueForDigest(message?: BusMessage, notice?: string): void {
		if (this.shuttingDown) return;
		if (message) this.queue.messages.push(message);
		if (notice) this.queue.notices.push(notice);
		if (this.timer) return;
		this.scheduleFlush(DIGEST_DEBOUNCE_MS);
	}

	private scheduleFlush(ms: number): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flush(), ms);
		this.timer.unref?.();
	}

	private flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.shuttingDown) return;
		const held = this.firstTask ? this.firstTask.until - Date.now() : 0;
		if (held > 0) {
			this.scheduleFlush(held);
			return;
		}
		this.firstTask = undefined;
		const queued = this.queue;
		this.queue = { messages: [], notices: [] };
		if (queued.messages.length === 0 && queued.notices.length === 0) return;

		const rendered = renderDigest(queued, this.sentTitles);
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
					messageIds: rendered.included.map((message) => message.id),
					threadIds: [...new Set(rendered.included.map((message) => message.threadId))],
				},
			});
		}
		if (rendered.omitted.length > 0) {
			this.queue.messages.unshift(...rendered.omitted);
			this.scheduleFlush(DIGEST_DEBOUNCE_MS);
		}
		this.changed();
	}

	/** The digest reached the model. An inbound task in it is now being worked on. */
	digestSeen(digestId: string | undefined): void {
		if (!digestId) return;
		const messages = this.undelivered.get(digestId);
		if (!messages) return;
		this.undelivered.delete(digestId);
		this.inRun.push(...messages);
		for (const message of messages) {
			if (message.taskId && message.taskState === "submitted" && message.direction === "in") {
				this.markWorking(message.taskId);
			}
		}
	}

	/** A spawned child shows its task subject to the parent until the model sets its own status. */
	private firstStatus(subject: string): void {
		const client = this.client;
		if (!client) return;
		const text = subject.replace(/\s+/g, " ").trim().slice(0, STATUS_TEXT_MAX);
		client
			.status(text)
			.then(() => this.agentsCache.clear())
			.catch((error: unknown) => this.debug(`first status not sent: ${(error as Error).message}`));
	}

	markWorking(taskId: string): void {
		this.client?.taskUpdate(taskId, { state: "working" }).catch((error: unknown) => {
			if (!(error instanceof HubHttpError && error.status === 409))
				this.debug(`working update failed: ${(error as Error).message}`);
		});
	}

	assistantCompleted(): void {
		if (this.inRun.length === 0) return;
		const ids = this.inRun.map((message) => message.id);
		this.inRun = [];
		void this.markRead(ids);
	}

	runEnded(): void {
		// An aborted or failed run leaves its digests unread. No automatic re-wake.
		this.inRun = [];
	}

	async openState(): Promise<string | undefined> {
		const client = this.client;
		if (!client) return undefined;
		try {
			const [unread, pending, owed] = await Promise.all([
				client.inbox({ unread: true, limit: 200 }),
				client.pending(),
				client.owed(),
			]);
			return renderOpenState(unread.length, pending, owed);
		} catch (error) {
			this.debug(`open state failed: ${(error as Error).message}`);
			return undefined;
		}
	}

	setState(state: "busy" | "idle", activity?: string): void {
		this.state = { state, activity };
		if (this.stateTimer || this.shuttingDown) return;
		this.stateTimer = setTimeout(() => {
			this.stateTimer = undefined;
			this.pushState();
		}, STATE_DEBOUNCE_MS);
		this.stateTimer.unref?.();
	}

	private pushState(): void {
		const client = this.client;
		if (!client || !this.online) return;
		const key = JSON.stringify(this.state);
		if (key === this.sentState) return;
		this.sentState = key;
		const body = this.state.activity
			? { state: this.state.state, activity: this.state.activity }
			: { state: this.state.state };
		client.state(body).catch((error: unknown) => {
			this.sentState = undefined;
			this.debug(`state failed: ${(error as Error).message}`);
		});
	}

	/** Closes the link. Only a quit or a session replacement marks the agent offline at once; a reload keeps it online. */
	async stop(reason: string): Promise<void> {
		// No flush here: a digest would start a run on a session that is being replaced.
		if (this.shuttingDown && !this.client) return;
		this.shuttingDown = true;
		for (const timer of [this.timer, this.countsTimer, this.stateTimer, this.deadlineTimer])
			if (timer) clearTimeout(timer);
		this.timer = this.countsTimer = this.stateTimer = this.deadlineTimer = undefined;
		this.cancelClose?.();
		this.cancelClose = undefined;
		const session = this.session;
		const link = this.link;
		const client = this.client;
		this.link = undefined;
		this.client = undefined;
		await link?.stop();
		if (session) {
			const queue = [...this.queue.messages, ...[...this.undelivered.values()].flat()];
			this.sessions.set(session.id, {
				queue,
				notices: this.queue.notices,
				sent: [...this.sentTitles],
				deadlines: this.deadlines,
				lastSeq: link?.lastSeq,
				taskSenders: [...this.taskSenders],
			});
			while (this.sessions.size > MAX_SAVED_SESSIONS) {
				const oldest = this.sessions.keys().next().value;
				if (oldest === undefined) break;
				this.sessions.delete(oldest);
			}
		}
		this.queue = { messages: [], notices: [] };
		this.undelivered.clear();
		this.inRun = [];
		this.agentsCache.clear();
		if (client && reason !== "reload" && link?.status.reason !== "replaced") {
			await Promise.race([
				client.offline().catch(() => {}),
				new Promise((done) => setTimeout(done, OFFLINE_TIMEOUT_MS).unref?.()),
			]);
		}
	}

	service(): BusService {
		return createService(this);
	}

	errorText(error: unknown): string {
		return hubErrorText(error, this.hubUrl());
	}

	async resolve(selector: string): Promise<AgentInfo[]> {
		this.hub();
		return resolveTargets(this, selector);
	}
}

function createService(runtime: BusRuntime): BusService {
	const { launch } = runtime.identity;
	return {
		launch,
		get started() {
			return runtime.started;
		},
		get online() {
			return runtime.online;
		},
		get id() {
			return runtime.self().id;
		},
		get name() {
			return runtime.self().name;
		},
		get labels() {
			return runtime.self().labels;
		},
		unavailable: () => runtime.unavailable(),
		errorText: (error) => runtime.errorText(error),
		agents: (includeOffline = false) => runtime.agents(includeOffline),
		agent: async (id) => {
			try {
				return await runtime.hub().agentInfo(id);
			} catch (error) {
				if (error instanceof HubHttpError && error.status === 404) return undefined;
				throw error;
			}
		},
		resolve: (selector) => runtime.resolve(selector),
		expectOffline: (agent) => runtime.expectedExits.expect(agent),
		send: (targets, init) => sendToAgents(runtime, targets, init),
		close: async (agent) => {
			await runtime.hub().control(agent);
		},
		addChild: async (child) => {
			await runtime.hub().addChild(child);
		},
		onPresence: (handler) => runtime.events.on("bus:presence", handler),
		onUpdate: (handler) => runtime.events.on("bus:update", handler),
		onReady: (handler) => runtime.events.on("bus:ready", handler),
		setSpawnIdentity: (provider) => {
			runtime.spawnIdentity = provider;
		},
		onFirstTask: (handler) => {
			runtime.firstTaskHandler = handler;
		},
	};
}

export const bus = defineFeature({
	id: "bus",
	description: "Messaging between pi sessions through the pimon hub: the pi_bus tool, digests, and presence",
	defaultEnabled: true,
	configSchema,
	setup(ctx) {
		// The env is read and deleted once per process. A new version of this state reads an empty env.
		const identity = ctx.reloadState<Identity>("identity", 2, () => {
			const launch = readLaunchEnv(process.env);
			deleteIdentityEnv(process.env);
			return { launch };
		});
		const sessions = ctx.reloadState("sessions", 4, () => new Map<string, SavedSession>());
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

		registerCommands(pi, runtime, () => {
			const token = readHubToken(runtime.tokenFile());
			return "error" in token ? token.error : `${runtime.tokenFile()} (mode 0600)`;
		});

		ctx.onSessionStart(async (_event, extensionCtx) => {
			await runtime.startSession(extensionCtx);
		});
		ctx.onSessionShutdown(async (event) => {
			await runtime.stop(event.reason);
		});

		// pi skips session_start on an SDK reload without UI bindings.
		pi.on("before_agent_start", async (_event, extensionCtx) => {
			await runtime.startForPrompt(extensionCtx);
		});

		pi.on("session_info_changed", async (event) => {
			await runtime.renamed(event.name);
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
			runtime.setState("busy", truncate(event.toolName, 60));
		});

		pi.on("session_compact", async () => {
			const text = await runtime.openState();
			if (!text) return;
			pi.sendMessage({ customType: STATE_TYPE, content: text, display: true }, { triggerTurn: false });
		});

		return runtime.service();
	},
});
