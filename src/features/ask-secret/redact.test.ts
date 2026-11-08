import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { SecretStore } from "./core.ts";
import { REMOVED_OUTPUT, redactFile, redactToolResult, redactWake } from "./index.ts";

const store = new SecretStore();
store.add("s3cr3t-value", "DB");

const result = (fields: Partial<ToolResultEvent>) =>
	({
		type: "tool_result",
		toolName: "probe",
		toolCallId: "1",
		input: {},
		isError: false,
		content: [],
		...fields,
	}) as ToolResultEvent;

describe("redactToolResult", () => {
	it("redacts content, structuredContent, and details together", () => {
		const patch = redactToolResult(
			result({
				content: [{ type: "text", text: "got s3cr3t-value" }],
				structuredContent: { v: "s3cr3t-value" },
				details: { deep: ["s3cr3t-value"] },
			}),
			store,
		);
		expect(patch).toEqual({
			content: [{ type: "text", text: "got $PI_SECRET_DB" }],
			structuredContent: { v: "$PI_SECRET_DB" },
			details: { deep: ["$PI_SECRET_DB"] },
		});
	});

	it("keeps structuredContent when only content changes", () => {
		const patch = redactToolResult(
			result({ content: [{ type: "text", text: "s3cr3t-value" }], structuredContent: { ok: true } }),
			store,
		);
		expect(patch?.structuredContent).toEqual({ ok: true });
	});

	it("redacts details alone", () => {
		expect(redactToolResult(result({ details: { token: "s3cr3t-value" } }), store)?.details).toEqual({
			token: "$PI_SECRET_DB",
		});
	});

	it("leaves a clean result untouched", () => {
		expect(redactToolResult(result({ content: [{ type: "text", text: "ok" }], details: { n: 1 } }), store)).toBe(
			undefined,
		);
	});
});

describe("redactFile", () => {
	const dir = mkdtempSync(join(tmpdir(), "pimon-redact-file-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	let n = 0;
	const file = (content: string) => {
		const path = join(dir, `out-${n++}.log`);
		writeFileSync(path, content, { mode: 0o644 });
		return path;
	};

	it("rewrites a file that holds a secret", async () => {
		const path = file("a s3cr3t-value b");
		expect(await redactFile(path, store)).toMatchObject({ outcome: "redacted" });
		expect(readFileSync(path, "utf8")).toBe("a $PI_SECRET_DB b");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("leaves a clean file untouched", async () => {
		const path = file("nothing here");
		expect(await redactFile(path, store)).toEqual({ outcome: "unchanged" });
		expect(statSync(path).mode & 0o777).toBe(0o644);
	});

	it("replaces the content when the file is above the size cap", async () => {
		const path = file(`${"x".repeat(64)} s3cr3t-value`);
		const result = await redactFile(path, store, { maxBytes: 32 });
		expect(result.outcome).toBe("removed");
		expect(String("error" in result ? result.error : "")).toContain("above the 32 byte limit");
		expect(readFileSync(path, "utf8")).toBe(REMOVED_OUTPUT);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it.skipIf(process.getuid?.() === 0)("replaces the content when the file cannot be read", async () => {
		const path = file("s3cr3t-value");
		chmodSync(path, 0o000);
		const result = await redactFile(path, store);
		expect(result.outcome).toBe("removed");
		expect(String("error" in result ? result.error : "")).toContain("EACCES");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).toBe(REMOVED_OUTPUT);
	});

	it("does nothing for a file that no longer exists", async () => {
		expect(await redactFile(join(dir, "gone.log"), store)).toEqual({ outcome: "missing" });
	});
});

describe("redactWake", () => {
	it("redacts string content and details", () => {
		expect(
			redactWake({ customType: "x", content: "got s3cr3t-value", details: { a: ["s3cr3t-value"] } }, store),
		).toEqual({
			customType: "x",
			content: "got $PI_SECRET_DB",
			details: { a: ["$PI_SECRET_DB"] },
		});
	});

	it("redacts text parts and keeps image parts", () => {
		const image = { type: "image" as const, data: "s3cr3t-value", mimeType: "image/png" };
		const message = {
			customType: "x",
			content: [{ type: "text" as const, text: "s3cr3t-value" }, image],
			display: true,
		};
		expect(redactWake(message, store)).toEqual({
			customType: "x",
			content: [{ type: "text", text: "$PI_SECRET_DB" }, image],
			display: true,
		});
	});

	it("returns the same message when no secret is stored", () => {
		const message = { customType: "x", content: "s3cr3t-value" };
		expect(redactWake(message, new SecretStore())).toBe(message);
	});
});
