import {
	type Engine,
	type ExternalJob,
	HubError,
	INTERRUPTED_STATES,
	isTerminal,
	messageText,
	type RemoteTask,
	type TaskChange,
	type WireArtifact,
	type WireMessage,
	type WireState,
} from "./engine.ts";
import { cardUrl, type ExternalAgentConfig } from "./external.ts";

/** Time to the response headers of a request to an external agent. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** Failed card fetches in a row before the agent shows offline. */
export const CARD_FAILURES_OFFLINE = 3;
/** Rate-limit answers before the task fails. */
export const RATE_LIMIT_RETRIES = 5;
const OFFLINE_BACKOFF_MAX_MS = 60_000;
const MAX_SKILLS = 32;

const ERR_TASK_NOT_FOUND = -32001;
const ERR_UNAUTHORIZED = -32050;
const ERR_RATE_LIMITED = -32051;
const ERR_UNTRUSTED_PEER = -32052;

/** Errors that mean the request never reached the agent, so a resend is safe. */
const CONNECT_ERRORS = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
]);

export interface ExternalSkill {
	id: string;
	name: string;
	description: string;
	tags: string[];
}

export interface ExternalCard {
	description: string;
	skills: ExternalSkill[];
}

export interface GatewayOptions {
	fetch?: typeof fetch;
	log?: (line: string) => void;
	connectTimeoutMs?: number;
}

type StopReason = "stop" | "cancel" | "removed";

interface Running {
	taskId: string;
	agentId: string;
	controller: AbortController;
	reason: StopReason | undefined;
}

interface CardState {
	skills: ExternalSkill[];
	failures: number;
	timer: NodeJS.Timeout | undefined;
}

interface RemoteTaskWire {
	id?: unknown;
	contextId?: unknown;
	status?: { state?: unknown; message?: { parts?: { text?: unknown }[] } };
	artifacts?: unknown[];
}

interface RpcAnswer {
	status: number;
	result?: unknown;
	error?: { code?: unknown; message?: unknown };
}

class Outcome {
	readonly kind: "settled" | "drop" | "retry" | "unreachable" | "failed";
	readonly detail: string;

	constructor(kind: Outcome["kind"], detail = "") {
		this.kind = kind;
		this.detail = detail;
	}
}

function errorCode(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string") return code;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

function explain(error: unknown): string {
	const code = errorCode(error);
	const message = error instanceof Error ? error.message : String(error);
	return code && !message.includes(code) ? `${message} (${code})` : message;
}

function wireText(message: { parts?: { text?: unknown }[] } | undefined): string {
	return (message?.parts ?? [])
		.map((part) => part.text)
		.filter((text): text is string => typeof text === "string")
		.join("\n");
}

function asState(value: unknown): WireState | undefined {
	return typeof value === "string" && value.startsWith("TASK_STATE_") ? (value as WireState) : undefined;
}

function ends(state: WireState): boolean {
	return isTerminal(state) || INTERRUPTED_STATES.has(state);
}

function asArtifact(value: unknown): WireArtifact | undefined {
	if (!value || typeof value !== "object") return undefined;
	const artifact = value as Partial<WireArtifact>;
	if (typeof artifact.artifactId !== "string" || artifact.artifactId === "" || !Array.isArray(artifact.parts)) {
		return undefined;
	}
	return artifact as WireArtifact;
}

export function parseSkills(card: unknown): ExternalSkill[] {
	const skills = (card as { skills?: unknown } | null)?.skills;
	if (!Array.isArray(skills)) return [];
	const out: ExternalSkill[] = [];
	for (const item of skills.slice(0, MAX_SKILLS)) {
		const skill = item as Record<string, unknown> | null;
		if (!skill || typeof skill["id"] !== "string" || typeof skill["name"] !== "string") continue;
		const tags = Array.isArray(skill["tags"]) ? skill["tags"].filter((tag) => typeof tag === "string") : [];
		out.push({
			id: skill["id"],
			name: skill["name"],
			description: typeof skill["description"] === "string" ? skill["description"] : "",
			tags: tags as string[],
		});
	}
	return out;
}

/** The sender line that tells the external agent which pi session asks. */
export function outboundText(text: string, senderName: string, senderHost: string | null): string {
	return `${senderHost ? `[from ${senderName} on ${senderHost}]` : `[from ${senderName}]`}\n${text}`;
}

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});

/**
 * Sends hub tasks of external agents, such as Hermes, with SendStreamingMessage and maps the events back.
 * One dispatch per (agent, context) at a time: the agent may interrupt a running turn of the same context.
 * Push is never sent to the agent. Hub clients keep using hub push on the hub task.
 */
export class ExternalGateway {
	readonly #engine: Engine;
	readonly #fetch: typeof fetch;
	readonly #log: (line: string) => void;
	readonly #connectTimeoutMs: number;
	readonly #agents = new Map<string, ExternalAgentConfig>();
	readonly #cards = new Map<string, CardState>();
	readonly #running = new Map<string, Running>();
	readonly #claimed = new Set<number>();
	readonly #logged = new Set<string>();
	readonly #shutdown = new AbortController();
	#timer: NodeJS.Timeout | undefined;
	#timerAt = Number.POSITIVE_INFINITY;
	#off: (() => void) | undefined;
	#started = false;
	#stopped = false;

	constructor(engine: Engine, options: GatewayOptions = {}) {
		this.#engine = engine;
		this.#fetch = options.fetch ?? fetch;
		this.#log = options.log ?? (() => {});
		this.#connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
	}

	get size(): number {
		return this.#agents.size;
	}

	/** Loads or reloads the agent list. A removed agent goes offline and its running dispatches fail. */
	configure(agents: readonly ExternalAgentConfig[]): void {
		const next = new Map<string, ExternalAgentConfig>();
		for (const agent of agents) {
			try {
				this.#engine.ensureExternal(agent.id, agent.name);
				next.set(agent.id, agent);
			} catch (error) {
				this.#log(`external agent ${agent.id} skipped: ${explain(error)}`);
			}
		}
		for (const id of this.#agents.keys()) {
			if (next.has(id)) continue;
			this.#stopCard(id);
			this.#cards.delete(id);
			this.#engine.setOnline(id, false);
			for (const running of this.#running.values()) if (running.agentId === id) this.#abort(running, "removed");
		}
		this.#agents.clear();
		for (const [id, agent] of next) this.#agents.set(id, agent);
		this.#logged.clear();
		if (this.#started) {
			for (const id of this.#agents.keys()) this.#refreshCard(id);
			this.#kick();
		}
	}

	start(): void {
		this.#started = true;
		this.#off = this.#engine.onExternal(() => this.#kick());
		for (const id of this.#agents.keys()) this.#refreshCard(id);
		for (const remote of this.#engine.activeRemotes()) this.#resume(remote);
		this.#kick();
	}

	/** Leaves every row as it is, so the next start recovers the open dispatches. */
	stop(): void {
		this.#stopped = true;
		this.#shutdown.abort();
		this.#off?.();
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		for (const id of this.#cards.keys()) this.#stopCard(id);
		for (const running of this.#running.values()) this.#abort(running, "stop");
	}

	/** Card fields for `/a2a/<id>`: the configured description and the skills of the last good card. */
	card(agentId: string): ExternalCard | undefined {
		const agent = this.#agents.get(agentId);
		if (!agent) return undefined;
		return { description: agent.description, skills: this.#cards.get(agentId)?.skills ?? [] };
	}

	// ---------- cards ----------

	#stopCard(id: string): void {
		const state = this.#cards.get(id);
		if (state?.timer) clearTimeout(state.timer);
		if (state) state.timer = undefined;
	}

	#refreshCard(id: string): void {
		this.#stopCard(id);
		void this.#fetchCard(id);
	}

	#scheduleCard(id: string, ms: number): void {
		const state = this.#cards.get(id);
		if (!state || this.#stopped) return;
		if (state.timer) clearTimeout(state.timer);
		state.timer = setTimeout(() => void this.#fetchCard(id), ms);
		state.timer.unref();
	}

	async #fetchCard(id: string): Promise<void> {
		const agent = this.#agents.get(id);
		if (!agent || this.#stopped) return;
		let state = this.#cards.get(id);
		if (!state) {
			state = { skills: [], failures: 0, timer: undefined };
			this.#cards.set(id, state);
		}
		try {
			// The push guard does not apply here: the operator writes these URLs in the external file.
			const response = await this.#fetch(cardUrl(agent.url), {
				headers: { Accept: "application/json" },
				redirect: "manual",
				signal: AbortSignal.any([this.#shutdown.signal, AbortSignal.timeout(this.#connectTimeoutMs)]),
			});
			if (response.status !== 200) {
				await response.body?.cancel();
				throw new Error(`HTTP ${response.status}`);
			}
			const card: unknown = await response.json();
			if (this.#stopped || this.#agents.get(id) !== agent) return;
			state.skills = parseSkills(card);
			state.failures = 0;
			this.#engine.setOnline(id, true);
			this.#scheduleCard(id, agent.cardTtlMs);
		} catch (error) {
			if (this.#stopped || this.#agents.get(id) !== agent) return;
			state.failures += 1;
			if (state.failures === CARD_FAILURES_OFFLINE) {
				this.#log(`external agent ${id}: card fetch failed ${state.failures} times, offline: ${explain(error)}`);
			}
			if (state.failures >= CARD_FAILURES_OFFLINE) this.#engine.setOnline(id, false);
			this.#scheduleCard(id, agent.pollMs);
		}
	}

	// ---------- dispatch loop ----------

	#kick(): void {
		this.#schedule(0);
	}

	#schedule(at: number): void {
		if (this.#stopped || !this.#started || at >= this.#timerAt) return;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timerAt = at;
		this.#timer = setTimeout(
			() => {
				this.#timer = undefined;
				this.#timerAt = Number.POSITIVE_INFINITY;
				this.#run();
			},
			Math.max(0, at - this.#engine.now()),
		);
		this.#timer.unref();
	}

	#run(): void {
		if (this.#stopped) return;
		const now = this.#engine.now();
		const held = new Set<string>();
		let next = Number.POSITIVE_INFINITY;
		for (const job of this.#engine.externalJobs()) {
			const context = `${job.agentId}\0${job.contextId}`;
			if (this.#claimed.has(job.id)) {
				if (job.op === "send") held.add(context);
				continue;
			}
			if (job.op === "send") {
				if (held.has(context)) continue;
				held.add(context);
				if (this.#engine.remoteBusy(job.agentId, job.contextId)) continue;
			}
			if (job.nextAt > now) {
				next = Math.min(next, job.nextAt);
				continue;
			}
			this.#claimed.add(job.id);
			const work = job.op === "send" ? this.#dispatch(job) : this.#cancel(job);
			work
				.catch((error: unknown) => this.#log(`external job ${job.id} failed: ${explain(error)}`))
				.finally(() => {
					this.#claimed.delete(job.id);
					this.#kick();
				});
		}
		if (next < Number.POSITIVE_INFINITY) this.#schedule(next);
	}

	#fail(taskId: string, text: string): void {
		this.#apply(taskId, { state: "TASK_STATE_FAILED", message: this.#engine.agentMessage(text) });
	}

	/** Returns false when the hub task is already final, for example after a cancel. */
	#apply(taskId: string, change: TaskChange): boolean {
		try {
			this.#engine.applyChange(taskId, change);
			return true;
		} catch (error) {
			if (error instanceof HubError && (error.reason === "task-terminal" || error.reason === "task-not-found")) {
				return false;
			}
			throw error;
		}
	}

	#working(taskId: string): boolean {
		const state = this.#engine.taskState(taskId);
		if (state === undefined || isTerminal(state)) return false;
		if (state === "TASK_STATE_WORKING") return true;
		return this.#apply(taskId, { state: "TASK_STATE_WORKING" });
	}

	#logOnce(key: string, line: string): void {
		if (this.#logged.has(key)) return;
		this.#logged.add(key);
		this.#log(line);
	}

	async #dispatch(job: ExternalJob): Promise<void> {
		const state = this.#engine.taskState(job.taskId);
		if (state === undefined || isTerminal(state)) {
			this.#engine.dropExternalJob(job.id);
			if (state !== "TASK_STATE_CANCELED") {
				this.#log(`external job ${job.id}: task ${job.taskId} is ${state ?? "gone"}, message not sent`);
			}
			return;
		}
		const agent = this.#agents.get(job.agentId);
		if (!agent) {
			this.#engine.dropExternalJob(job.id);
			this.#fail(job.taskId, `${job.agentId} is not configured on the hub`);
			return;
		}
		const outbound = job.messageId ? this.#engine.outboundMessage(job.taskId, job.messageId) : undefined;
		if (!outbound) {
			this.#engine.dropExternalJob(job.id);
			this.#log(`external job ${job.id}: message ${job.messageId ?? "?"} of task ${job.taskId} is gone`);
			return;
		}
		const remote = this.#engine.startRemote(job);
		const running = this.#track(remote);
		try {
			const outcome = await this.#send(agent, remote, outbound.contextId, job.messageId ?? this.#engine.newId(), {
				text: outboundText(outbound.text, outbound.senderName, outbound.senderHost),
				signal: running.controller.signal,
			});
			if (this.#handleStop(running, remote)) return;
			switch (outcome.kind) {
				case "settled":
					this.#engine.remoteDone(remote);
					this.#engine.setOnline(agent.id, true);
					return;
				case "failed":
					this.#engine.remoteDone(remote);
					this.#fail(job.taskId, outcome.detail);
					return;
				case "retry":
					this.#retry(agent, job, remote);
					return;
				case "unreachable":
					this.#unreachable(agent, job, remote, outcome.detail);
					return;
				case "drop":
					this.#engine.setOnline(agent.id, true);
					await this.#recover(agent, remote, running, "drop");
					return;
			}
		} finally {
			if (this.#running.get(remote.taskId) === running) this.#running.delete(remote.taskId);
		}
	}

	#track(remote: RemoteTask): Running {
		const running: Running = {
			taskId: remote.taskId,
			agentId: remote.agentId,
			controller: new AbortController(),
			reason: undefined,
		};
		this.#running.set(remote.taskId, running);
		return running;
	}

	#abort(running: Running, reason: StopReason): void {
		running.reason ??= reason;
		running.controller.abort();
	}

	/** True when the dispatch ended on purpose. A hub stop leaves the rows for the next start. */
	#handleStop(running: Running, remote: RemoteTask): boolean {
		if (this.#stopped || running.reason === "stop") return true;
		if (running.reason === "cancel") {
			this.#engine.remoteDone(remote);
			return true;
		}
		if (running.reason === "removed") {
			this.#engine.remoteDone(remote);
			this.#fail(remote.taskId, `${remote.agentId} was removed from the hub config`);
			return true;
		}
		return false;
	}

	#retry(agent: ExternalAgentConfig, job: ExternalJob, remote: RemoteTask): void {
		const attempts = job.attempts + 1;
		if (attempts > RATE_LIMIT_RETRIES) {
			this.#engine.remoteDone(remote);
			this.#fail(job.taskId, `${agent.name} rate limit: the hub gave up after ${RATE_LIMIT_RETRIES} retries`);
			return;
		}
		this.#engine.requeueRemote(remote, { ...job, attempts, nextAt: this.#engine.now() + agent.retryMs });
	}

	#unreachable(agent: ExternalAgentConfig, job: ExternalJob, remote: RemoteTask, detail: string): void {
		this.#engine.setOnline(agent.id, false);
		const now = this.#engine.now();
		if (now - job.firstAt >= agent.offlineMs) {
			this.#engine.remoteDone(remote);
			this.#fail(job.taskId, `${agent.name} is unreachable: ${detail}`);
			return;
		}
		this.#logOnce(`unreachable:${agent.id}`, `external agent ${agent.id} is unreachable, retrying: ${detail}`);
		const delay = Math.min(agent.pollMs * 2 ** job.attempts, OFFLINE_BACKOFF_MAX_MS);
		this.#engine.requeueRemote(remote, { ...job, attempts: job.attempts + 1, nextAt: now + delay });
	}

	// ---------- one request ----------

	#headers(agent: ExternalAgentConfig, accept: string): Record<string, string> {
		return {
			Authorization: `Bearer ${agent.token}`,
			"A2A-Version": "1.0",
			"Content-Type": "application/json",
			Accept: accept,
		};
	}

	/** Maps an HTTP status or a JSON-RPC error code of the agent to the hub action. */
	#errorOutcome(agent: ExternalAgentConfig, status: number, error: { code?: unknown; message?: unknown } | undefined) {
		const code = typeof error?.code === "number" ? error.code : undefined;
		const message = typeof error?.message === "string" ? error.message : "";
		if (status === 401 || code === ERR_UNAUTHORIZED) {
			this.#logOnce(`401:${agent.id}`, `external agent ${agent.id} rejected the hub token`);
			return new Outcome("failed", `hub token rejected by ${agent.name}`);
		}
		if (status === 403 || code === ERR_UNTRUSTED_PEER) {
			this.#logOnce(`403:${agent.id}`, `external agent ${agent.id} does not trust the hub`);
			return new Outcome("failed", `hub not in A2A_TRUSTED_PEERS of ${agent.name}`);
		}
		if (status === 429 || code === ERR_RATE_LIMITED) return new Outcome("retry");
		if (code !== undefined) return new Outcome("failed", `${agent.name} answered ${code}: ${message}`);
		return new Outcome("failed", `${agent.name} answered HTTP ${status}`);
	}

	async #send(
		agent: ExternalAgentConfig,
		remote: RemoteTask,
		contextId: string,
		messageId: string,
		input: { text: string; signal: AbortSignal },
	): Promise<Outcome> {
		const body = {
			jsonrpc: "2.0",
			id: this.#engine.newId(),
			method: "SendStreamingMessage",
			params: { message: { role: "ROLE_USER", messageId, contextId, parts: [{ text: input.text }] } },
		};
		const local = new AbortController();
		const onAbort = () => local.abort();
		input.signal.addEventListener("abort", onAbort, { once: true });
		let headersLate = false;
		const connect = setTimeout(() => {
			headersLate = true;
			local.abort();
		}, this.#connectTimeoutMs);
		try {
			let response: Response;
			try {
				// The push guard does not apply here: the operator writes these URLs in the external file.
				response = await this.#fetch(agent.url, {
					method: "POST",
					headers: this.#headers(agent, "text/event-stream"),
					body: JSON.stringify(body),
					redirect: "manual",
					signal: local.signal,
				});
			} catch (error) {
				if (input.signal.aborted) return new Outcome("drop");
				const code = errorCode(error);
				if (!headersLate && code && CONNECT_ERRORS.has(code)) return new Outcome("unreachable", explain(error));
				this.#log(`external agent ${agent.id}: request of task ${remote.taskId} dropped: ${explain(error)}`);
				return new Outcome("drop");
			} finally {
				clearTimeout(connect);
			}
			const type = response.headers.get("content-type") ?? "";
			if (response.status !== 200 || !type.includes("text/event-stream") || !response.body) {
				const text = await response.text().catch(() => "");
				let error: { code?: unknown; message?: unknown } | undefined;
				try {
					error = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }).error;
				} catch {
					error = undefined;
				}
				return this.#errorOutcome(agent, response.status, error);
			}
			return await this.#readStream(agent, remote, response.body, local);
		} finally {
			clearTimeout(connect);
			input.signal.removeEventListener("abort", onAbort);
		}
	}

	async #readStream(
		agent: ExternalAgentConfig,
		remote: RemoteTask,
		body: ReadableStream<Uint8Array>,
		local: AbortController,
	): Promise<Outcome> {
		const reader = body.pipeThrough(new TextDecoderStream()).getReader();
		const artifacts: WireArtifact[] = [];
		let idle: NodeJS.Timeout | undefined;
		const arm = () => {
			if (idle) clearTimeout(idle);
			idle = setTimeout(() => local.abort(), agent.idleMs);
		};
		let late = false;
		const deadline = setTimeout(
			() => {
				late = true;
				local.abort();
			},
			Math.max(0, remote.dispatchedAt + agent.replyTimeoutMs - this.#engine.now()),
		);
		const timedOut = () =>
			new Outcome("failed", `${agent.name} gave no answer within ${Math.round(agent.replyTimeoutMs / 1000)} s`);
		local.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
		arm();
		let buffer = "";
		try {
			for (;;) {
				let chunk: Awaited<ReturnType<typeof reader.read>>;
				try {
					chunk = await reader.read();
				} catch {
					return late ? timedOut() : new Outcome("drop");
				}
				if (late) return timedOut();
				if (chunk.done) return new Outcome("drop");
				arm();
				buffer += chunk.value;
				for (;;) {
					const end = /\r?\n\r?\n/.exec(buffer);
					if (!end) break;
					const frame = buffer.slice(0, end.index);
					buffer = buffer.slice(end.index + end[0].length);
					const outcome = this.#frame(agent, remote, frame, artifacts);
					if (outcome) return outcome;
				}
			}
		} finally {
			if (idle) clearTimeout(idle);
			clearTimeout(deadline);
			local.abort();
		}
	}

	/** One SSE frame. Returns an outcome once the hub task got its final or interrupted state. */
	#frame(
		agent: ExternalAgentConfig,
		remote: RemoteTask,
		frame: string,
		artifacts: WireArtifact[],
	): Outcome | undefined {
		const data = frame
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (data === "") return undefined;
		let envelope: { result?: Record<string, unknown>; error?: { code?: unknown; message?: unknown } };
		try {
			envelope = JSON.parse(data) as typeof envelope;
		} catch {
			this.#log(`external agent ${agent.id}: frame is not JSON`);
			return undefined;
		}
		if (envelope.error) return this.#errorOutcome(agent, 200, envelope.error);
		const event = envelope.result ?? (envelope as Record<string, unknown>);
		return this.#event(agent, remote, event, artifacts) ? new Outcome("settled") : undefined;
	}

	#noteRemote(remote: RemoteTask, id: unknown, contextId: unknown): void {
		if (remote.remoteTaskId || typeof id !== "string" || id === "") return;
		remote.remoteTaskId = id;
		remote.remoteContextId = typeof contextId === "string" ? contextId : null;
		remote.state = "running";
		this.#engine.remoteStarted(remote, id, remote.remoteContextId);
	}

	/**
	 * Returns true when the hub task is settled for this dispatch: final, interrupted, or already final.
	 * Artifacts wait for the final status, so the sender gets the result in one update with the final state.
	 */
	#event(
		agent: ExternalAgentConfig,
		remote: RemoteTask,
		event: Record<string, unknown>,
		artifacts: WireArtifact[],
	): boolean {
		if ("task" in event) {
			const task = event["task"] as RemoteTaskWire;
			this.#noteRemote(remote, task.id, task.contextId);
			const state = asState(task.status?.state);
			if (state && ends(state)) return this.#settle(agent, remote, task, "stream");
			return !this.#working(remote.taskId);
		}
		if ("statusUpdate" in event) {
			const update = event["statusUpdate"] as {
				taskId?: unknown;
				contextId?: unknown;
				status?: RemoteTaskWire["status"];
			};
			this.#noteRemote(remote, update.taskId, update.contextId);
			const state = asState(update.status?.state);
			if (!state || !ends(state)) return !this.#working(remote.taskId);
			const text = wireText(update.status?.message);
			const change: TaskChange = { state };
			if (text) change.message = this.#engine.agentMessage(text);
			if (artifacts.length > 0) change.artifacts = artifacts.map((artifact) => ({ artifact }));
			this.#apply(remote.taskId, change);
			return true;
		}
		if ("artifactUpdate" in event) {
			const update = event["artifactUpdate"] as {
				taskId?: unknown;
				contextId?: unknown;
				artifact?: unknown;
				append?: unknown;
			};
			this.#noteRemote(remote, update.taskId, update.contextId);
			const artifact = asArtifact(update.artifact);
			if (!artifact) return false;
			const previous =
				update.append === true ? artifacts.find((item) => item.artifactId === artifact.artifactId) : undefined;
			if (previous) previous.parts = [...previous.parts, ...artifact.parts];
			else artifacts.push({ ...artifact, parts: [...artifact.parts] });
			return false;
		}
		if ("message" in event) {
			const text = messageText(event["message"] as WireMessage);
			const change: TaskChange = { state: "TASK_STATE_COMPLETED" };
			if (text) change.message = this.#engine.agentMessage(text);
			this.#apply(remote.taskId, change);
			return true;
		}
		return false;
	}

	/** Applies a final or interrupted remote Task. A failure seen after a drop tells the sender to ask again. */
	#settle(agent: ExternalAgentConfig, remote: RemoteTask, task: RemoteTaskWire, via: "stream" | "poll"): boolean {
		const state = asState(task.status?.state);
		if (!state) return false;
		const text = wireText(task.status?.message);
		const artifacts = (task.artifacts ?? []).map(asArtifact).filter((item) => item !== undefined);
		const change: TaskChange = { state };
		if (state === "TASK_STATE_FAILED" && via === "poll") {
			change.message = this.#engine.agentMessage(
				`${agent.name} failed the task after the stream dropped${text ? `: ${text}` : ""}. Ask again in the same context.`,
			);
		} else if (state === "TASK_STATE_COMPLETED" && artifacts.length > 0) {
			change.artifacts = artifacts.map((artifact) => ({ artifact }));
		} else if (text) {
			change.message = this.#engine.agentMessage(text);
		}
		this.#apply(remote.taskId, change);
		return true;
	}

	// ---------- recovery ----------

	async #rpc(
		agent: ExternalAgentConfig,
		method: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<RpcAnswer> {
		const response = await this.#fetch(agent.url, {
			method: "POST",
			headers: this.#headers(agent, "application/json"),
			body: JSON.stringify({ jsonrpc: "2.0", id: this.#engine.newId(), method, params }),
			redirect: "manual",
			signal: AbortSignal.any([signal, this.#shutdown.signal, AbortSignal.timeout(this.#connectTimeoutMs)]),
		});
		const text = await response.text();
		try {
			const body = JSON.parse(text) as { result?: unknown; error?: { code?: unknown; message?: unknown } };
			return { status: response.status, ...body };
		} catch {
			return { status: response.status };
		}
	}

	/** A dispatch that was open when the hub stopped. */
	#resume(remote: RemoteTask): void {
		const agent = this.#agents.get(remote.agentId);
		if (!agent) {
			this.#engine.remoteDone(remote);
			this.#fail(remote.taskId, `${remote.agentId} is not configured on the hub`);
			return;
		}
		const running = this.#track(remote);
		this.#recover(agent, remote, running, "restart")
			.catch((error: unknown) => this.#log(`external task ${remote.taskId} recovery failed: ${explain(error)}`))
			.finally(() => {
				if (this.#running.get(remote.taskId) === running) this.#running.delete(remote.taskId);
				this.#kick();
			});
	}

	/**
	 * After a dropped stream or a hub restart: find the remote task, then poll GetTask until it ends.
	 * Hermes fails a streamed task when its client goes away, so this mostly settles the hub task as failed.
	 */
	async #recover(agent: ExternalAgentConfig, remote: RemoteTask, running: Running, cause: "drop" | "restart") {
		const signal = running.controller.signal;
		if (!remote.remoteTaskId) {
			const found = await this.#findRemote(agent, remote, signal).catch((error: unknown) => {
				this.#log(`external agent ${agent.id}: ListTasks failed: ${explain(error)}`);
				return undefined;
			});
			if (this.#handleStop(running, remote)) return;
			if (!found) {
				this.#engine.remoteDone(remote);
				this.#fail(
					remote.taskId,
					cause === "restart"
						? "hub restarted during dispatch"
						: `${agent.name} did not confirm the task before the stream dropped. Ask again in the same context.`,
				);
				return;
			}
			this.#noteRemote(remote, found.id, found.contextId);
		}
		const deadline = remote.dispatchedAt + agent.replyTimeoutMs;
		for (;;) {
			let answer: RpcAnswer | undefined;
			try {
				answer = await this.#rpc(agent, "GetTask", { id: remote.remoteTaskId }, signal);
			} catch (error) {
				if (!signal.aborted) this.#log(`external agent ${agent.id}: GetTask failed: ${explain(error)}`);
			}
			if (this.#handleStop(running, remote)) return;
			this.#engine.remotePolled(remote);
			if (answer?.error?.code === ERR_TASK_NOT_FOUND) {
				this.#engine.remoteDone(remote);
				this.#fail(remote.taskId, `${agent.name} lost the task. Ask again in the same context.`);
				return;
			}
			const task = answer?.result as RemoteTaskWire | undefined;
			const state = asState(task?.status?.state);
			if (task && state && ends(state)) {
				this.#settle(agent, remote, task, "poll");
				this.#engine.remoteDone(remote);
				return;
			}
			if (this.#engine.now() >= deadline) {
				this.#engine.remoteDone(remote);
				this.#fail(remote.taskId, `${agent.name} gave no answer within ${Math.round(agent.replyTimeoutMs / 1000)} s`);
				return;
			}
			const current = this.#engine.taskState(remote.taskId);
			if (current === undefined || isTerminal(current)) {
				this.#engine.remoteDone(remote);
				return;
			}
			await sleep(agent.pollMs, signal);
			if (this.#handleStop(running, remote)) return;
		}
	}

	/** The newest remote task of the context that no dispatch claims yet. */
	async #findRemote(
		agent: ExternalAgentConfig,
		remote: RemoteTask,
		signal: AbortSignal,
	): Promise<{ id: string; contextId: string | null } | undefined> {
		const answer = await this.#rpc(agent, "ListTasks", { contextId: remote.contextId, pageSize: 20 }, signal);
		const tasks = (answer.result as { tasks?: RemoteTaskWire[] } | undefined)?.tasks ?? [];
		for (const task of tasks) {
			if (typeof task.id !== "string" || this.#engine.remoteKnown(agent.id, task.id)) continue;
			return { id: task.id, contextId: typeof task.contextId === "string" ? task.contextId : null };
		}
		return undefined;
	}

	// ---------- cancel ----------

	async #cancel(job: ExternalJob): Promise<void> {
		this.#engine.dropExternalJob(job.id);
		const remote = this.#engine.latestRemote(job.taskId);
		const agent = this.#agents.get(job.agentId);
		const running = this.#running.get(job.taskId);
		if (agent && remote?.remoteTaskId && remote.state !== "done") {
			try {
				const answer = await this.#rpc(
					agent,
					"CancelTask",
					{ id: remote.remoteTaskId },
					running?.controller.signal ?? this.#shutdown.signal,
				);
				if (answer.error) {
					this.#log(`external agent ${agent.id}: CancelTask ${remote.remoteTaskId}: ${String(answer.error.message)}`);
				}
			} catch (error) {
				this.#log(`external agent ${agent.id}: CancelTask ${remote.remoteTaskId} failed: ${explain(error)}`);
			}
		}
		if (running) this.#abort(running, "cancel");
		else if (remote && remote.state !== "done" && !this.#stopped) this.#engine.remoteDone(remote);
	}
}
