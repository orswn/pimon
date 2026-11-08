// Per-session message log. Old and new pi on the same session file share the history file.

import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { Envelope } from "./protocol.ts";
import { fullId, idMatches, withoutToken } from "./protocol.ts";
import type { BusDirs } from "./registry.ts";

const MAX_BYTES = 1_000_000;
const MAX_IN_MEMORY = 400;
const FILE_MODE = 0o600;
const DAY_MS = 24 * 60 * 60 * 1000;

type Direction = "in" | "out";

interface StoredLine {
	direction: Direction;
	envelope: Envelope;
}

export type Lookup = { envelope: Envelope } | { error: string };

/** Plain data for reload state. Class instances there would keep an old prototype after an upgrade. */
export interface StoreSnapshot {
	inbox: Envelope[];
	outbox: Envelope[];
	unread: string[];
}

const MIN_PREFIX_HEX = 8;

function prefixError(kind: string, value: string): string | undefined {
	return fullId(value).length < MIN_PREFIX_HEX
		? `${kind} ${value} needs at least ${MIN_PREFIX_HEX} hex characters.`
		: undefined;
}

export function historyPath(sessionFile: string, dirs: BusDirs): string {
	const key = createHash("sha256").update(sessionFile).digest("hex").slice(0, 12);
	return join(dirs.history, `${key}.jsonl`);
}

export class BusStore {
	readonly inbox: Envelope[] = [];
	readonly outbox: Envelope[] = [];
	readonly unread = new Set<string>();

	private readonly path: string | undefined;
	private readonly dirs: BusDirs;

	constructor(sessionFile: string | undefined, dirs: BusDirs) {
		this.dirs = dirs;
		this.path = sessionFile ? historyPath(sessionFile, dirs) : undefined;
	}

	static restore(sessionFile: string | undefined, dirs: BusDirs, snapshot: StoreSnapshot): BusStore {
		const store = new BusStore(sessionFile, dirs);
		store.inbox.push(...snapshot.inbox);
		store.outbox.push(...snapshot.outbox);
		for (const id of snapshot.unread) store.unread.add(id);
		// A snapshot from an older version can hold more than the kept envelopes.
		store.trim();
		return store;
	}

	snapshot(): StoreSnapshot {
		return { inbox: [...this.inbox], outbox: [...this.outbox], unread: [...this.unread] };
	}

	get historyFile(): string | undefined {
		return this.path;
	}

	load(): void {
		if (!this.path || !existsSync(this.path)) return;
		let content: string;
		try {
			content = readFileSync(this.path, "utf8");
		} catch {
			return;
		}
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line) as StoredLine;
				if (!entry?.envelope?.id) continue;
				const envelope = withoutToken(entry.envelope);
				if (entry.direction === "in") this.inbox.push(envelope);
				else this.outbox.push(envelope);
			} catch {
				// Skip a torn line rather than losing the whole log.
			}
		}
		this.trim();
	}

	addInbound(raw: Envelope): Envelope {
		const envelope = withoutToken(raw);
		this.inbox.push(envelope);
		if (envelope.kind !== "event" && envelope.kind !== "control") this.unread.add(envelope.id);
		this.append("in", envelope);
		this.trim();
		return envelope;
	}

	addOutbound(raw: Envelope): Envelope {
		const envelope = withoutToken(raw);
		this.outbox.push(envelope);
		this.append("out", envelope);
		this.trim();
		return envelope;
	}

	markRead(ids: Iterable<string>): void {
		for (const id of ids) this.unread.delete(id);
	}

	isOutbound(id: string): boolean {
		return this.outbox.some((envelope) => envelope.id === id);
	}

	/** Full id or unique prefix, with or without dashes. */
	lookup(id: string): Lookup {
		const want = id.trim();
		if (!want) return { error: "messageId is empty." };
		const short = prefixError("messageId", want);
		if (short) return { error: short };
		const all = [...this.inbox, ...this.outbox];
		const exact = all.find((envelope) => fullId(envelope.id) === fullId(want));
		if (exact) return { envelope: exact };
		const matches = new Map(all.filter((envelope) => idMatches(envelope.id, want)).map((e) => [e.id, e]));
		if (matches.size === 1) return { envelope: [...matches.values()][0] as Envelope };
		if (matches.size === 0) return { error: `No stored message has id ${want}. Use action="inbox" to list messages.` };
		return { error: `messageId ${want} matches ${matches.size} messages. Use a longer prefix.` };
	}

	find(id: string): Envelope | undefined {
		const found = this.lookup(id);
		return "envelope" in found ? found.envelope : undefined;
	}

	thread(id: string): Envelope[] {
		return [...this.inbox, ...this.outbox]
			.filter((envelope) => idMatches(envelope.threadId, id))
			.sort((a, b) => a.createdAt - b.createdAt);
	}

	latestInbound(threadId: string): Lookup {
		const want = threadId.trim();
		const short = prefixError("threadId", want);
		if (short) return { error: short };
		const inbound = this.inbox.filter(
			(envelope) => envelope.kind !== "event" && envelope.kind !== "control" && idMatches(envelope.threadId, want),
		);
		const threads = new Set(inbound.map((envelope) => envelope.threadId));
		if (threads.size > 1) return { error: `threadId ${want} matches ${threads.size} threads. Use a longer prefix.` };
		const latest = inbound.sort((a, b) => b.createdAt - a.createdAt)[0];
		if (!latest) return { error: `No inbound message on thread ${want}. Use action="inbox" to find it.` };
		return { envelope: latest };
	}

	byExactId(id: string): Envelope | undefined {
		return [...this.outbox, ...this.inbox].find((envelope) => envelope.id === id);
	}

	/** Inbound questions and reply requests with no outbound message that names them as corrId. */
	unansweredInbound(): Envelope[] {
		const answered = new Set(this.outbox.map((envelope) => envelope.corrId).filter((id): id is string => Boolean(id)));
		return this.inbox.filter(
			(envelope) =>
				(envelope.kind === "question" || envelope.replyExpected === true) &&
				envelope.kind !== "control" &&
				!answered.has(envelope.id),
		);
	}

	private append(direction: Direction, envelope: Envelope): void {
		if (!this.path) return;
		try {
			mkdirSync(this.dirs.history, { recursive: true, mode: 0o700 });
			this.rotate();
			appendFileSync(this.path, `${JSON.stringify({ direction, envelope })}\n`, { encoding: "utf8", mode: FILE_MODE });
		} catch {
			// A full disk must not break messaging. Memory state still works.
		}
	}

	private rotate(): void {
		if (!this.path) return;
		try {
			if (statSync(this.path).size < MAX_BYTES) return;
			renameSync(this.path, `${this.path}.1`);
		} catch {
			// Missing file, or a racing rotation.
		}
	}

	private trim(): void {
		this.inbox.splice(0, Math.max(0, this.inbox.length - MAX_IN_MEMORY));
		this.outbox.splice(0, Math.max(0, this.outbox.length - MAX_IN_MEMORY));
		const kept = new Set(this.inbox.map((envelope) => envelope.id));
		for (const id of this.unread) if (!kept.has(id)) this.unread.delete(id);
	}
}

/** Sets history files to 0600 and deletes files older than `retentionDays`. 0 disables the deletion. */
export function prepareHistory(
	dirs: BusDirs,
	retentionDays: number,
	options: { now?: number; keep?: string | undefined } = {},
): { removed: number } {
	const now = options.now ?? Date.now();
	const keep = options.keep ? [options.keep, `${options.keep}.1`] : [];
	let entries: string[];
	try {
		entries = readdirSync(dirs.history);
	} catch {
		return { removed: 0 };
	}
	let removed = 0;
	for (const entry of entries) {
		if (!/\.jsonl(\.1)?$/.test(entry)) continue;
		const path = join(dirs.history, entry);
		try {
			if (retentionDays > 0 && !keep.includes(path) && now - statSync(path).mtimeMs > retentionDays * DAY_MS) {
				unlinkSync(path);
				removed++;
				continue;
			}
			chmodSync(path, FILE_MODE);
		} catch {
			// Removed or rotated by a racing peer.
		}
	}
	return { removed };
}
