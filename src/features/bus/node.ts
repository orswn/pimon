// One pi instance's endpoint on the local bus. No hub, no election, no persistent connections.
// One dial, one JSONL request, one ack. A missing ack is not evidence of non-delivery.
// A node never unlinks a socket path that answers, and re-verifies that its own socket answers as itself.

import { existsSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import type {
	DeliveryFailure,
	Envelope,
	EnvelopeKind,
	PeerRecord,
	PeerRef,
	PeerState,
	PendingQuestion,
	PendingTarget,
	Priority,
	ProbeResult,
	SendResult,
	Wake,
	WireRequest,
	WireResponse,
} from "./protocol.ts";
import {
	BUS_PROTOCOL,
	DIAL_DEADLINE_MS,
	DIAL_TIMEOUT_MS,
	HEARTBEAT_MS,
	MAX_BODY_BYTES,
	MAX_FANOUT,
	MAX_LINE_BYTES,
	PEER_CACHE_MS,
	PENDING_NUDGE_MS,
	WATCH_MS,
	fullId,
	normalizeWake,
	shortId,
} from "./protocol.ts";
import {
	ensureDirs,
	loserOfNameConflict,
	pickName,
	pidAlive,
	pidBirth,
	readPeer,
	readPeers,
	removePresence,
	sanitizeName,
	ScanError,
	scanPeers,
	socketPathFor,
	writePresence,
	type BusDirs,
} from "./registry.ts";
import { isUnicastSelector, matchPeers, SelectorError, type SelectorContext } from "./selectors.ts";

/** Kinds that settle an open question. A status update is not an answer. */
const ANSWER_KINDS = new Set(["answer", "result"]);
const DEDUPE_LIMIT = 512;
const BYE_TIMEOUT_MS = 400;
const DIAL_RETRIES = 2;
/** Confirmations required before a watched peer is declared gone. */
const GONE_CONFIRMATIONS = 2;
/** Heartbeats between full socket-ownership self checks. */
const SELF_CHECK_EVERY = 6;

export interface SendInit {
	body: string;
	kind?: EnvelopeKind;
	priority?: Priority;
	wake?: Wake;
	subject?: string;
	data?: unknown;
	threadId?: string;
	corrId?: string;
	replyExpected?: boolean;
	ttlMs?: number;
	/** Deadline before an unanswered question is nudged back to us. */
	nudgeAfterMs?: number;
	/** Permit a send that matches nobody. Off by default: silence hides bugs. */
	allowEmpty?: boolean;
}

export interface PeerGone {
	record: PeerRecord;
	/** `left` is a graceful endpoint stop whose host process may still be alive. */
	reason: "exited" | "recycled" | "left";
	pending: PendingQuestion[];
}

export interface BusNodeOptions {
	/** Stable process identity. Rotating endpoint ids must not break parent links. */
	owner: string;
	desiredName: string;
	labels?: Record<string, string>;
	cwd?: string | undefined;
	sessionFile?: string | undefined;
	session?: string | undefined;
	model?: string | undefined;
	dirs: BusDirs;
	/** Force the base socket path. Used by tests to provoke a path collision. */
	socketBase?: string | undefined;
	onEnvelope: (envelope: Envelope) => void | Promise<void>;
	onPeerGone?: (event: PeerGone) => void;
	onPeersChanged?: (peers: PeerRecord[]) => void;
	onPendingOverdue?: (pending: PendingQuestion[]) => void;
	log?: (message: string) => void;
}

function jsonlReader(socket: Socket, onLine: (line: string) => void): void {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk) => {
		buffer += String(chunk);
		if (buffer.length > MAX_LINE_BYTES) {
			socket.destroy();
			return;
		}
		while (true) {
			const index = buffer.indexOf("\n");
			if (index === -1) break;
			let line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.trim()) onLine(line);
		}
	});
}

export class DialError extends Error {
	handedOver: boolean;
	code?: string;

	constructor(message: string, handedOver: boolean, code?: string) {
		super(message);
		this.handedOver = handedOver;
		if (code !== undefined) this.code = code;
	}
}

/**
 * One dial, one JSONL request, one JSONL response, then close.
 *
 * `handedOver` records whether the payload reached the kernel buffer. A timeout
 * after a successful write means the outcome is unknown, not failed.
 */
function dialOnce(sock: string, request: WireRequest, timeoutMs: number): Promise<WireResponse> {
	return new Promise((resolve, reject) => {
		let socket: Socket;
		try {
			socket = createConnection(sock);
		} catch (error) {
			reject(new DialError((error as Error).message, false, (error as NodeJS.ErrnoException).code));
			return;
		}

		let settled = false;
		let written = false;
		const deadline = setTimeout(() => fail(`no response in ${DIAL_DEADLINE_MS}ms (deadline)`), DIAL_DEADLINE_MS);
		deadline.unref?.();

		const cleanup = () => {
			clearTimeout(deadline);
			socket.destroy();
		};
		const fail = (message: string, code?: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new DialError(message, written, code));
		};
		const done = (response: WireResponse) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(response);
		};

		socket.setTimeout(timeoutMs, () => fail(`no response in ${timeoutMs}ms`));
		socket.on("error", (error) => fail(error.message, (error as NodeJS.ErrnoException).code));
		socket.on("close", () => fail("closed before response"));
		socket.on("connect", () => {
			jsonlReader(socket, (line) => {
				try {
					done(JSON.parse(line) as WireResponse);
				} catch {
					fail("invalid response");
				}
			});
			socket.write(`${JSON.stringify(request)}\n`, () => {
				written = true;
			});
		});
	});
}

const RETRYABLE = new Set(["EAGAIN", "ENOBUFS", "EMFILE"]);

async function dial(sock: string, request: WireRequest, timeoutMs = DIAL_TIMEOUT_MS): Promise<WireResponse> {
	let last: DialError | undefined;
	for (let attempt = 0; attempt < DIAL_RETRIES; attempt++) {
		try {
			return await dialOnce(sock, request, timeoutMs);
		} catch (error) {
			last = error as DialError;
			// Never retry once the payload may have been handed over: a retry would
			// duplicate work on the receiver.
			if (last.handedOver) break;
			if (!last.code || !RETRYABLE.has(last.code)) break;
			await new Promise((resolve) => setTimeout(resolve, 25 + attempt * 50));
		}
	}
	throw last || new DialError("dial failed", false);
}

/** Bounded fan-out so a large peer set cannot exhaust file descriptors. */
async function mapLimited<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	let cursor = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await worker(items[index] as T);
		}
	});
	await Promise.all(runners);
	return results;
}

export class BusNode {
	/**
	 * Identity of this endpoint incarnation. A restart allocates a new id, so a
	 * shutdown notice that arrives late can only ever retire the endpoint that
	 * actually stopped, never the one that took its place.
	 */
	instanceId = randomUUID();
	readonly owner: string;
	name = "pi";
	labels: Record<string, string> = {};
	topics: string[] = [];
	state: PeerState = "starting";
	activity: string | undefined;

	private options: BusNodeOptions;
	private dirs: BusDirs;
	private server?: Server;
	private sock: string;
	private startedAt = Date.now();
	private birth = pidBirth(process.pid);
	private heartbeatTimer?: NodeJS.Timeout;
	private watchTimer?: NodeJS.Timeout;
	private beats = 0;
	private desiredBase = "pi";
	private bindRetrying = false;
	private bindInFlight?: Promise<void>;
	private peerCache: { at: number; peers: PeerRecord[] } = { at: 0, peers: [] };
	private knownPeerIds = new Set<string>();
	private watched = new Map<string, PeerRecord>();
	private missCounts = new Map<string, number>();
	private pending = new Map<string, PendingQuestion>();
	private seen: string[] = [];
	private seenSet = new Set<string>();
	private exitHook?: () => void;
	private started = false;
	private stopped = false;

	constructor(options: BusNodeOptions) {
		this.options = options;
		this.owner = options.owner;
		this.dirs = ensureDirs(options.dirs);
		this.sock = options.socketBase || socketPathFor(this.instanceId, this.dirs);
		this.labels = { ...options.labels };
	}

	/** True between a successful start() and stop(). */
	get isStarted(): boolean {
		return this.started && !this.stopped;
	}

	get selectorContext(): SelectorContext {
		return { selfInstanceId: this.instanceId, selfOwner: this.owner, selfName: this.name };
	}

	get ref(): PeerRef {
		return {
			instanceId: this.instanceId,
			owner: this.owner,
			name: this.name,
			pid: process.pid,
			cwd: this.options.cwd || process.cwd(),
			sock: this.sock,
			labels: this.labels,
		};
	}

	get record(): PeerRecord {
		return {
			...this.ref,
			protocol: BUS_PROTOCOL,
			host: osHostname(),
			topics: this.topics,
			state: this.state,
			activity: this.activity,
			startedAt: this.startedAt,
			heartbeatAt: Date.now(),
			pidBirth: this.birth,
			sessionFile: this.options.sessionFile,
			session: this.options.session,
			model: this.options.model,
		};
	}

	get socketPath(): string {
		return this.sock;
	}

	/** Idempotent: safe to call again after stop(), which makes session reloads safe. */
	async start(): Promise<void> {
		if (this.started && !this.stopped) return;
		if (this.started) {
			// Restarting the same object is a new endpoint. Reusing the id would let a
			// stale peer_left retire the fresh incarnation.
			this.instanceId = randomUUID();
			this.startedAt = Date.now();
			this.seen = [];
			this.seenSet = new Set();
			this.knownPeerIds = new Set();
			this.peerCache = { at: 0, peers: [] };
			this.sock = this.options.socketBase || socketPathFor(this.instanceId, this.dirs);
			this.options.log?.(`restarted as ${shortId(this.instanceId)}`);
		}
		this.stopped = false;
		this.dirs = ensureDirs(this.dirs);

		this.desiredBase = sanitizeName(this.options.desiredName);
		this.name = pickName(this.desiredBase, this.instanceId, readPeers(this.dirs));

		try {
			await this.listen();
		} catch (error) {
			// A failed start leaves no half node: no listener, no presence, and isStarted stays false.
			this.stopped = true;
			this.server?.close();
			this.server = undefined;
			removePresence(this.instanceId, this.sock, this.dirs);
			throw error;
		}

		this.state = "idle";
		this.beat();
		this.knownPeerIds = new Set(this.refreshPeers().map((peer) => peer.instanceId));

		this.heartbeatTimer = setInterval(() => this.beat(), HEARTBEAT_MS);
		this.heartbeatTimer.unref?.();
		this.watchTimer = setInterval(() => this.tick(), WATCH_MS);
		this.watchTimer.unref?.();

		// Last-resort cleanup for crashes that skip the normal shutdown path.
		this.exitHook = () => {
			try {
				removePresence(this.instanceId, this.sock, this.dirs);
			} catch {
				// Nothing useful to do while exiting.
			}
		};
		process.once("exit", this.exitHook);

		this.started = true;
	}

	async stop(options: { announce?: boolean } = {}): Promise<void> {
		if (this.stopped || !this.started) return;
		this.stopped = true;
		this.state = "closing";

		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		if (this.watchTimer) clearInterval(this.watchTimer);
		this.heartbeatTimer = undefined;
		this.watchTimer = undefined;

		// A bind started by the heartbeat would otherwise finish after teardown and
		// republish this node with a live listener.
		if (this.bindInFlight) {
			try {
				await this.bindInFlight;
			} catch {
				// A failed bind during shutdown needs no handling.
			}
		}

		if (options.announce !== false) await this.announceBye();

		await new Promise<void>((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
			this.server = undefined;
		});

		removePresence(this.instanceId, this.sock, this.dirs);
		if (this.exitHook) {
			process.removeListener("exit", this.exitHook);
			this.exitHook = undefined;
		}
	}

	setState(state: PeerState, activity?: string): void {
		this.state = state;
		this.activity = activity;
		if (!this.stopped) this.beat();
	}

	subscribe(topic: string): void {
		if (!topic || this.topics.includes(topic)) return;
		this.topics.push(topic);
		this.beat();
	}

	unsubscribe(topic: string): void {
		const index = this.topics.indexOf(topic);
		if (index < 0) return;
		this.topics.splice(index, 1);
		this.beat();
	}

	/** Track a peer so its disappearance produces a pushed notification. */
	watch(peer: PeerRecord | string): boolean {
		if (typeof peer !== "string") {
			this.watched.set(peer.instanceId, peer);
			return true;
		}
		const known = this.peers(0).find((candidate) => candidate.instanceId === peer) || readPeer(peer, this.dirs);
		if (!known) return false;
		this.watched.set(known.instanceId, known);
		return true;
	}

	unwatch(instanceId: string): void {
		this.watched.delete(instanceId);
		this.missCounts.delete(instanceId);
	}

	watching(): PeerRecord[] {
		return Array.from(this.watched.values());
	}

	pendingQuestions(): PendingQuestion[] {
		return Array.from(this.pending.values()).sort((a, b) => a.askedAt - b.askedAt);
	}

	/**
	 * Record one target's answer. The entry is only cleared once every target has
	 * answered or died, so a fan-out question is not considered done because the
	 * fastest peer replied.
	 */
	resolvePending(corrId: string | undefined, fromInstanceId?: string): PendingQuestion | undefined {
		if (!corrId) return undefined;
		const entry = this.pending.get(corrId);
		if (!entry) return undefined;
		return this.settle(entry, fromInstanceId);
	}

	/**
	 * Resolve an open question from an inbound message.
	 *
	 * corrId is the precise path and stays authoritative for fan-out, where one
	 * thread can carry several questions. But a peer that answers on the thread it
	 * was asked on has answered, whether or not it echoed the id. Without this
	 * fallback an answered question stayed pending forever, which produced both a
	 * false lapse reminder and a false "unanswered request" notice when the peer
	 * later shut down cleanly.
	 */
	resolveAnswer(envelope: Envelope): PendingQuestion | undefined {
		if (envelope.corrId && this.pending.has(envelope.corrId)) {
			return this.resolvePending(envelope.corrId, envelope.from.instanceId);
		}
		if (!ANSWER_KINDS.has(envelope.kind)) return undefined;
		for (const entry of this.pendingQuestions()) {
			if (entry.threadId !== envelope.threadId) continue;
			const owes = entry.targets.some(
				(target) => target.instanceId === envelope.from.instanceId && !target.answered && !target.gone,
			);
			if (!owes) continue;
			return this.settle(entry, envelope.from.instanceId);
		}
		return undefined;
	}

	private settle(entry: PendingQuestion, fromInstanceId?: string): PendingQuestion | undefined {
		let matchedTarget = false;
		for (const target of entry.targets) {
			if (fromInstanceId && target.instanceId !== fromInstanceId) continue;
			target.answered = true;
			matchedTarget = true;
		}
		// An answer from a peer that was never a target still counts as progress
		// only when we cannot tell targets apart.
		if (!matchedTarget && !fromInstanceId) for (const target of entry.targets) target.answered = true;
		if (entry.targets.every((target) => target.answered || target.gone)) {
			this.pending.delete(entry.envelopeId);
			return entry;
		}
		this.pending.set(entry.envelopeId, entry);
		return undefined;
	}

	peers(maxAgeMs = PEER_CACHE_MS): PeerRecord[] {
		if (maxAgeMs > 0 && Date.now() - this.peerCache.at <= maxAgeMs) return this.peerCache.peers;
		return this.refreshPeers();
	}

	/** Returns the cached list unchanged when the directory cannot be scanned. */
	refreshPeers(): PeerRecord[] {
		try {
			const peers = scanPeers(this.dirs);
			this.peerCache = { at: Date.now(), peers };
			return peers;
		} catch (error) {
			if (error instanceof ScanError) this.options.log?.(error.message);
			else this.options.log?.(`peer scan failed: ${(error as Error).message}`);
			return this.peerCache.peers;
		}
	}

	resolve(selector: string): PeerRecord[] {
		return matchPeers(selector, this.peers(0), this.selectorContext);
	}

	buildEnvelope(to: string, init: SendInit): Envelope {
		const createdAt = Date.now();
		return {
			v: BUS_PROTOCOL,
			id: randomUUID(),
			threadId: init.threadId || randomUUID(),
			corrId: init.corrId,
			replyExpected: init.replyExpected,
			from: this.ref,
			to,
			kind: init.kind || "note",
			priority: init.priority || "normal",
			wake: normalizeWake(init.wake),
			subject: init.subject,
			body: init.body,
			data: init.data,
			createdAt,
			expiresAt: init.ttlMs ? createdAt + init.ttlMs : undefined,
		};
	}

	/** Resolves once every matched peer has acked, timed out, or failed. */
	async send(to: string, init: SendInit): Promise<SendResult> {
		const envelope = this.buildEnvelope(to, init);
		if (Buffer.byteLength(envelope.body, "utf8") > MAX_BODY_BYTES) {
			throw new Error(`message body exceeds ${MAX_BODY_BYTES} bytes`);
		}

		const matched = matchPeers(to, this.peers(0), this.selectorContext);
		if (matched.length === 0 && !init.allowEmpty) {
			throw new SelectorError(`no live peer matches ${to}. Use pi_bus action="peers" to see who is online.`);
		}
		// Names are advisory labels, so one name can briefly belong to two live
		// peers. Refuse to turn an intended unicast into a broadcast.
		if (matched.length > 1 && isUnicastSelector(to)) {
			const options = matched
				.map((peer) => `${peer.name} (owner:${shortId(peer.owner)} id:${shortId(peer.instanceId)})`)
				.join(", ");
			throw new SelectorError(`${to} is ambiguous: ${options}. Address one peer by owner or id.`);
		}

		const result = await this.deliver(envelope, matched);

		if (init.replyExpected && result.delivered.length + result.unknown.length > 0) {
			const unknownRecords = matched.filter((peer) =>
				result.unknown.some((failure) => failure.instanceId === peer.instanceId),
			);
			const targets: PendingTarget[] = [...result.delivered, ...unknownRecords].map((peer) => ({
				instanceId: peer.instanceId,
				owner: peer.owner,
				name: peer.name,
				answered: false,
				gone: false,
			}));
			// Unknown deliveries are watched too: the target may already be dying,
			// and its death is the only signal that no answer is coming.
			for (const peer of [...result.delivered, ...unknownRecords]) this.watch(peer);
			this.pending.set(envelope.id, {
				envelopeId: envelope.id,
				threadId: envelope.threadId,
				to,
				targets,
				subject: envelope.subject,
				body: envelope.body,
				askedAt: envelope.createdAt,
				dueAt: envelope.createdAt + (init.nudgeAfterMs ?? PENDING_NUDGE_MS),
				nudged: false,
			});
		}

		return result;
	}

	/**
	 * Re-dial an envelope to the exact instances captured earlier. Never
	 * re-resolves a selector: a recycled name would otherwise route old work to a
	 * different process.
	 */
	async resend(envelope: Envelope, targets: PeerRecord[]): Promise<SendResult> {
		const live = this.peers(0);
		const pinned: PeerRecord[] = [];
		const missing: DeliveryFailure[] = [];
		for (const target of targets) {
			const found = live.find((peer) => peer.instanceId === target.instanceId);
			if (found) pinned.push(found);
			else missing.push({ instanceId: target.instanceId, name: target.name, reason: "target is no longer live" });
		}
		const result = await this.deliver(envelope, pinned);
		// A retry whose targets all vanished must not look like a clean send.
		result.failed.push(...missing);
		result.matched.push(...targets.filter((target) => missing.some((gap) => gap.instanceId === target.instanceId)));
		return result;
	}

	/** Identity-pinned send. Uses the full id so a shared prefix cannot fan out. */
	async sendTo(peer: PeerRef, init: SendInit): Promise<SendResult> {
		return this.send(`id:${fullId(peer.instanceId)}`, init);
	}

	/**
	 * Best effort reply that never throws.
	 *
	 * Used on paths that answer an inbound message, where the sender may already
	 * be gone or may have claimed an id that never existed. A rejected promise
	 * there would surface as an unhandled rejection and kill the process.
	 */
	async tryReply(peer: PeerRef, init: SendInit): Promise<boolean> {
		try {
			const result = await this.send(`id:${fullId(peer.instanceId)}`, { ...init, allowEmpty: true });
			return result.delivered.length > 0;
		} catch (error) {
			this.options.log?.(`reply to ${peer.name} failed: ${(error as Error).message}`);
			return false;
		}
	}

	async probe(selector: string): Promise<ProbeResult[]> {
		const matched = matchPeers(selector, this.peers(0), this.selectorContext);
		return mapLimited(matched, MAX_FANOUT, async (peer) => {
			const startedAt = Date.now();
			try {
				const response = await dial(peer.sock, { v: BUS_PROTOCOL, type: "ping", from: this.name }, 1_500);
				if (response.type !== "pong") {
					return { name: peer.name, instanceId: peer.instanceId, alive: false, reason: `unexpected ${response.type}` };
				}
				if (response.instanceId !== peer.instanceId) {
					return {
						name: peer.name,
						instanceId: peer.instanceId,
						alive: false,
						reason: `socket answered as ${response.name} (${shortId(response.instanceId)}), registry is stale`,
					};
				}
				return {
					name: response.name,
					instanceId: response.instanceId,
					alive: true,
					state: response.state,
					activity: response.activity,
					labels: response.labels,
					rttMs: Date.now() - startedAt,
					uptimeMs: Date.now() - response.startedAt,
				};
			} catch (error) {
				return {
					name: peer.name,
					instanceId: peer.instanceId,
					alive: pidAlive(peer.pid),
					state: peer.state,
					reason: describeDialFailure(error as DialError, peer),
				};
			}
		});
	}

	private async deliver(envelope: Envelope, matched: PeerRecord[]): Promise<SendResult> {
		const result: SendResult = { envelope, matched, delivered: [], unknown: [], failed: [], acks: [] };

		await mapLimited(matched, MAX_FANOUT, async (peer) => {
			try {
				const response = await dial(peer.sock, { v: BUS_PROTOCOL, type: "envelope", envelope });
				if (response.type !== "ack") {
					result.failed.push({ instanceId: peer.instanceId, name: peer.name, reason: `unexpected ${response.type}` });
					return;
				}
				if (response.id !== envelope.id) {
					result.failed.push({
						instanceId: peer.instanceId,
						name: peer.name,
						reason: `ack referenced envelope ${response.id}, not ${envelope.id}`,
					});
					return;
				}
				// Guard against a stale registry pointing at a different live listener.
				if (response.instanceId !== peer.instanceId) {
					result.failed.push({
						instanceId: peer.instanceId,
						name: peer.name,
						reason: `ack came from ${response.name} (${shortId(response.instanceId)}), not the addressed peer`,
					});
					return;
				}
				result.acks.push({
					instanceId: peer.instanceId,
					name: peer.name,
					accepted: response.accepted,
					reason: response.reason,
				});
				if (response.accepted) result.delivered.push(peer);
				else
					result.failed.push({ instanceId: peer.instanceId, name: peer.name, reason: response.reason || "rejected" });
			} catch (error) {
				const dialError = error as DialError;
				const failure = {
					instanceId: peer.instanceId,
					name: peer.name,
					reason: describeDialFailure(dialError, peer),
				};
				if (dialError.handedOver) result.unknown.push(failure);
				else result.failed.push(failure);
			}
		});

		if (result.failed.length > 0) this.tick();
		return result;
	}

	/**
	 * Bind a socket path we own. An occupied path is never unlinked, not even
	 * after a silent ping: a listener that fails to answer within a timeout may
	 * simply be blocked, and unlinking it is exactly how the old mesh partitioned
	 * a live instance. Moving to another path costs nothing because the absolute
	 * path travels inside the presence record.
	 */
	private async listen(): Promise<void> {
		let suffix = "";
		let lastError: Error | undefined;
		for (let attempt = 0; attempt < 6; attempt++) {
			const candidate = this.options.socketBase
				? `${this.options.socketBase}${suffix}`
				: socketPathFor(this.instanceId, this.dirs, suffix);
			const outcome = await this.bindTo(candidate);
			if (outcome === "ok") {
				this.sock = candidate;
				return;
			}
			if (outcome === "inuse") {
				suffix = `-${Math.random().toString(36).slice(2, 6)}`;
				continue;
			}
			lastError = new Error(`cannot bind ${candidate}`);
			await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
		}
		throw lastError || new Error("cannot find a free bus socket path");
	}

	private bindTo(path: string): Promise<"ok" | "inuse" | "error"> {
		return new Promise((resolve) => {
			const server = createServer((socket) => this.accept(socket));
			const onError = (error: NodeJS.ErrnoException) => {
				this.options.log?.(`bind ${path} failed: ${error.code || error.message}`);
				resolve(error.code === "EADDRINUSE" ? "inuse" : "error");
			};
			server.once("error", onError);
			try {
				server.listen(path, () => {
					server.removeListener("error", onError);
					server.on("error", (error) => this.options.log?.(`listener error: ${error.message}`));
					this.server = server;
					resolve("ok");
				});
			} catch (error) {
				onError(error as NodeJS.ErrnoException);
			}
		});
	}

	/**
	 * Heartbeat doubles as a self check. Being silently unreachable is the
	 * failure that hurt most, so verify the socket exists and, periodically, that
	 * it still answers as this instance.
	 */
	private beat(): void {
		if (this.stopped) return;
		this.beats++;
		try {
			if (!this.server) {
				// A previous rebind failed. Keep retrying, otherwise this instance is
				// invisible forever while still publishing an unreachable address.
				this.detach(this.rebind());
			} else if (!existsSync(this.sock)) {
				this.options.log?.("socket file vanished, rebinding");
				this.detach(this.rebind());
			} else if (this.beats % SELF_CHECK_EVERY === 0) {
				this.detach(this.verifyOwnSocket());
			}
			this.reconcileName();
			writePresence(this.record, this.dirs);
		} catch (error) {
			this.options.log?.(`presence write failed: ${(error as Error).message}`);
		}
	}

	/**
	 * Two peers can briefly pick the same display name when they start at the same
	 * moment. The later starter renames itself, so the set converges without any
	 * process writing to a file it does not own.
	 */
	private reconcileName(): void {
		const peers = this.peers();
		if (peers.length === 0) return;
		if (!loserOfNameConflict(this.record, peers)) return;
		const previous = this.name;
		this.name = pickName(this.desiredBase, this.instanceId, peers);
		if (this.name !== previous) this.options.log?.(`name ${previous} was taken, now ${this.name}`);
	}

	private async verifyOwnSocket(): Promise<void> {
		try {
			const response = await dial(this.sock, { v: BUS_PROTOCOL, type: "ping", from: "self-check" }, 1_000);
			if (response.type === "pong" && response.instanceId !== this.instanceId) {
				this.options.log?.(`socket answered as ${response.name}, moving`);
				await this.rebind();
			}
		} catch {
			// A busy event loop can miss its own ping. The next check retries.
		}
	}

	private async rebind(): Promise<void> {
		if (this.bindRetrying || this.stopped) return;
		this.bindRetrying = true;
		const old = this.server;
		this.server = undefined;
		try {
			old?.close();
		} catch {
			// Already closing.
		}

		const attempt = (async () => {
			try {
				await this.listen();
				// stop() may have run while the bind was in flight. Anything acquired
				// after that must be released again, or a stopped node stays alive.
				if (this.stopped) {
					const acquired = this.server;
					this.server = undefined;
					try {
						acquired?.close();
					} catch {
						// Already closing.
					}
					removePresence(this.instanceId, this.sock, this.dirs);
					return;
				}
				writePresence(this.record, this.dirs);
				this.options.log?.(`rebound to ${this.sock}`);
			} catch (error) {
				// Leave this.server undefined so the next heartbeat retries.
				this.options.log?.(`rebind failed: ${(error as Error).message}`);
			} finally {
				this.bindRetrying = false;
			}
		})();

		this.bindInFlight = attempt;
		await attempt;
		if (this.bindInFlight === attempt) this.bindInFlight = undefined;
	}

	private tick(): void {
		const before = this.peerCache;
		const peers = this.refreshPeers();
		// A failed scan leaves the cache object untouched: skip, do not invent deaths.
		if (this.peerCache === before) return;

		const ids = new Set(peers.map((peer) => peer.instanceId));
		let changed = false;

		for (const [id, record] of this.watched) {
			if (ids.has(id)) {
				this.missCounts.delete(id);
				continue;
			}
			// Confirm against the peer's own file and pid before declaring death.
			if (readPeer(id, this.dirs)) {
				this.missCounts.delete(id);
				continue;
			}

			// Absence of a file is never enough while the process is demonstrably
			// the same one we were talking to.
			const alive = pidAlive(record.pid);
			const birthNow = alive ? pidBirth(record.pid) : undefined;
			const recycled = alive && Boolean(record.pidBirth) && Boolean(birthNow) && birthNow !== record.pidBirth;
			if (alive && !recycled) {
				this.missCounts.delete(id);
				continue;
			}

			const misses = (this.missCounts.get(id) || 0) + 1;
			this.missCounts.set(id, misses);
			if (misses < GONE_CONFIRMATIONS) continue;

			changed = true;
			this.markGone(id, recycled ? "recycled" : "exited");
		}

		for (const id of this.knownPeerIds) if (!ids.has(id)) changed = true;
		for (const id of ids) if (!this.knownPeerIds.has(id)) changed = true;
		this.knownPeerIds = ids;

		const overdue = this.pendingQuestions().filter(
			(entry) =>
				!entry.nudged && entry.dueAt <= Date.now() && entry.targets.some((target) => !target.answered && !target.gone),
		);
		if (overdue.length > 0) {
			try {
				this.options.onPendingOverdue?.(overdue);
				// Marked only after the push succeeded, so a failed dispatch is retried
				// instead of silently dropping the reminder forever.
				for (const entry of overdue) {
					const current = this.pending.get(entry.envelopeId);
					if (current) current.nudged = true;
				}
			} catch (error) {
				this.options.log?.(`nudge dispatch failed, will retry: ${(error as Error).message}`);
			}
		}

		if (changed) this.safely(() => this.options.onPeersChanged?.(peers));
	}

	/**
	 * Retire a peer from watch and pending state and push one notification.
	 * Used both by process-death detection and by an explicit peer_left notice.
	 */
	private markGone(instanceId: string, reason: PeerGone["reason"]): void {
		const record = this.watched.get(instanceId);
		if (record) {
			// A live record that started later than the one we watched is a different
			// incarnation, so a late notice must not retire it.
			const current = readPeer(instanceId, this.dirs);
			if (current && current.startedAt > record.startedAt) {
				this.options.log?.(`ignoring stale gone notice for ${record.name}`);
				return;
			}
		}
		this.missCounts.delete(instanceId);
		this.watched.delete(instanceId);

		const pending: PendingQuestion[] = [];
		for (const entry of this.pendingQuestions()) {
			const target = entry.targets.find((candidate) => candidate.instanceId === instanceId);
			if (!target) continue;
			const owed = !target.answered && !target.gone;
			target.gone = true;
			// Only work this peer still owed is attributed to its disappearance.
			if (owed) pending.push(entry);
			if (entry.targets.every((candidate) => candidate.answered || candidate.gone)) {
				this.pending.delete(entry.envelopeId);
			}
		}

		if (!record && pending.length === 0) return;
		const known = record || this.peerCache.peers.find((peer) => peer.instanceId === instanceId);
		if (!known) return;
		this.safely(() => this.options.onPeerGone?.({ record: known, reason, pending }));
	}

	/** No background promise may reject into the process. */
	private detach(promise: Promise<unknown>): void {
		promise.catch((error: Error) => this.options.log?.(`background task failed: ${error.message}`));
	}

	private safely(action: () => void): void {
		try {
			action();
		} catch (error) {
			this.options.log?.(`bus callback failed: ${(error as Error).message}`);
		}
	}

	private remember(id: string): boolean {
		if (this.seenSet.has(id)) return false;
		this.seenSet.add(id);
		this.seen.push(id);
		if (this.seen.length > DEDUPE_LIMIT) {
			const evicted = this.seen.shift();
			if (evicted) this.seenSet.delete(evicted);
		}
		return true;
	}

	private validate(envelope: Envelope): string | undefined {
		if (!envelope || typeof envelope !== "object") return "not an object";
		if (envelope.v !== BUS_PROTOCOL) return `protocol ${envelope.v} unsupported, expected ${BUS_PROTOCOL}`;
		if (typeof envelope.id !== "string" || !envelope.id) return "missing id";
		if (typeof envelope.body !== "string") return "missing body";
		if (Buffer.byteLength(envelope.body, "utf8") > MAX_BODY_BYTES) return "body too large";
		if (!envelope.from?.instanceId || !envelope.from?.name) return "missing sender identity";
		if (envelope.expiresAt && envelope.expiresAt < Date.now()) return "expired";
		return undefined;
	}

	private accept(socket: Socket): void {
		socket.on("error", () => socket.destroy());
		socket.setTimeout(DIAL_TIMEOUT_MS * 2, () => socket.destroy());

		jsonlReader(socket, (line) => {
			let request: WireRequest;
			try {
				request = JSON.parse(line) as WireRequest;
			} catch {
				this.respond(socket, { type: "error", reason: "invalid json" });
				return;
			}

			if (request?.type === "ping") {
				this.respond(socket, {
					type: "pong",
					instanceId: this.instanceId,
					name: this.name,
					state: this.state,
					activity: this.activity,
					pid: process.pid,
					startedAt: this.startedAt,
					labels: this.labels,
				});
				return;
			}

			if (request?.type === "envelope") {
				const envelope = request.envelope;
				const problem = this.validate(envelope);
				if (problem) {
					this.respond(socket, {
						type: "ack",
						id: envelope?.id || "unknown",
						instanceId: this.instanceId,
						name: this.name,
						accepted: false,
						reason: problem,
					});
					return;
				}

				const fresh = this.remember(envelope.id);
				this.respond(socket, {
					type: "ack",
					id: envelope.id,
					instanceId: this.instanceId,
					name: this.name,
					accepted: true,
					reason: fresh ? undefined : "duplicate ignored",
				});
				if (!fresh) return;

				this.resolveAnswer(envelope);
				// An endpoint can stop while its host process keeps running, for
				// example across an extension reload. Process liveness would then
				// never retire the watch, so the explicit notice is the tombstone.
				if (isPeerLeft(envelope) && envelope.from.instanceId !== this.instanceId) {
					this.markGone(envelope.from.instanceId, "left");
				}

				// A throwing consumer must never take down the process.
				try {
					const outcome = this.options.onEnvelope(envelope);
					if (outcome && typeof (outcome as Promise<void>).catch === "function") {
						(outcome as Promise<void>).catch((error: Error) =>
							this.options.log?.(`onEnvelope failed: ${error.message}`),
						);
					}
				} catch (error) {
					this.options.log?.(`onEnvelope threw: ${(error as Error).message}`);
				}
				return;
			}

			this.respond(socket, { type: "error", reason: "unknown request" });
		});
	}

	private respond(socket: Socket, response: WireResponse): void {
		if (socket.destroyed) return;
		try {
			socket.write(`${JSON.stringify(response)}\n`);
		} catch {
			socket.destroy();
		}
	}

	/** Best effort exit notice so parents learn immediately instead of on the next poll. */
	private async announceBye(): Promise<void> {
		let targets: PeerRecord[] = [];
		try {
			targets = matchPeers("all", this.peers(0), this.selectorContext);
		} catch {
			return;
		}
		if (targets.length === 0) return;
		const envelope = this.buildEnvelope("all", {
			body: `${this.name} is shutting down`,
			kind: "event",
			subject: "peer_left",
			wake: "never",
			data: { event: "peer_left", instanceId: this.instanceId, name: this.name, labels: this.labels },
		});
		await Promise.allSettled(
			targets.map((peer) => dial(peer.sock, { v: BUS_PROTOCOL, type: "envelope", envelope }, BYE_TIMEOUT_MS)),
		);
	}
}

function isPeerLeft(envelope: Envelope): boolean {
	if (envelope.kind !== "event") return false;
	const data = envelope.data as { event?: string } | undefined;
	return data?.event === "peer_left" || envelope.subject === "peer_left";
}

function describeDialFailure(error: DialError, peer: PeerRecord): string {
	if (error.code === "ENOENT") return "socket missing, peer is gone";
	if (error.code === "ECONNREFUSED") return "connection refused, peer is gone";
	if (!pidAlive(peer.pid)) return "peer process is dead";
	if (error.handedOver) return "written but not acked, peer event loop is blocked, delivery unknown";
	return error.message || "dial failed";
}
