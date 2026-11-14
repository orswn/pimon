import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { migrate, MIGRATIONS, SCHEMA_VERSION } from "./db.ts";

const version = (db: DatabaseSync) =>
	(db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

describe("hub database", () => {
	it("upgrades a version 1 database and keeps its rows", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(MIGRATIONS[0] ?? "");
		db.exec("PRAGMA user_version = 1");
		db.prepare("INSERT INTO agents (id, kind, host, name, registered_at) VALUES (?, 'pi', 'mars', 'bee', ?)").run(
			"a1",
			"2026-11-14T00:00:00.000Z",
		);
		migrate(db);
		expect(SCHEMA_VERSION).toBe(2);
		expect(version(db)).toBe(2);
		const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
			(row) => row.name,
		);
		expect(tables).toEqual(expect.arrayContaining(["external_outbox", "remote_tasks"]));
		expect(db.prepare("SELECT id, kind, name FROM agents").all()).toEqual([{ id: "a1", kind: "pi", name: "bee" }]);
		migrate(db);
		expect(version(db)).toBe(2);
	});

	it("refuses a database from a newer hub", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
		expect(() => migrate(db)).toThrow(`database schema ${SCHEMA_VERSION + 1} is newer than this hub`);
	});
});
