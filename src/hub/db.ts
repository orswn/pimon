import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MIGRATIONS: readonly string[] = [
	`
	CREATE TABLE agents (
		id TEXT PRIMARY KEY,
		kind TEXT NOT NULL CHECK (kind IN ('pi', 'external', 'builtin')),
		host TEXT,
		name TEXT NOT NULL,
		role TEXT,
		cwd TEXT,
		labels TEXT NOT NULL DEFAULT '{}',
		parent TEXT,
		topics TEXT NOT NULL DEFAULT '[]',
		ephemeral INTEGER NOT NULL DEFAULT 0,
		online INTEGER NOT NULL DEFAULT 0,
		state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('busy', 'idle')),
		activity TEXT,
		status_text TEXT NOT NULL DEFAULT '',
		status_at TEXT,
		registered_at TEXT NOT NULL,
		last_seen_at TEXT,
		offline_at TEXT
	);
	CREATE INDEX agents_name ON agents (name);
	CREATE INDEX agents_parent ON agents (parent);

	CREATE TABLE tasks (
		id TEXT PRIMARY KEY,
		agent_id TEXT NOT NULL,
		sender_agent TEXT,
		sender_principal TEXT NOT NULL,
		context_id TEXT NOT NULL,
		state TEXT NOT NULL,
		status_message TEXT,
		status_at TEXT NOT NULL,
		kind TEXT NOT NULL,
		metadata TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE INDEX tasks_agent ON tasks (agent_id, status_at);
	CREATE INDEX tasks_sender ON tasks (sender_agent, state);
	CREATE INDEX tasks_context ON tasks (context_id);

	CREATE TABLE task_messages (
		task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
		seq INTEGER NOT NULL,
		message TEXT NOT NULL,
		PRIMARY KEY (task_id, seq)
	);

	CREATE TABLE artifacts (
		task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
		artifact_id TEXT NOT NULL,
		seq INTEGER NOT NULL,
		artifact TEXT NOT NULL,
		PRIMARY KEY (task_id, artifact_id)
	);

	CREATE TABLE messages (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		id TEXT NOT NULL,
		agent_id TEXT NOT NULL,
		sender_agent TEXT,
		sender_principal TEXT NOT NULL,
		sender_name TEXT NOT NULL,
		sender_kind TEXT NOT NULL,
		context_id TEXT NOT NULL,
		task_id TEXT,
		kind TEXT NOT NULL,
		meta TEXT NOT NULL DEFAULT '{}',
		message TEXT NOT NULL,
		created_at TEXT NOT NULL,
		read_at TEXT,
		reply_to TEXT
	);
	CREATE INDEX messages_agent ON messages (agent_id, id);
	CREATE INDEX messages_sender ON messages (sender_agent, id);
	CREATE INDEX messages_context ON messages (context_id);

	CREATE TABLE link_events (
		seq INTEGER PRIMARY KEY AUTOINCREMENT,
		agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
		type TEXT NOT NULL,
		payload TEXT NOT NULL,
		created_at TEXT NOT NULL,
		acked_at TEXT
	);
	CREATE INDEX link_events_agent ON link_events (agent_id, acked_at, seq);

	CREATE TABLE push_configs (
		task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
		id TEXT NOT NULL,
		url TEXT NOT NULL,
		token TEXT,
		auth_scheme TEXT,
		auth_credentials TEXT,
		principal TEXT NOT NULL,
		created_at TEXT NOT NULL,
		PRIMARY KEY (task_id, id)
	);

	CREATE TABLE push_outbox (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		task_id TEXT NOT NULL,
		config_id TEXT NOT NULL,
		payload TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_at INTEGER NOT NULL,
		FOREIGN KEY (task_id, config_id) REFERENCES push_configs (task_id, id) ON DELETE CASCADE
	);
	CREATE INDEX push_outbox_next ON push_outbox (next_at);
	CREATE INDEX push_outbox_config ON push_outbox (task_id, config_id);

	CREATE TABLE expect_reply (
		sender_agent TEXT NOT NULL,
		message_id TEXT NOT NULL,
		recipient_agent TEXT NOT NULL,
		context_id TEXT NOT NULL,
		task_id TEXT,
		created_at TEXT NOT NULL,
		settled_at TEXT,
		PRIMARY KEY (sender_agent, message_id, recipient_agent)
	);
	CREATE INDEX expect_reply_recipient ON expect_reply (recipient_agent, settled_at);
	CREATE INDEX expect_reply_task ON expect_reply (task_id);
	`,
	`
	CREATE TABLE external_outbox (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		agent_id TEXT NOT NULL,
		task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
		context_id TEXT NOT NULL,
		message_id TEXT,
		op TEXT NOT NULL CHECK (op IN ('send', 'cancel')),
		attempts INTEGER NOT NULL DEFAULT 0,
		first_at INTEGER NOT NULL,
		next_at INTEGER NOT NULL
	);
	CREATE INDEX external_outbox_next ON external_outbox (next_at);

	CREATE TABLE remote_tasks (
		task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
		seq INTEGER NOT NULL,
		agent_id TEXT NOT NULL,
		context_id TEXT NOT NULL,
		message_id TEXT,
		remote_task_id TEXT,
		remote_context_id TEXT,
		state TEXT NOT NULL CHECK (state IN ('dispatched', 'running', 'done')),
		dispatched_at INTEGER NOT NULL,
		last_poll_at INTEGER,
		PRIMARY KEY (task_id, seq)
	);
	CREATE INDEX remote_tasks_context ON remote_tasks (agent_id, context_id, state);
	CREATE INDEX remote_tasks_remote ON remote_tasks (agent_id, remote_task_id);
	`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** `path` is a data directory, or `:memory:` for tests. */
export function openDb(path: string): DatabaseSync {
	let file = path;
	if (path !== ":memory:") {
		mkdirSync(path, { recursive: true });
		file = join(path, "hub.sqlite");
	}
	const db = new DatabaseSync(file, { timeout: 5000 });
	if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA synchronous = NORMAL");
	migrate(db);
	return db;
}

export function migrate(db: DatabaseSync): void {
	const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
	const from = row.user_version;
	if (from > MIGRATIONS.length) {
		throw new Error(`database schema ${from} is newer than this hub (${MIGRATIONS.length})`);
	}
	for (let version = from; version < MIGRATIONS.length; version++) {
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec(MIGRATIONS[version] ?? "");
			db.exec(`PRAGMA user_version = ${version + 1}`);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
}
