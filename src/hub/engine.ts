import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { Principal } from "./auth.ts";
import {
	type AgentInfo,
	type AgentKind,
	type AgentState,
	BUS_EXTENSION_URI,
	BUS_KINDS,
	type BusKind,
	type ChildBody,
	type BusMetadata,
	HUB_PROTOCOL,
	type InboxItem,
	type LinkEvent,
	type LinkEventMap,
	type LinkEventType,
	type LinkPostState,
	type LinkTaskState,
	type PendingResult,
	type PresenceEvent,
	type Priority,
	type RegisterBody,
	type RegisterResult,
	type Sender,
	STATUS_TEXT_MAX,
	TASK_KINDS,
	type TaskUpdateBody,
	type ThreadResult,
	type Wake,
} from "./protocol.ts";
import { PushGuard } from "./push-guard.ts";

// ---------- wire types (A2A 1.0 ProtoJSON) ----------

export type WireState =
	| "TASK_STATE_SUBMITTED"
	| "TASK_STATE_WORKING"
	| "TASK_STATE_COMPLETED"
	| "TASK_STATE_FAILED"
	| "TASK_STATE_CANCELED"
	| "TASK_STATE_INPUT_REQUIRED"
	| "TASK_STATE_REJECTED"
	| "TASK_STATE_AUTH_REQUIRED";

export interface WirePart {
	text?: string;
	raw?: string;
	url?: string;
	data?: unknown;
	metadata?: Record<string, unknown>;
	filename?: string;
	mediaType?: string;
}

export interface WireMessage {
	messageId: string;
	contextId?: string;
	taskId?: string;
	role: string;
	parts: WirePart[];
	metadata?: Record<string, unknown>;
	extensions?: string[];
	referenceTaskIds?: string[];
}

export interface WireArtifact {
	artifactId: string;
	name?: string;
	description?: string;
	parts: WirePart[];
	metadata?: Record<string, unknown>;
	extensions?: string[];
}

export interface WireStatus {
	state: WireState;
	message?: WireMessage;
	timestamp: string;
}

export interface WireTask {
	id: string;
	contextId: string;
	status: WireStatus;
	artifacts?: WireArtifact[];
	history?: WireMessage[];
	metadata?: Record<string, unknown>;
}

export interface WireStatusUpdate {
	taskId: string;
	contextId: string;
	status: WireStatus;
	metadata?: Record<string, unknown>;
}

export interface WireArtifactUpdate {
	taskId: string;
	contextId: string;
	artifact: WireArtifact;
	append?: boolean;
	lastChunk?: boolean;
	metadata?: Record<string, unknown>;
}

export type WireStreamResponse =
	| { task: WireTask }
	| { message: WireMessage }
	| { statusUpdate: WireStatusUpdate }
	| { artifactUpdate: WireArtifactUpdate };

export interface WireAuthentication {
	scheme: string;
	credentials?: string;
}

export interface WirePushConfig {
	id: string;
	taskId: string;
	url: string;
	token?: string;
	authentication?: WireAuthentication;
}

export const TERMINAL_STATES: ReadonlySet<WireState> = new Set([
	"TASK_STATE_COMPLETED",
	"TASK_STATE_FAILED",
	"TASK_STATE_CANCELED",
	"TASK_STATE_REJECTED",
]);
export const INTERRUPTED_STATES: ReadonlySet<WireState> = new Set([
	"TASK_STATE_INPUT_REQUIRED",
	"TASK_STATE_AUTH_REQUIRED",
]);

const LINK_STATE_TO_WIRE: Record<LinkTaskState, WireState> = {
	submitted: "TASK_STATE_SUBMITTED",
	working: "TASK_STATE_WORKING",
	"input-required": "TASK_STATE_INPUT_REQUIRED",
	completed: "TASK_STATE_COMPLETED",
	failed: "TASK_STATE_FAILED",
	canceled: "TASK_STATE_CANCELED",
	rejected: "TASK_STATE_REJECTED",
	"auth-required": "TASK_STATE_AUTH_REQUIRED",
};
const WIRE_TO_LINK_STATE = Object.fromEntries(
	Object.entries(LINK_STATE_TO_WIRE).map(([link, wire]) => [wire, link]),
) as Record<WireState, LinkTaskState>;
const LINK_POST_STATES: ReadonlySet<string> = new Set(["working", "input-required", "completed", "failed", "rejected"]);

export function linkState(state: WireState): LinkTaskState {
	return WIRE_TO_LINK_STATE[state];
}

export function wireState(state: LinkTaskState): WireState {
	return LINK_STATE_TO_WIRE[state];
}

export function isTerminal(state: WireState): boolean {
	return TERMINAL_STATES.has(state);
}

// ---------- errors ----------

export type HubErrorReason =
	| "invalid"
	| "forbidden"
	| "not-found"
	| "task-not-found"
	| "task-terminal"
	| "not-cancelable"
	| "conflict"
	| "upgrade";

const REASON_STATUS: Record<HubErrorReason, number> = {
	invalid: 400,
	forbidden: 403,
	"not-found": 404,
	"task-not-found": 404,
	"task-terminal": 409,
	"not-cancelable": 409,
	conflict: 409,
	upgrade: 426,
};

export class HubError extends Error {
	readonly reason: HubErrorReason;
	readonly status: number;
	readonly details: Record<string, unknown> | undefined;

	constructor(reason: HubErrorReason, message: string, details?: Record<string, unknown>) {
		super(message);
		this.reason = reason;
		this.status = REASON_STATUS[reason];
		this.details = details;
	}
}

// ---------- ids and time ----------

export function uuidv7(now: number = Date.now()): string {
	const bytes = randomBytes(16);
	bytes.writeUIntBE(now, 0, 6);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 30 * DAY_MS;
export const EPHEMERAL_TTL_MS = DAY_MS;
export const OFFLINE_TTL_MS = 90 * DAY_MS;
export const PUSH_BACKLOG_MAX = 50;
export const OFFLINE_LIST_MS = 7 * DAY_MS;
export const STALE_CONTROL_MS = 30_000;
const TERMINAL_SQL = "'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'";

export function defaultAgentName(host: string, id: string): string {
	return `${host}-${createHash("sha256").update(id).digest("hex").slice(0, 6)}`;
}

export function messageText(message: { parts?: WirePart[] } | undefined): string {
	return (message?.parts ?? [])
		.map((part) => part.text)
		.filter((text): text is string => typeof text === "string")
		.join("\n");
}

export function cleanStatusText(text: string): string {
	return text
		.replace(/\s*[\r\n]+\s*/g, " ")
		.trim()
		.slice(0, STATUS_TEXT_MAX)
		.trim();
}

// ---------- rows ----------

export interface AgentRow {
	id: string;
	kind: AgentKind;
	host: string | null;
	name: string;
	role: string | null;
	cwd: string | null;
	labels: string;
	parent: string | null;
	topics: string;
	ephemeral: number;
	online: number;
	state: AgentState;
	activity: string | null;
	status_text: string;
	status_at: string | null;
	registered_at: string;
	last_seen_at: string | null;
	offline_at: string | null;
}

interface TaskRow {
	id: string;
	agent_id: string;
	sender_agent: string | null;
	sender_principal: string;
	context_id: string;
	state: WireState;
	status_message: string | null;
	status_at: string;
	kind: string;
	metadata: string | null;
	created_at: string;
	updated_at: string;
}

interface MessageRow {
	seq: number;
	id: string;
	agent_id: string;
	sender_agent: string | null;
	sender_principal: string;
	sender_name: string;
	sender_kind: string;
	context_id: string;
	task_id: string | null;
	kind: string;
	meta: string;
	message: string;
	created_at: string;
	read_at: string | null;
	reply_to: string | null;
}

type MessageItemRow = MessageRow & { to_name: string | null; task_state: WireState | null };

interface PushConfigRow {
	task_id: string;
	id: string;
	url: string;
	token: string | null;
	auth_scheme: string | null;
	auth_credentials: string | null;
	principal: string;
	created_at: string;
}

export interface OutboxItem {
	id: number;
	taskId: string;
	configId: string;
	url: string;
	token: string | null;
	authScheme: string | null;
	authCredentials: string | null;
	payload: string;
	attempts: number;
	nextAt: number;
}

// ---------- engine API types ----------

export interface Caller {
	principal: Principal;
	/** Set from `X-Pimon-Agent`, already checked to be bound to the principal's host. */
	agent?: string;
}

export interface TaskEvent {
	taskId: string;
	agentId: string;
	state: WireState;
	response: WireStreamResponse;
}

export interface SendInput {
	agentId: string;
	caller: Caller;
	message: WireMessage;
	pushConfig?: Omit<WirePushConfig, "id" | "taskId"> & { id?: string };
}

export interface SendResult {
	task?: WireTask;
	message?: WireMessage;
	created: boolean;
	eventSeq: number | undefined;
	meta: NormalizedMeta;
}

export interface NormalizedMeta extends BusMetadata {
	kind: BusKind;
	wake: Wake;
}

export interface ListTasksInput {
	contextId?: string;
	state?: WireState;
	statusTimestampAfter?: string;
	pageSize: number;
	pageToken?: string;
	historyLength?: number;
	includeArtifacts: boolean;
}

export interface ListTasksResult {
	tasks: WireTask[];
	nextPageToken: string;
	pageSize: number;
	totalSize: number;
}

export interface TaskChange {
	state?: WireState;
	/** An agent message: goes to history and to `status.message`. */
	message?: WireMessage;
	artifacts?: { artifact: WireArtifact; append?: boolean; lastChunk?: boolean }[];
}

export interface EngineOptions {
	now?: () => number;
	newId?: (now: number) => string;
	pushGuard?: PushGuard;
	log?: (line: string) => void;
}

type Listener<A extends unknown[]> = (...args: A) => void;

export function parseBusMetadata(metadata: Record<string, unknown> | undefined): NormalizedMeta {
	const raw = metadata?.[BUS_EXTENSION_URI];
	if (raw === undefined || raw === null) return { kind: "task", wake: "now" };
	if (typeof raw !== "object" || Array.isArray(raw)) throw new HubError("invalid", "bus metadata must be an object");
	const value = raw as Record<string, unknown>;
	const kind = value["kind"] ?? "task";
	if (typeof kind !== "string" || !(BUS_KINDS as readonly string[]).includes(kind)) {
		throw new HubError("invalid", `bus metadata kind must be one of ${BUS_KINDS.join(", ")}`);
	}
	const wake = value["wake"] ?? "now";
	if (wake !== "now" && wake !== "never") throw new HubError("invalid", "bus metadata wake must be now or never");
	const priority = value["priority"];
	if (priority !== undefined && priority !== "normal" && priority !== "important" && priority !== "urgent") {
		throw new HubError("invalid", "bus metadata priority must be normal, important, or urgent");
	}
	const meta: NormalizedMeta = { kind: kind as BusKind, wake };
	if (priority !== undefined) meta.priority = priority as Priority;
	if (typeof value["subject"] === "string") meta.subject = value["subject"];
	if (value["expectReply"] === true) meta.expectReply = true;
	if (value["deliveryWait"] === true) meta.deliveryWait = true;
	if (typeof value["replyTo"] === "string" && value["replyTo"] !== "") meta.replyTo = value["replyTo"];
	if (value["data"] !== undefined) meta.data = value["data"];
	return meta;
}

function parseJson<T>(text: string | null, fallback: T): T {
	if (text === null || text === "") return fallback;
	return JSON.parse(text) as T;
}

function requireString(value: unknown, field: string, max = 4096): string {
	if (typeof value !== "string" || value === "") throw new HubError("invalid", `${field} must be a non-empty string`);
	if (value.length > max) throw new HubError("invalid", `${field} is longer than ${max} chars`);
	return value;
}

function optionalString(value: unknown, field: string, max = 4096): string | null {
	if (value === undefined || value === null || value === "") return null;
	return requireString(value, field, max);
}

function stringList(value: unknown, field: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
		throw new HubError("invalid", `${field} must be a list of non-empty strings`);
	}
	return [...new Set(value as string[])];
}

function labelMap(value: unknown): Record<string, string> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) throw new HubError("invalid", "labels must be an object");
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (typeof item !== "string") throw new HubError("invalid", "labels values must be strings");
		out[key] = item;
	}
	return out;
}

function encodePageToken(statusAt: string, id: string): string {
	return Buffer.from(JSON.stringify([statusAt, id]), "utf8").toString("base64url");
}

function decodePageToken(token: string): [string, string] {
	try {
		const value: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
		if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string") {
			return [value[0], value[1]];
		}
	} catch {
		// fall through
	}
	throw new HubError("invalid", "pageToken is not valid");
}

export function applyHistoryLength(task: WireTask, historyLength: number | undefined): WireTask {
	if (historyLength === undefined) return task;
	if (historyLength <= 0) {
		const { history: _history, ...rest } = task;
		return rest;
	}
	return { ...task, history: (task.history ?? []).slice(-historyLength) };
}

export class Engine {
	readonly db: DatabaseSync;
	readonly now: () => number;
	readonly #newId: (now: number) => string;
	readonly #statements = new Map<string, StatementSync>();
	readonly #taskListeners = new Map<string, Set<Listener<[TaskEvent]>>>();
	readonly #linkListeners = new Set<Listener<[string, LinkEvent]>>();
	readonly #ackListeners = new Set<Listener<[string, number]>>();
	readonly #pushListeners = new Set<Listener<[]>>();
	readonly #pushGuard: PushGuard;
	readonly #log: (line: string) => void;
	#pending: (() => void)[] | null = null;

	constructor(db: DatabaseSync, options: EngineOptions = {}) {
		this.db = db;
		this.now = options.now ?? Date.now;
		this.#newId = options.newId ?? uuidv7;
		this.#pushGuard = options.pushGuard ?? new PushGuard();
		this.#log = options.log ?? (() => {});
	}

	newId(): string {
		return this.#newId(this.now());
	}

	iso(ms: number = this.now()): string {
		return new Date(ms).toISOString();
	}

	// ---------- plumbing ----------

	#stmt(sql: string): StatementSync {
		let statement = this.#statements.get(sql);
		if (!statement) {
			statement = this.db.prepare(sql);
			this.#statements.set(sql, statement);
		}
		return statement;
	}

	#get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
		return this.#stmt(sql).get(...params) as T | undefined;
	}

	#all<T>(sql: string, ...params: SQLInputValue[]): T[] {
		return this.#stmt(sql).all(...params) as T[];
	}

	#run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
		const result = this.#stmt(sql).run(...params);
		return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
	}

	/** Runs `fn` in one transaction. Listeners run only after the commit. Nested calls join the outer one. */
	tx<T>(fn: () => T): T {
		if (this.#pending) return fn();
		const pending: (() => void)[] = [];
		this.#pending = pending;
		this.db.exec("BEGIN IMMEDIATE");
		let result: T;
		try {
			result = fn();
			this.db.exec("COMMIT");
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw error;
		} finally {
			this.#pending = null;
		}
		for (const notify of pending) this.#safely(notify);
		return result;
	}

	/** The change is committed, so a broken listener must not fail the caller or skip the other listeners. */
	#safely(notify: () => void): void {
		try {
			notify();
		} catch (error) {
			this.#log(`listener failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		}
	}

	#notify<A extends unknown[]>(listeners: Iterable<Listener<A>>, ...args: A): void {
		for (const listener of listeners) this.#safely(() => listener(...args));
	}

	#afterCommit(notify: () => void): void {
		if (this.#pending) this.#pending.push(notify);
		else this.#safely(notify);
	}

	/** Open task listeners. Tests use it to prove that waits clean up. */
	listenerCount(taskId: string): number {
		return this.#taskListeners.get(taskId)?.size ?? 0;
	}

	onTask(taskId: string, listener: Listener<[TaskEvent]>): () => void {
		let set = this.#taskListeners.get(taskId);
		if (!set) {
			set = new Set();
			this.#taskListeners.set(taskId, set);
		}
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0) this.#taskListeners.delete(taskId);
		};
	}

	onLink(listener: Listener<[string, LinkEvent]>): () => void {
		this.#linkListeners.add(listener);
		return () => this.#linkListeners.delete(listener);
	}

	onAck(listener: Listener<[string, number]>): () => void {
		this.#ackListeners.add(listener);
		return () => this.#ackListeners.delete(listener);
	}

	onPush(listener: Listener<[]>): () => void {
		this.#pushListeners.add(listener);
		return () => this.#pushListeners.delete(listener);
	}

	// ---------- agents ----------

	agent(id: string): AgentRow | undefined {
		return this.#get<AgentRow>("SELECT * FROM agents WHERE id = ?", id);
	}

	requireAgent(id: string): AgentRow {
		const row = this.agent(id);
		if (!row) throw new HubError("not-found", `unknown agent ${id}`);
		return row;
	}

	/** The agent must exist and be bound to the host principal. */
	requireOwnAgent(principal: Principal, id: string): AgentRow {
		const row = this.agent(id);
		if (!row || row.kind !== "pi" || principal.kind !== "host" || row.host !== principal.name) {
			throw new HubError("forbidden", `agent ${id} is not bound to ${principal.name}`);
		}
		return row;
	}

	agentInfo(row: AgentRow): AgentInfo {
		return {
			id: row.id,
			name: row.name,
			kind: row.kind,
			host: row.host,
			cwd: row.cwd,
			role: row.role,
			labels: parseJson(row.labels, {}),
			parent: row.parent,
			topics: parseJson(row.topics, []),
			online: row.online === 1,
			state: row.state,
			activity: row.activity,
			status: { text: row.status_text, at: row.status_at },
			lastSeenAt: row.last_seen_at,
		};
	}

	listAgents(includeOffline: boolean): AgentInfo[] {
		const since = this.iso(this.now() - OFFLINE_LIST_MS);
		const rows = includeOffline
			? this.#all<AgentRow>(
					"SELECT * FROM agents WHERE online = 1 OR offline_at IS NULL OR offline_at >= ? ORDER BY name, id",
					since,
				)
			: this.#all<AgentRow>("SELECT * FROM agents WHERE online = 1 ORDER BY name, id");
		return rows.map((row) => this.agentInfo(row));
	}

	onlineCount(): number {
		return this.#get<{ n: number }>("SELECT count(*) AS n FROM agents WHERE online = 1")?.n ?? 0;
	}

	ensureBuiltin(id: string, name: string): void {
		const at = this.iso();
		this.#run(
			`INSERT INTO agents (id, kind, host, name, online, registered_at, last_seen_at)
			 VALUES (?, 'builtin', NULL, ?, 1, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET kind = 'builtin', host = NULL, name = excluded.name, online = 1, offline_at = NULL`,
			id,
			name,
			at,
			at,
		);
	}

	register(principal: Principal, body: RegisterBody): RegisterResult {
		if (principal.kind !== "host") throw new HubError("forbidden", "only host principals may register agents");
		if (body.protocol !== HUB_PROTOCOL) {
			throw new HubError("upgrade", `hub protocol ${HUB_PROTOCOL} required`, { expected: HUB_PROTOCOL });
		}
		const id = requireString(body.agent, "agent", 128);
		if (!AGENT_ID.test(id)) throw new HubError("invalid", "agent id has invalid characters");
		const givenName = optionalString(body.name, "name", 128);
		const givenCwd = optionalString(body.cwd, "cwd");
		const givenRole = optionalString(body.role, "role", 256);
		const givenParent = optionalString(body.parent, "parent", 128);
		const givenLabels = body.labels === undefined ? undefined : labelMap(body.labels);
		const givenTopics = body.topics === undefined ? undefined : JSON.stringify(stringList(body.topics, "topics"));
		const givenEphemeral = body.ephemeral === undefined ? undefined : body.ephemeral === true ? 1 : 0;
		return this.tx(() => {
			const existing = this.agent(id);
			if (existing && (existing.kind !== "pi" || existing.host !== principal.name)) {
				throw new HubError("forbidden", `agent ${id} is bound to another host`);
			}
			// A field that the body leaves out keeps its value, so a pre-registered child keeps what its parent set.
			const name = givenName ?? existing?.name ?? defaultAgentName(principal.name, id);
			const cwd = givenCwd ?? existing?.cwd ?? null;
			const role = givenRole ?? existing?.role ?? null;
			const parent = givenParent ?? existing?.parent ?? null;
			const labels = givenLabels ? JSON.stringify(givenLabels) : (existing?.labels ?? "{}");
			const topics = givenTopics ?? existing?.topics ?? "[]";
			const ephemeral = givenEphemeral ?? existing?.ephemeral ?? 0;
			const at = this.iso();
			if (existing) {
				this.#run(
					`UPDATE agents SET name = ?, cwd = ?, role = ?, parent = ?, labels = ?, topics = ?, ephemeral = ?, last_seen_at = ?
					 WHERE id = ?`,
					name,
					cwd,
					role,
					parent,
					labels,
					topics,
					ephemeral,
					at,
					id,
				);
			} else {
				this.#run(
					`INSERT INTO agents (id, kind, host, name, cwd, role, parent, labels, topics, ephemeral, online, registered_at, last_seen_at, offline_at)
					 VALUES (?, 'pi', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
					id,
					principal.name,
					name,
					cwd,
					role,
					parent,
					labels,
					topics,
					ephemeral,
					at,
					at,
					at,
				);
			}
			return { agent: id, name, host: principal.name };
		});
	}

	/** Makes an offline row for a child before its process registers, so the parent can send it the first task. */
	addChild(principal: Principal, parentId: string, body: ChildBody): RegisterResult {
		if (!body || typeof body !== "object") throw new HubError("invalid", "body must be an object");
		const id = requireString(body.id, "id", 128);
		if (!AGENT_ID.test(id)) throw new HubError("invalid", "agent id has invalid characters");
		const name = optionalString(body.name, "name", 128) ?? defaultAgentName(principal.name, id);
		const cwd = optionalString(body.cwd, "cwd");
		const role = optionalString(body.role, "role", 256);
		const labels = JSON.stringify(labelMap(body.labels));
		return this.tx(() => {
			const existing = this.agent(id);
			const at = this.iso();
			if (existing) {
				if (existing.kind !== "pi" || existing.host !== principal.name || existing.parent !== parentId) {
					throw new HubError("conflict", `agent ${id} exists with another parent or host`);
				}
				this.#run(
					"UPDATE agents SET name = ?, cwd = ?, role = ?, labels = ? WHERE id = ?",
					name,
					cwd,
					role,
					labels,
					id,
				);
			} else {
				this.#run(
					`INSERT INTO agents (id, kind, host, name, cwd, role, parent, labels, online, registered_at, offline_at)
					 VALUES (?, 'pi', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
					id,
					principal.name,
					name,
					cwd,
					role,
					parentId,
					labels,
					at,
					at,
				);
			}
			return { agent: id, name, host: principal.name };
		});
	}

	/**
	 * `@name` resolves to a built-in or external agent with that name, else to the one online pi agent with it.
	 * Returns `ambiguous` with every online match when more than one pi agent has the name.
	 */
	resolveRef(ref: string): { agent: AgentRow } | { ambiguous: string[] } | undefined {
		if (!ref.startsWith("@")) {
			const row = this.agent(ref);
			return row ? { agent: row } : undefined;
		}
		const name = ref.slice(1);
		const fixed = this.#get<AgentRow>(
			"SELECT * FROM agents WHERE name = ? AND kind IN ('builtin', 'external') ORDER BY id LIMIT 1",
			name,
		);
		if (fixed) return { agent: fixed };
		const online = this.#all<AgentRow>(
			"SELECT * FROM agents WHERE name = ? AND kind = 'pi' AND online = 1 ORDER BY last_seen_at DESC, id",
			name,
		);
		if (online.length === 0) return undefined;
		if (online.length > 1) return { ambiguous: online.map((row) => row.id) };
		const only = online[0];
		return only ? { agent: only } : undefined;
	}

	touch(id: string): void {
		this.#run("UPDATE agents SET last_seen_at = ? WHERE id = ?", this.iso(), id);
	}

	setOnline(id: string, online: boolean): void {
		this.tx(() => {
			const row = this.agent(id);
			if (!row || row.kind !== "pi") return;
			const at = this.iso();
			if (online) {
				this.#run("UPDATE agents SET online = 1, last_seen_at = ?, offline_at = NULL WHERE id = ?", at, id);
			} else {
				this.#run("UPDATE agents SET online = 0, offline_at = ?, state = 'idle', activity = NULL WHERE id = ?", at, id);
			}
			if ((row.online === 1) !== online) this.#emitPresence(row, online);
		});
	}

	/** Parent and children first. Then every agent with an open question or a live task with this agent, either way. */
	#emitPresence(row: AgentRow, online: boolean): void {
		const targets = new Map<string, PresenceEvent["relation"]>();
		if (row.parent) targets.set(row.parent, "child");
		for (const child of this.#all<{ id: string }>("SELECT id FROM agents WHERE parent = ?", row.id)) {
			targets.set(child.id, "parent");
		}
		const peers = this.#all<{ id: string }>(
			`SELECT recipient_agent AS id FROM expect_reply WHERE sender_agent = ? AND settled_at IS NULL
			 UNION SELECT sender_agent FROM expect_reply WHERE recipient_agent = ? AND settled_at IS NULL
			 UNION SELECT agent_id FROM tasks WHERE sender_agent = ? AND state NOT IN (${TERMINAL_SQL})
			 UNION SELECT sender_agent FROM tasks WHERE agent_id = ? AND sender_agent IS NOT NULL AND state NOT IN (${TERMINAL_SQL})`,
			row.id,
			row.id,
			row.id,
			row.id,
		);
		for (const peer of peers) if (!targets.has(peer.id)) targets.set(peer.id, "peer");
		targets.delete(row.id);
		for (const [target, relation] of targets) {
			this.#emit(target, "presence", { agent: row.id, name: row.name, online, relation });
		}
	}

	setState(id: string, state: unknown, activity: unknown): void {
		if (state !== "busy" && state !== "idle") throw new HubError("invalid", "state must be busy or idle");
		const text = optionalString(activity, "activity", 256);
		this.#run("UPDATE agents SET state = ?, activity = ?, last_seen_at = ? WHERE id = ?", state, text, this.iso(), id);
	}

	setTopics(id: string, subscribe: unknown, unsubscribe: unknown): string[] {
		const add = stringList(subscribe, "subscribe");
		const remove = new Set(stringList(unsubscribe, "unsubscribe"));
		return this.tx(() => {
			const row = this.requireAgent(id);
			const topics = [...new Set([...parseJson<string[]>(row.topics, []), ...add])].filter(
				(topic) => !remove.has(topic),
			);
			this.#run("UPDATE agents SET topics = ? WHERE id = ?", JSON.stringify(topics), id);
			return topics;
		});
	}

	control(fromId: string, target: unknown, action: unknown): void {
		const targetId = requireString(target, "target", 128);
		if (action !== "close") throw new HubError("invalid", "action must be close");
		this.tx(() => {
			const from = this.requireAgent(fromId);
			const row = this.agent(targetId);
			if (!row) throw new HubError("not-found", `unknown agent ${targetId}`);
			if (row.parent !== fromId || row.kind !== "pi") {
				throw new HubError("forbidden", `${targetId} is not a child of ${fromId}`);
			}
			if (row.online !== 1) throw new HubError("conflict", "offline");
			this.#emit(row.id, "control", { action: "close", from: { agent: from.id, name: from.name } });
		});
	}

	/** Returns the stored text. Every WORKING task of the agent shows it in `status.message`. */
	setStatus(id: string, text: unknown): string {
		if (typeof text !== "string") throw new HubError("invalid", "text must be a string");
		const clean = cleanStatusText(text);
		return this.tx(() => {
			const row = this.requireAgent(id);
			if (row.status_text === clean) return clean;
			const at = this.iso();
			this.#run("UPDATE agents SET status_text = ?, status_at = ?, last_seen_at = ? WHERE id = ?", clean, at, at, id);
			const working = this.#all<TaskRow>(
				"SELECT * FROM tasks WHERE agent_id = ? AND state = 'TASK_STATE_WORKING' ORDER BY created_at",
				id,
			);
			for (const task of working) {
				const current = parseJson<WireMessage | null>(task.status_message, null);
				if (clean === "") {
					if (current && isStatusTextMessage(current)) this.#writeStatus(task, "TASK_STATE_WORKING", undefined);
				} else {
					this.#writeStatus(task, "TASK_STATE_WORKING", this.#statusTextMessage(task, clean));
				}
			}
			return clean;
		});
	}

	#statusTextMessage(task: TaskRow, text: string): WireMessage {
		return {
			messageId: this.newId(),
			contextId: task.context_id,
			taskId: task.id,
			role: "ROLE_AGENT",
			parts: [{ text }],
			metadata: { [BUS_EXTENSION_URI]: { statusText: true } },
		};
	}

	// ---------- link mailbox ----------

	#emit<T extends LinkEventType>(agentId: string, type: T, payload: LinkEventMap[T]): number | undefined {
		const row = this.agent(agentId);
		if (!row || row.kind !== "pi") return undefined;
		const { lastInsertRowid: seq } = this.#run(
			"INSERT INTO link_events (agent_id, type, payload, created_at) VALUES (?, ?, ?, ?)",
			agentId,
			type,
			JSON.stringify(payload),
			this.iso(),
		);
		const event = { seq, type, payload } as LinkEvent;
		this.#afterCommit(() => {
			this.#notify(this.#linkListeners, agentId, event);
		});
		return seq;
	}

	unacked(agentId: string): LinkEvent[] {
		return this.#all<{ seq: number; type: LinkEventType; payload: string }>(
			"SELECT seq, type, payload FROM link_events WHERE agent_id = ? AND acked_at IS NULL ORDER BY seq",
			agentId,
		).map((row) => ({ seq: row.seq, type: row.type, payload: JSON.parse(row.payload) }) as LinkEvent);
	}

	/**
	 * The unacked events for a new stream, only those after `afterSeq` when given.
	 * A stale `close` must not end a process started later, so it is acked and skipped.
	 */
	replay(agentId: string, afterSeq?: number): LinkEvent[] {
		const cutoff = this.iso(this.now() - STALE_CONTROL_MS);
		this.#run(
			"UPDATE link_events SET acked_at = ? WHERE agent_id = ? AND type = 'control' AND acked_at IS NULL AND created_at < ?",
			this.iso(),
			agentId,
			cutoff,
		);
		const events = this.unacked(agentId);
		return afterSeq === undefined ? events : events.filter((event) => event.seq > afterSeq);
	}

	ack(agentId: string, upTo: unknown): number {
		if (typeof upTo !== "number" || !Number.isInteger(upTo) || upTo < 0) {
			throw new HubError("invalid", "upTo must be a non-negative integer");
		}
		const { changes } = this.#run(
			"UPDATE link_events SET acked_at = ? WHERE agent_id = ? AND seq <= ? AND acked_at IS NULL",
			this.iso(),
			agentId,
			upTo,
		);
		this.touch(agentId);
		this.#notify(this.#ackListeners, agentId, upTo);
		return changes;
	}

	isAcked(seq: number): boolean {
		const row = this.#get<{ acked_at: string | null }>("SELECT acked_at FROM link_events WHERE seq = ?", seq);
		return row?.acked_at !== null && row?.acked_at !== undefined;
	}

	waitForAck(agentId: string, seq: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
		if (this.isAcked(seq)) return Promise.resolve(true);
		return new Promise((resolve) => {
			const finish = (value: boolean) => {
				clearTimeout(timer);
				off();
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			};
			const onAbort = () => finish(false);
			const off = this.onAck((agent, upTo) => {
				if (agent === agentId && upTo >= seq) finish(true);
			});
			const timer = setTimeout(() => finish(this.isAcked(seq)), timeoutMs);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	// ---------- tasks: reads ----------

	#taskRow(id: string): TaskRow | undefined {
		return this.#get<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
	}

	#visible(task: TaskRow, agentId: string, caller: Caller): boolean {
		if (task.agent_id !== agentId) return false;
		if (caller.agent) return task.sender_agent === caller.agent || task.agent_id === caller.agent;
		if (task.sender_principal === caller.principal.name) return true;
		if (caller.principal.kind !== "host") return false;
		return this.agent(task.agent_id)?.host === caller.principal.name;
	}

	#visibleTask(agentId: string, caller: Caller, id: string): TaskRow {
		const row = id ? this.#taskRow(id) : undefined;
		if (!row || !this.#visible(row, agentId, caller)) throw new HubError("task-not-found", `Task not found: ${id}`);
		return row;
	}

	#toWire(row: TaskRow, options: { history?: boolean; artifacts?: boolean } = {}): WireTask {
		const task: WireTask = {
			id: row.id,
			contextId: row.context_id,
			status: { state: row.state, timestamp: row.status_at },
		};
		const message = parseJson<WireMessage | null>(row.status_message, null);
		if (message) task.status.message = message;
		if (options.artifacts !== false) {
			task.artifacts = this.#all<{ artifact: string }>(
				"SELECT artifact FROM artifacts WHERE task_id = ? ORDER BY seq",
				row.id,
			).map((item) => JSON.parse(item.artifact) as WireArtifact);
		}
		if (options.history !== false) {
			task.history = this.#all<{ message: string }>(
				"SELECT message FROM task_messages WHERE task_id = ? ORDER BY seq",
				row.id,
			).map((item) => JSON.parse(item.message) as WireMessage);
		}
		const metadata = parseJson<Record<string, unknown> | null>(row.metadata, null);
		if (metadata && Object.keys(metadata).length > 0) task.metadata = metadata;
		return task;
	}

	getTask(agentId: string, caller: Caller, id: string, historyLength?: number): WireTask {
		return applyHistoryLength(this.#toWire(this.#visibleTask(agentId, caller, id)), historyLength);
	}

	/** A read without a scope check. */
	readTask(id: string): WireTask | undefined {
		const row = this.#taskRow(id);
		return row ? this.#toWire(row) : undefined;
	}

	listTasks(agentId: string, caller: Caller, input: ListTasksInput): ListTasksResult {
		const where = ["agent_id = ?"];
		const params: SQLInputValue[] = [agentId];
		if (caller.agent) {
			where.push("(sender_agent = ? OR agent_id = ?)");
			params.push(caller.agent, caller.agent);
		} else if (caller.principal.kind === "host" && this.agent(agentId)?.host === caller.principal.name) {
			// every task of an agent bound to this host is visible
		} else {
			where.push("sender_principal = ?");
			params.push(caller.principal.name);
		}
		if (input.contextId) {
			where.push("context_id = ?");
			params.push(input.contextId);
		}
		if (input.state) {
			where.push("state = ?");
			params.push(input.state);
		}
		if (input.statusTimestampAfter) {
			where.push("status_at >= ?");
			params.push(new Date(input.statusTimestampAfter).toISOString());
		}
		const filter = where.join(" AND ");
		const totalSize = this.#get<{ n: number }>(`SELECT count(*) AS n FROM tasks WHERE ${filter}`, ...params)?.n ?? 0;
		let pageFilter = filter;
		const pageParams = [...params];
		if (input.pageToken) {
			const [statusAt, id] = decodePageToken(input.pageToken);
			pageFilter += " AND (status_at < ? OR (status_at = ? AND id < ?))";
			pageParams.push(statusAt, statusAt, id);
		}
		const rows = this.#all<TaskRow>(
			`SELECT * FROM tasks WHERE ${pageFilter} ORDER BY status_at DESC, id DESC LIMIT ?`,
			...pageParams,
			input.pageSize + 1,
		);
		const page = rows.slice(0, input.pageSize);
		const last = page.at(-1);
		return {
			tasks: page.map((row) =>
				applyHistoryLength(this.#toWire(row, { artifacts: input.includeArtifacts }), input.historyLength),
			),
			nextPageToken: rows.length > input.pageSize && last ? encodePageToken(last.status_at, last.id) : "",
			pageSize: input.pageSize,
			totalSize,
		};
	}

	// ---------- tasks: writes ----------

	#senderOf(caller: Caller): Sender {
		if (caller.agent) {
			const row = this.agent(caller.agent);
			if (row) return { agent: row.id, name: row.name, kind: row.kind };
		}
		return { name: caller.principal.name, kind: caller.principal.kind };
	}

	#emitTask(task: TaskRow, response: WireStreamResponse, state: WireState): void {
		const configs = this.#all<{ id: string }>("SELECT id FROM push_configs WHERE task_id = ?", task.id);
		if (configs.length > 0) {
			const payload = JSON.stringify(response);
			const at = this.now();
			for (const config of configs) {
				this.#run(
					"INSERT INTO push_outbox (task_id, config_id, payload, attempts, next_at) VALUES (?, ?, ?, 0, ?)",
					task.id,
					config.id,
					payload,
					at,
				);
				this.#run(
					`DELETE FROM push_outbox WHERE task_id = ? AND config_id = ? AND id NOT IN
					 (SELECT id FROM push_outbox WHERE task_id = ? AND config_id = ? ORDER BY id DESC LIMIT ?)`,
					task.id,
					config.id,
					task.id,
					config.id,
					PUSH_BACKLOG_MAX,
				);
			}
		}
		const event: TaskEvent = { taskId: task.id, agentId: task.agent_id, state, response };
		this.#afterCommit(() => {
			this.#notify(this.#taskListeners.get(task.id) ?? [], event);
			if (configs.length > 0) this.#notify(this.#pushListeners);
		});
	}

	#appendHistory(taskId: string, message: WireMessage): void {
		const next =
			(this.#get<{ n: number | null }>("SELECT max(seq) AS n FROM task_messages WHERE task_id = ?", taskId)?.n ?? 0) +
			1;
		this.#run(
			"INSERT INTO task_messages (task_id, seq, message) VALUES (?, ?, ?)",
			taskId,
			next,
			JSON.stringify(message),
		);
	}

	#writeStatus(task: TaskRow, state: WireState, message: WireMessage | undefined): WireStatus {
		const at = this.iso();
		this.#run(
			"UPDATE tasks SET state = ?, status_message = ?, status_at = ?, updated_at = ? WHERE id = ?",
			state,
			message ? JSON.stringify(message) : null,
			at,
			at,
			task.id,
		);
		const status: WireStatus = { state, timestamp: at };
		if (message) status.message = message;
		this.#emitTask(task, { statusUpdate: { taskId: task.id, contextId: task.context_id, status } }, state);
		return status;
	}

	#insertInbox(
		agentId: string,
		sender: Sender,
		caller: Caller,
		contextId: string,
		taskId: string | null,
		meta: NormalizedMeta,
		message: WireMessage,
	): void {
		this.#run(
			`INSERT INTO messages (id, agent_id, sender_agent, sender_principal, sender_name, sender_kind, context_id, task_id, kind, meta, message, created_at, reply_to)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			message.messageId,
			agentId,
			sender.agent ?? null,
			caller.principal.name,
			sender.name,
			sender.kind,
			contextId,
			taskId,
			meta.kind,
			JSON.stringify(meta),
			JSON.stringify(message),
			this.iso(),
			meta.replyTo ?? null,
		);
	}

	send(input: SendInput): SendResult {
		const { caller } = input;
		const incoming = input.message;
		if (!incoming.messageId) throw new HubError("invalid", "message.messageId is required");
		const meta = parseBusMetadata(incoming.metadata);
		if (input.pushConfig) validatePushUrl(input.pushConfig.url, this.#pushGuard);
		return this.tx(() => {
			const agent = this.requireAgent(input.agentId);
			const sender = this.#senderOf(caller);
			let task: TaskRow | undefined;
			let created = false;
			let contextId: string;
			let stored: WireMessage;
			if (incoming.taskId) {
				task = this.#visibleTask(agent.id, caller, incoming.taskId);
				if (isTerminal(task.state)) {
					throw new HubError("task-terminal", `Task ${task.id} is in a terminal state and cannot accept messages`);
				}
				if (incoming.contextId && incoming.contextId !== task.context_id) {
					throw new HubError("invalid", `contextId ${incoming.contextId} does not match task ${task.id}`);
				}
				contextId = task.context_id;
				stored = { ...incoming, taskId: task.id, contextId };
				this.#appendHistory(task.id, stored);
				this.#run("UPDATE tasks SET updated_at = ? WHERE id = ?", this.iso(), task.id);
				if (INTERRUPTED_STATES.has(task.state)) {
					const statusText = agent.status_text ? this.#statusTextMessage(task, agent.status_text) : undefined;
					this.#writeStatus(task, "TASK_STATE_WORKING", statusText);
					task = { ...task, state: "TASK_STATE_WORKING" };
				}
			} else if (TASK_KINDS.includes(meta.kind)) {
				const at = this.iso();
				const id = this.newId();
				contextId = incoming.contextId || this.newId();
				stored = { ...incoming, taskId: id, contextId };
				this.#run(
					`INSERT INTO tasks (id, agent_id, sender_agent, sender_principal, context_id, state, status_message, status_at, kind, metadata, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, 'TASK_STATE_SUBMITTED', NULL, ?, ?, NULL, ?, ?)`,
					id,
					agent.id,
					sender.agent ?? null,
					caller.principal.name,
					contextId,
					at,
					meta.kind,
					at,
					at,
				);
				this.#appendHistory(id, stored);
				task = this.#taskRow(id);
				created = true;
			} else {
				contextId = incoming.contextId || this.newId();
				stored = { ...incoming, contextId };
			}
			if (task && input.pushConfig) {
				this.#savePushConfig(task, caller, { ...input.pushConfig, taskId: task.id });
			}
			if (task && created) {
				const snapshot = this.#toWire(task);
				this.#emitTask(task, { task: snapshot }, task.state);
			}
			this.#insertInbox(agent.id, sender, caller, contextId, task?.id ?? null, meta, stored);
			const payload: LinkEventMap["message"] = {
				messageId: stored.messageId,
				contextId,
				from: sender,
				kind: meta.kind,
				wake: meta.wake,
				text: messageText(stored),
			};
			if (task) {
				payload.taskId = task.id;
				payload.taskState = linkState(task.state);
			}
			if (meta.subject !== undefined) payload.subject = meta.subject;
			if (meta.priority !== undefined) payload.priority = meta.priority;
			if (meta.expectReply) payload.expectReply = true;
			if (meta.replyTo !== undefined) payload.replyTo = meta.replyTo;
			if (meta.data !== undefined) payload.data = meta.data;
			const eventSeq = this.#emit(agent.id, "message", payload);
			if (meta.expectReply && caller.agent) {
				this.#run(
					`INSERT INTO expect_reply (sender_agent, message_id, recipient_agent, context_id, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
					 ON CONFLICT (sender_agent, message_id, recipient_agent) DO NOTHING`,
					caller.agent,
					stored.messageId,
					agent.id,
					contextId,
					task?.id ?? null,
					this.iso(),
				);
			}
			if (meta.replyTo) {
				if (caller.agent) {
					this.#run(
						`UPDATE expect_reply SET settled_at = ?
						 WHERE sender_agent = ? AND message_id = ? AND recipient_agent = ? AND settled_at IS NULL`,
						this.iso(),
						agent.id,
						meta.replyTo,
						caller.agent,
					);
				} else {
					this.#run(
						"UPDATE expect_reply SET settled_at = ? WHERE sender_agent = ? AND message_id = ? AND settled_at IS NULL",
						this.iso(),
						agent.id,
						meta.replyTo,
					);
				}
			}
			if (task) return { task: this.#toWire(this.#taskRow(task.id) ?? task), created, eventSeq, meta };
			const reply: WireMessage = {
				messageId: this.newId(),
				contextId,
				role: "ROLE_AGENT",
				parts: [{ text: "stored" }],
			};
			return { message: reply, created, eventSeq, meta };
		});
	}

	/** Applies one change from the agent side. */
	applyChange(taskId: string, change: TaskChange): WireTask {
		return this.tx(() => {
			const task = this.#taskRow(taskId);
			if (!task) throw new HubError("task-not-found", `Task not found: ${taskId}`);
			if (isTerminal(task.state)) throw new HubError("task-terminal", `Task ${taskId} is already ${task.state}`);
			const agent = this.requireAgent(task.agent_id);
			const updated: { name?: string; text?: string }[] = [];
			for (const item of change.artifacts ?? []) {
				const artifact = this.#mergeArtifact(task, item.artifact, item.append === true);
				const update: WireArtifactUpdate = { taskId: task.id, contextId: task.context_id, artifact: item.artifact };
				if (item.append) update.append = true;
				if (item.lastChunk !== false) update.lastChunk = true;
				this.#emitTask(task, { artifactUpdate: update }, task.state);
				const entry: { name?: string; text?: string } = {};
				if (artifact.name) entry.name = artifact.name;
				const text = messageText(artifact);
				if (text) entry.text = text;
				updated.push(entry);
			}
			let state = task.state;
			let message = change.message;
			if (message) {
				message = { ...message, taskId: task.id, contextId: task.context_id };
				this.#appendHistory(task.id, message);
			}
			if (change.state) {
				state = change.state;
				const statusMessage =
					message ??
					(state === "TASK_STATE_WORKING" && agent.status_text
						? this.#statusTextMessage(task, agent.status_text)
						: undefined);
				this.#writeStatus(task, state, statusMessage);
			} else {
				this.#run("UPDATE tasks SET updated_at = ? WHERE id = ?", this.iso(), task.id);
			}
			if (task.sender_agent) {
				const update: LinkEventMap["update"] = {
					taskId: task.id,
					contextId: task.context_id,
					state: linkState(state),
					from: { agent: agent.id, name: agent.name },
				};
				const text = messageText(message);
				if (message && text) {
					const meta = updateMeta(state);
					this.#insertInbox(
						task.sender_agent,
						{ agent: agent.id, name: agent.name, kind: agent.kind },
						{ principal: { name: agent.host ?? agent.id, kind: "host" }, agent: agent.id },
						task.context_id,
						task.id,
						meta,
						message,
					);
					update.messageId = message.messageId;
					update.kind = meta.kind;
					update.text = text;
				}
				if (updated.length > 0) update.artifacts = updated;
				this.#emit(task.sender_agent, "update", update);
			}
			if (task.sender_agent && (isTerminal(state) || INTERRUPTED_STATES.has(state))) {
				this.#settleTask(task);
			}
			return this.#toWire(this.#taskRow(task.id) ?? task);
		});
	}

	#mergeArtifact(task: TaskRow, artifact: WireArtifact, append: boolean): WireArtifact {
		if (!artifact.artifactId) throw new HubError("invalid", "artifact.artifactId is required");
		const existing = this.#get<{ artifact: string; seq: number }>(
			"SELECT artifact, seq FROM artifacts WHERE task_id = ? AND artifact_id = ?",
			task.id,
			artifact.artifactId,
		);
		if (existing) {
			const previous = JSON.parse(existing.artifact) as WireArtifact;
			const merged = append ? { ...previous, parts: [...previous.parts, ...artifact.parts] } : artifact;
			this.#run(
				"UPDATE artifacts SET artifact = ? WHERE task_id = ? AND artifact_id = ?",
				JSON.stringify(merged),
				task.id,
				artifact.artifactId,
			);
			return merged;
		}
		const seq =
			(this.#get<{ n: number | null }>("SELECT max(seq) AS n FROM artifacts WHERE task_id = ?", task.id)?.n ?? 0) + 1;
		this.#run(
			"INSERT INTO artifacts (task_id, artifact_id, seq, artifact) VALUES (?, ?, ?, ?)",
			task.id,
			artifact.artifactId,
			seq,
			JSON.stringify(artifact),
		);
		return artifact;
	}

	/** `POST /link/<agent>/tasks/<taskId>`. */
	linkUpdate(agentId: string, taskId: string, body: TaskUpdateBody): WireTask {
		if (!body || typeof body !== "object") throw new HubError("invalid", "body must be an object");
		if (typeof body.state !== "string" || !LINK_POST_STATES.has(body.state)) {
			throw new HubError("invalid", "state must be working, input-required, completed, failed, or rejected");
		}
		const task = this.#taskRow(taskId);
		if (!task || task.agent_id !== agentId) throw new HubError("task-not-found", `Task not found: ${taskId}`);
		if (isTerminal(task.state)) throw new HubError("task-terminal", `Task ${taskId} is already ${task.state}`);
		const change: TaskChange = { state: wireState(body.state as LinkPostState) };
		if (body.text !== undefined) {
			if (typeof body.text !== "string") throw new HubError("invalid", "text must be a string");
			if (body.text !== "") change.message = this.agentMessage(body.text);
		}
		if (body.artifact !== undefined) {
			const spec = body.artifact;
			if (!spec || typeof spec !== "object") throw new HubError("invalid", "artifact must be an object");
			const parts: WirePart[] = [];
			if (typeof spec.text === "string") parts.push({ text: spec.text });
			if (spec.data !== undefined) parts.push({ data: spec.data, mediaType: "application/json" });
			if (parts.length === 0) throw new HubError("invalid", "artifact needs text or data");
			const artifact: WireArtifact = { artifactId: this.newId(), parts };
			if (typeof spec.name === "string" && spec.name !== "") artifact.name = spec.name;
			change.artifacts = [{ artifact }];
		}
		this.touch(agentId);
		return this.applyChange(taskId, change);
	}

	agentMessage(text: string): WireMessage {
		return { messageId: this.newId(), role: "ROLE_AGENT", parts: [{ text }] };
	}

	cancel(agentId: string, caller: Caller, id: string): WireTask {
		return this.tx(() => {
			const task = this.#visibleTask(agentId, caller, id);
			if (isTerminal(task.state)) throw new HubError("not-cancelable", `Task not cancelable: ${id}`);
			this.#writeStatus(task, "TASK_STATE_CANCELED", undefined);
			this.#emit(task.agent_id, "cancel", { taskId: task.id });
			if (task.sender_agent) {
				const agent = this.requireAgent(task.agent_id);
				this.#emit(task.sender_agent, "update", {
					taskId: task.id,
					contextId: task.context_id,
					state: "canceled",
					from: { agent: agent.id, name: agent.name },
				});
				this.#settleTask(task);
			}
			return this.#toWire(this.#taskRow(task.id) ?? task);
		});
	}

	#settleTask(task: TaskRow): void {
		this.#run(
			"UPDATE expect_reply SET settled_at = ? WHERE sender_agent = ? AND task_id = ? AND settled_at IS NULL",
			this.iso(),
			task.sender_agent,
			task.id,
		);
	}

	/** Resolves once the task reaches a state that `stop` accepts, the timeout passes, or `signal` aborts. */
	waitForTask(
		taskId: string,
		stop: (state: WireState) => boolean,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		const row = this.#taskRow(taskId);
		if (!row || stop(row.state)) return Promise.resolve();
		return new Promise((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				off();
				signal?.removeEventListener("abort", finish);
				resolve();
			};
			const off = this.onTask(taskId, (event) => {
				if (stop(event.state)) finish();
			});
			const timer = setTimeout(finish, timeoutMs);
			if (signal?.aborted) finish();
			else signal?.addEventListener("abort", finish, { once: true });
		});
	}

	// ---------- push configs ----------

	#savePushConfig(task: TaskRow, caller: Caller, config: Omit<WirePushConfig, "id"> & { id?: string }): WirePushConfig {
		validatePushUrl(config.url, this.#pushGuard);
		const id = config.id || this.newId();
		const auth = config.authentication;
		const owner = this.#get<{ principal: string }>(
			"SELECT principal FROM push_configs WHERE task_id = ? AND id = ?",
			task.id,
			id,
		);
		if (owner && owner.principal !== caller.principal.name) {
			throw new HubError("invalid", `push config id ${id} is in use on task ${task.id}`);
		}
		this.#run(
			`INSERT INTO push_configs (task_id, id, url, token, auth_scheme, auth_credentials, principal, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (task_id, id) DO UPDATE SET url = excluded.url, token = excluded.token,
			   auth_scheme = excluded.auth_scheme, auth_credentials = excluded.auth_credentials`,
			task.id,
			id,
			config.url,
			config.token || null,
			auth?.scheme || null,
			auth?.credentials || null,
			caller.principal.name,
			this.iso(),
		);
		return pushConfigWire(
			this.#get<PushConfigRow>("SELECT * FROM push_configs WHERE task_id = ? AND id = ?", task.id, id),
		);
	}

	createPushConfig(
		agentId: string,
		caller: Caller,
		config: Omit<WirePushConfig, "id"> & { id?: string },
	): WirePushConfig {
		return this.tx(() => this.#savePushConfig(this.#visibleTask(agentId, caller, config.taskId), caller, config));
	}

	/** A push config belongs to the principal that made it. Others cannot see, change, or delete it. */
	getPushConfig(agentId: string, caller: Caller, taskId: string, id: string): WirePushConfig {
		this.#visibleTask(agentId, caller, taskId);
		const row = this.#get<PushConfigRow>(
			"SELECT * FROM push_configs WHERE task_id = ? AND id = ? AND principal = ?",
			taskId,
			id,
			caller.principal.name,
		);
		if (!row) throw new HubError("task-not-found", `Push notification config ${id} not found for task ${taskId}`);
		return pushConfigWire(row);
	}

	listPushConfigs(agentId: string, caller: Caller, taskId: string): WirePushConfig[] {
		this.#visibleTask(agentId, caller, taskId);
		return this.#all<PushConfigRow>(
			"SELECT * FROM push_configs WHERE task_id = ? AND principal = ? ORDER BY created_at, id",
			taskId,
			caller.principal.name,
		).map((row) => pushConfigWire(row));
	}

	deletePushConfig(agentId: string, caller: Caller, taskId: string, id: string): void {
		this.#visibleTask(agentId, caller, taskId);
		this.tx(() => {
			const owner = this.#get<{ principal: string }>(
				"SELECT principal FROM push_configs WHERE task_id = ? AND id = ?",
				taskId,
				id,
			);
			if (owner && owner.principal !== caller.principal.name) {
				throw new HubError("task-not-found", `Push notification config ${id} not found for task ${taskId}`);
			}
			this.#run("DELETE FROM push_configs WHERE task_id = ? AND id = ?", taskId, id);
		});
	}

	/** The oldest due row of each config. Later rows of a config wait, so each webhook gets events in order. */
	duePushes(now: number, limit: number): OutboxItem[] {
		return this.#all<{
			id: number;
			task_id: string;
			config_id: string;
			payload: string;
			attempts: number;
			next_at: number;
			url: string;
			token: string | null;
			auth_scheme: string | null;
			auth_credentials: string | null;
		}>(
			`SELECT o.id, o.task_id, o.config_id, o.payload, o.attempts, o.next_at, c.url, c.token, c.auth_scheme, c.auth_credentials
			 FROM push_outbox o JOIN push_configs c ON c.task_id = o.task_id AND c.id = o.config_id
			 WHERE o.id IN (SELECT min(id) FROM push_outbox GROUP BY task_id, config_id) AND o.next_at <= ?
			 ORDER BY o.id LIMIT ?`,
			now,
			limit,
		).map((row) => ({
			id: row.id,
			taskId: row.task_id,
			configId: row.config_id,
			url: row.url,
			token: row.token,
			authScheme: row.auth_scheme,
			authCredentials: row.auth_credentials,
			payload: row.payload,
			attempts: row.attempts,
			nextAt: row.next_at,
		}));
	}

	nextPushAt(): number | undefined {
		const row = this.#get<{ at: number | null }>(
			"SELECT min(next_at) AS at FROM push_outbox WHERE id IN (SELECT min(id) FROM push_outbox GROUP BY task_id, config_id)",
		);
		return row?.at ?? undefined;
	}

	pushDone(id: number): void {
		this.#run("DELETE FROM push_outbox WHERE id = ?", id);
	}

	pushRetry(id: number, attempts: number, nextAt: number): void {
		this.#run("UPDATE push_outbox SET attempts = ?, next_at = ? WHERE id = ?", attempts, nextAt, id);
	}

	// ---------- inbox ----------

	static readonly #MESSAGE_SELECT =
		"SELECT m.*, a.name AS to_name, t.state AS task_state FROM messages m LEFT JOIN agents a ON a.id = m.agent_id LEFT JOIN tasks t ON t.id = m.task_id";

	#inboxItem(row: MessageItemRow, me: string): InboxItem {
		const message = JSON.parse(row.message) as WireMessage;
		const meta = parseJson<Partial<NormalizedMeta>>(row.meta, {});
		const from: Sender = { name: row.sender_name, kind: row.sender_kind as Sender["kind"] };
		if (row.sender_agent) from.agent = row.sender_agent;
		const item: InboxItem = {
			messageId: row.id,
			taskId: row.task_id,
			contextId: row.context_id,
			direction: row.agent_id === me ? "in" : "out",
			from,
			to: { agent: row.agent_id, name: row.to_name ?? row.agent_id },
			kind: row.kind as BusKind,
			wake: meta.wake ?? "now",
			subject: meta.subject ?? null,
			priority: meta.priority ?? null,
			expectReply: meta.expectReply === true,
			replyTo: row.reply_to,
			text: messageText(message),
			createdAt: row.created_at,
			read: row.read_at !== null,
		};
		if (meta.data !== undefined) item.data = meta.data;
		if (row.task_state) item.taskState = linkState(row.task_state);
		return item;
	}

	inbox(agentId: string, unreadOnly: boolean, limit: number): InboxItem[] {
		const unread = unreadOnly ? " AND m.read_at IS NULL" : "";
		return this.#all<MessageItemRow>(
			`${Engine.#MESSAGE_SELECT} WHERE m.agent_id = ?${unread} ORDER BY m.seq DESC LIMIT ?`,
			agentId,
			limit,
		).map((row) => this.#inboxItem(row, agentId));
	}

	markRead(agentId: string, ids: unknown): number {
		const list = stringList(ids, "ids");
		return this.tx(() => {
			let changes = 0;
			const at = this.iso();
			for (const id of list) {
				changes += this.#run(
					"UPDATE messages SET read_at = ? WHERE agent_id = ? AND id = ? AND read_at IS NULL",
					at,
					agentId,
					id,
				).changes;
			}
			return changes;
		});
	}

	/** One inbox or sent message. A prefix that matches more than one row gives 409 with the candidates. */
	message(agentId: string, idOrPrefix: string): InboxItem {
		if (!idOrPrefix) throw new HubError("invalid", "message id is required");
		const rows = this.#all<MessageItemRow>(
			`${Engine.#MESSAGE_SELECT} WHERE (m.agent_id = ? OR m.sender_agent = ?) AND substr(m.id, 1, ?) = ? ORDER BY m.seq DESC LIMIT 50`,
			agentId,
			agentId,
			idOrPrefix.length,
			idOrPrefix,
		);
		const exact = rows.filter((row) => row.id === idOrPrefix);
		const matches = exact.length > 0 ? exact : rows;
		const only = matches[0];
		if (!only) throw new HubError("not-found", `no message ${idOrPrefix}`);
		if (matches.length > 1) {
			throw new HubError("conflict", `message id ${idOrPrefix} is ambiguous`, {
				candidates: matches.map((row) => ({
					messageId: row.id,
					contextId: row.context_id,
					to: row.agent_id,
					from: row.sender_agent ?? row.sender_name,
					createdAt: row.created_at,
				})),
			});
		}
		return this.#inboxItem(only, agentId);
	}

	/** Every message this agent sent or got in one context, oldest first. */
	thread(agentId: string, contextOrPrefix: string): ThreadResult {
		if (!contextOrPrefix) throw new HubError("invalid", "context id is required");
		const contexts = this.#all<{ context_id: string; n: number; last: string }>(
			`SELECT context_id, count(*) AS n, max(created_at) AS last FROM messages
			 WHERE (agent_id = ? OR sender_agent = ?) AND substr(context_id, 1, ?) = ?
			 GROUP BY context_id ORDER BY last DESC LIMIT 50`,
			agentId,
			agentId,
			contextOrPrefix.length,
			contextOrPrefix,
		);
		const exact = contexts.find((row) => row.context_id === contextOrPrefix);
		const matches = exact ? [exact] : contexts;
		const only = matches[0];
		if (!only) throw new HubError("not-found", `no thread ${contextOrPrefix}`);
		if (matches.length > 1) {
			throw new HubError("conflict", `context id ${contextOrPrefix} is ambiguous`, {
				candidates: matches.map((row) => ({ contextId: row.context_id, messages: row.n, lastAt: row.last })),
			});
		}
		const messages = this.#all<MessageItemRow>(
			`${Engine.#MESSAGE_SELECT} WHERE (m.agent_id = ? OR m.sender_agent = ?) AND m.context_id = ? ORDER BY m.seq`,
			agentId,
			agentId,
			only.context_id,
		).map((row) => this.#inboxItem(row, agentId));
		return { contextId: only.context_id, messages };
	}

	/** What this agent waits for: its open questions and the live tasks it sent. */
	pending(agentId: string): PendingResult {
		return this.#openItems(agentId, "sender_agent", "recipient_agent", "sender_agent", "agent_id");
	}

	/** What others wait for from this agent: open questions to it and the live tasks it got. */
	owed(agentId: string): PendingResult {
		return this.#openItems(agentId, "recipient_agent", "sender_agent", "agent_id", "sender_agent");
	}

	#openItems(
		agentId: string,
		replyMe: "sender_agent" | "recipient_agent",
		replyOther: "sender_agent" | "recipient_agent",
		taskMe: "sender_agent" | "agent_id",
		taskOther: "sender_agent" | "agent_id",
	): PendingResult {
		const expectReply = this.#all<{
			message_id: string;
			context_id: string;
			task_id: string | null;
			other: string;
			other_name: string | null;
			created_at: string;
		}>(
			`SELECT e.message_id, e.context_id, e.task_id, e.${replyOther} AS other, a.name AS other_name, e.created_at
			 FROM expect_reply e LEFT JOIN agents a ON a.id = e.${replyOther}
			 WHERE e.${replyMe} = ? AND e.settled_at IS NULL ORDER BY e.created_at, e.message_id`,
			agentId,
		).map((row) => ({
			messageId: row.message_id,
			contextId: row.context_id,
			taskId: row.task_id,
			agent: row.other,
			name: row.other_name ?? row.other,
			createdAt: row.created_at,
		}));
		const tasks = this.#all<TaskRow & { other: string | null; other_name: string | null }>(
			`SELECT t.*, t.${taskOther} AS other, a.name AS other_name FROM tasks t LEFT JOIN agents a ON a.id = t.${taskOther}
			 WHERE t.${taskMe} = ? AND t.state NOT IN (${TERMINAL_SQL}) ORDER BY t.created_at, t.id`,
			agentId,
		).map((row) => ({
			taskId: row.id,
			contextId: row.context_id,
			agent: row.other,
			name: row.other_name ?? row.other ?? row.sender_principal,
			state: linkState(row.state),
			createdAt: row.created_at,
		}));
		return { expectReply, tasks };
	}

	// ---------- retention ----------

	sweep(): { tasks: number; messages: number; events: number; replies: number; agents: number } {
		return this.tx(() => {
			const cutoff = this.iso(this.now() - RETENTION_MS);
			const ephemeralCutoff = this.iso(this.now() - EPHEMERAL_TTL_MS);
			const tasks = this.#run(`DELETE FROM tasks WHERE updated_at < ? AND state IN (${TERMINAL_SQL})`, cutoff).changes;
			const messages = this.#run("DELETE FROM messages WHERE created_at < ?", cutoff).changes;
			const events = this.#run("DELETE FROM link_events WHERE acked_at IS NOT NULL AND created_at < ?", cutoff).changes;
			const replies = this.#run(
				"DELETE FROM expect_reply WHERE settled_at IS NOT NULL AND settled_at < ?",
				cutoff,
			).changes;
			const offlineCutoff = this.iso(this.now() - OFFLINE_TTL_MS);
			const gone = this.#all<{ id: string }>(
				`SELECT id FROM agents WHERE kind = 'pi' AND online = 0 AND offline_at IS NOT NULL
				 AND ((ephemeral = 1 AND offline_at < ?) OR offline_at < ?)`,
				ephemeralCutoff,
				offlineCutoff,
			);
			const removed = { tasks, messages, events, replies, agents: 0 };
			// The id may be registered again by another host, which must not see the old rows.
			for (const { id } of gone) {
				removed.messages += this.#run("DELETE FROM messages WHERE agent_id = ? OR sender_agent = ?", id, id).changes;
				removed.tasks += this.#run("DELETE FROM tasks WHERE agent_id = ? OR sender_agent = ?", id, id).changes;
				removed.replies += this.#run(
					"DELETE FROM expect_reply WHERE sender_agent = ? OR recipient_agent = ?",
					id,
					id,
				).changes;
				removed.events += this.#run("DELETE FROM link_events WHERE agent_id = ?", id).changes;
				removed.agents += this.#run("DELETE FROM agents WHERE id = ?", id).changes;
			}
			return removed;
		});
	}
}

/** Inbox metadata for a task update that carried text. A plain progress note does not wake the sender. */
function updateMeta(state: WireState): NormalizedMeta {
	if (isTerminal(state)) return { kind: "result", wake: "now" };
	if (INTERRUPTED_STATES.has(state)) return { kind: "question", wake: "now" };
	return { kind: "status", wake: "never" };
}

function isStatusTextMessage(message: WireMessage): boolean {
	const meta = message.metadata?.[BUS_EXTENSION_URI] as { statusText?: unknown } | undefined;
	return meta?.statusText === true;
}

export function validatePushUrl(url: unknown, guard: PushGuard): void {
	if (typeof url !== "string" || url === "") throw new HubError("invalid", "push config url is required");
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new HubError("invalid", "push config url is not a valid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new HubError("invalid", "push config url must use http or https");
	}
	const refused = guard.checkUrl(parsed);
	if (refused) throw new HubError("invalid", refused);
}

function pushConfigWire(row: PushConfigRow | undefined): WirePushConfig {
	if (!row) throw new HubError("task-not-found", "push config not found");
	const config: WirePushConfig = { id: row.id, taskId: row.task_id, url: row.url };
	if (row.token) config.token = row.token;
	if (row.auth_scheme) {
		config.authentication = { scheme: row.auth_scheme };
		if (row.auth_credentials) config.authentication.credentials = row.auth_credentials;
	}
	return config;
}
