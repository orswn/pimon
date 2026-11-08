// Raw chunks go to disk exactly as the command printed them. One long-lived fd, and one
// rotation caps disk use so a runaway `yes` cannot fill the filesystem.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Injectable so every open and rename failure path can be exercised in tests. */
export interface FileOps {
	openSync: typeof fs.openSync;
	closeSync: typeof fs.closeSync;
	writeSync: (fd: number, buffer: Buffer) => number;
	renameSync: typeof fs.renameSync;
	unlinkSync: typeof fs.unlinkSync;
	statSync: typeof fs.statSync;
	mkdirSync: typeof fs.mkdirSync;
	accessSync: typeof fs.accessSync;
}

export const realOps: FileOps = {
	openSync: fs.openSync,
	closeSync: fs.closeSync,
	writeSync: (fd, buffer) => fs.writeSync(fd, buffer),
	renameSync: fs.renameSync,
	unlinkSync: fs.unlinkSync,
	statSync: fs.statSync,
	mkdirSync: fs.mkdirSync,
	accessSync: fs.accessSync,
};

export class LogSink {
	readonly file: string;
	private readonly maxBytes: number;
	private readonly ops: FileOps;
	private fd: number | undefined;
	private bytes = 0;
	private rotations = 0;
	private failure: string | undefined;
	private closed = false;
	private rotationDisabled: string | undefined;
	private activePath: string;

	private readonly fileMode: number | undefined;

	/** `fileMode` applies to files this sink creates. */
	constructor(file: string, maxBytes: number, ops: Partial<FileOps> = {}, fileMode?: number) {
		this.file = file;
		this.fileMode = fileMode;
		this.activePath = file;
		this.maxBytes = maxBytes;
		this.ops = { ...realOps, ...ops };
	}

	open(header: string): void {
		try {
			ensureWritableDir(path.dirname(this.file), this.ops);
			this.fd = this.ops.openSync(this.file, "a", this.fileMode);
		} catch (error) {
			this.fail(error);
			return;
		}
		this.write(header.endsWith("\n") ? header : `${header}\n`);
	}

	write(chunk: string): void {
		if (this.closed || this.failure !== undefined || this.fd === undefined || chunk.length === 0) return;
		const buffer = Buffer.from(chunk, "utf8");
		try {
			this.ops.writeSync(this.fd, buffer);
			this.bytes += buffer.byteLength;
			if (this.bytes >= this.maxBytes) this.rotate();
		} catch (error) {
			this.fail(error);
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.fd === undefined) return;
		this.closeFd(this.fd);
		this.fd = undefined;
	}

	/** Bytes written to the current file, ignoring anything already rotated away. */
	get written(): number {
		return this.bytes;
	}

	get error(): string | undefined {
		return this.failure;
	}

	note(): string | undefined {
		const notes: string[] = [];
		if (this.failure) notes.push(`Log file unavailable (${this.failure}); only the in-memory tail exists.`);
		if (this.rotationDisabled) notes.push(this.rotationDisabled);
		if (this.rotations > 0)
			notes.push(
				`Log rotated ${this.rotations} time(s) at ${this.maxBytes} bytes; older output is in ${this.file}.1 or gone.`,
			);
		if (this.activePath !== this.file) notes.push(`Output is being written to ${this.activePath}, not ${this.file}.`);
		return notes.length > 0 ? notes.join(" ") : undefined;
	}

	get path(): string {
		return this.activePath;
	}

	// Invariant: at every step exactly one valid fd is open on a named path. The new file
	// opens first under a unique temp name, and each rename has a rollback.
	private rotate(): void {
		if (this.fd === undefined || this.rotationDisabled) return;
		const temp = `${this.file}.rot-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
		const previous = `${this.file}.1`;
		const oldFd = this.fd;

		let newFd: number;
		try {
			newFd = this.ops.openSync(temp, "a", this.fileMode);
		} catch (error) {
			this.rotationDisabled = `rotation unavailable (${message(error)}); the log keeps growing past ${this.maxBytes} bytes`;
			return;
		}

		try {
			this.ops.renameSync(this.file, previous);
		} catch (error) {
			this.closeFd(newFd);
			this.unlink(temp);
			this.rotationDisabled = `rotation unavailable (${message(error)}); the log keeps growing past ${this.maxBytes} bytes`;
			return;
		}

		try {
			this.ops.renameSync(temp, this.file);
		} catch (error) {
			try {
				this.ops.renameSync(previous, this.file);
				this.closeFd(newFd);
				this.unlink(temp);
				this.rotationDisabled = `rotation rolled back (${message(error)})`;
				return;
			} catch {
				// Rollback failed too. The temp fd is the only writable handle left.
				this.closeFd(oldFd);
				this.fd = newFd;
				this.activePath = temp;
				this.bytes = 0;
				this.rotations++;
				this.rotationDisabled = `rotation half-applied (${message(error)}); output continues in ${temp}`;
				return;
			}
		}

		this.closeFd(oldFd);
		this.fd = newFd;
		this.activePath = this.file;
		this.bytes = 0;
		this.rotations++;
	}

	private closeFd(fd: number): void {
		try {
			this.ops.closeSync(fd);
		} catch {
			// Already closed.
		}
	}

	private unlink(file: string): void {
		try {
			this.ops.unlinkSync(file);
		} catch {
			// Never existed.
		}
	}

	private fail(error: unknown): void {
		this.failure = message(error);
		if (this.fd !== undefined) {
			this.closeFd(this.fd);
			this.fd = undefined;
		}
	}
}

// Recursive mkdirSync hangs instead of failing under a read-only pseudo-filesystem such as
// /proc, which would wedge pi. So the nearest existing ancestor is checked for write access first.
function ensureWritableDir(dir: string, ops: FileOps): void {
	try {
		if (!ops.statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
		ops.accessSync(dir, fs.constants.W_OK);
		return;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	ops.accessSync(nearestExisting(dir), fs.constants.W_OK);
	ops.mkdirSync(dir, { recursive: true });
}

function nearestExisting(dir: string): string {
	let current = dir;
	for (;;) {
		const parent = path.dirname(current);
		if (parent === current) return current;
		try {
			if (!fs.statSync(parent).isDirectory()) throw new Error(`${parent} is not a directory`);
			return parent;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		current = parent;
	}
}

export interface TailResult {
	lines: string[];
	error: string | undefined;
}

// rename() keeps the inode, so reading `file` then `file.1` can read one generation twice.
// Identity is {dev, ino}, and a detected rotation costs one retry.
export function readTail(file: string, lines: number, maxBytes: number): TailResult {
	const want = Math.max(1, lines);
	for (let attempt = 0; attempt < 2; attempt++) {
		const current = readTailBytes(file, maxBytes);
		if (current.error) return { lines: [], error: current.error };
		let collected = splitTail(current.text, current.partial);

		if (collected.length >= lines) return { lines: collected.slice(-want), error: undefined };

		const previous = readTailBytes(`${file}.1`, maxBytes);
		if (previous.error) return { lines: collected.slice(-want), error: previous.error };

		const sameGeneration =
			previous.id !== undefined &&
			current.id !== undefined &&
			previous.id.dev === current.id.dev &&
			previous.id.ino === current.id.ino;
		if (sameGeneration) {
			if (attempt === 0) continue;
			return { lines: collected.slice(-want), error: undefined };
		}
		if (previous.text) collected = [...splitTail(previous.text, previous.partial), ...collected];
		return { lines: collected.slice(-want), error: undefined };
	}
	return { lines: [], error: undefined };
}

function splitTail(text: string, droppedPartial: boolean): string[] {
	if (!text) return [];
	const parts = text.split("\n");
	if (droppedPartial) parts.shift();
	if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
	return parts;
}

interface TailBytes {
	text: string;
	partial: boolean;
	id: { dev: number; ino: number } | undefined;
	error: string | undefined;
}

function readTailBytes(file: string, maxBytes: number): TailBytes {
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const stat = fs.fstatSync(fd);
		const id = { dev: Number(stat.dev), ino: Number(stat.ino) };
		if (stat.size === 0) return { text: "", partial: false, id, error: undefined };
		const start = Math.max(0, stat.size - maxBytes);
		// One byte before the window tells whether the window started mid-line.
		const probeStart = start > 0 ? start - 1 : 0;
		const length = stat.size - probeStart;
		const buffer = Buffer.allocUnsafe(length);
		fs.readSync(fd, buffer, 0, length, probeStart);
		const text = buffer.toString("utf8");
		if (start === 0) return { text, partial: false, id, error: undefined };
		const startedMidLine = text[0] !== "\n";
		return { text: text.slice(1), partial: startedMidLine, id, error: undefined };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { text: "", partial: false, id: undefined, error: undefined };
		return { text: "", partial: false, id: undefined, error: `${code ?? "read failed"}: ${message(error)}` };
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Ignore.
			}
		}
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
