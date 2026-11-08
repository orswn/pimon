import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { busDirs, socketPathFor } from "./registry.ts";

const ID = "0123456789abcdef0123456789abcdef";
const LEAF = `${ID}.sock`;
let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bus-sock-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("bus socket path", () => {
	const deep = () => busDirs(join(root, "x".repeat(80)));

	it("uses the bus socks dir when the path fits", () => {
		const dirs = busDirs(root);
		expect(socketPathFor(ID, dirs, "", [join(root, "y".repeat(80))])).toBe(join(dirs.socks, LEAF));
	});

	it("skips a fallback root whose path is too long and takes the next one that fits", () => {
		const long = join(root, "t".repeat(80));
		const short = join(root, "s");
		const path = socketPathFor(ID, deep(), "", [long, short]);
		expect(path).toBe(join(short, `pi-bus-${userInfo().uid}`, LEAF));
		expect(existsSync(join(long, `pi-bus-${userInfo().uid}`))).toBe(false);
		expect(existsSync(join(short, `pi-bus-${userInfo().uid}`))).toBe(true);
	});

	it("tightens a fallback dir that group or other users can enter", () => {
		const open = join(root, "o", `pi-bus-${userInfo().uid}`);
		mkdirSync(open, { recursive: true });
		chmodSync(open, 0o777);
		expect(socketPathFor(ID, deep(), "", [join(root, "o")])).toBe(join(open, LEAF));
		expect(statSync(open).mode & 0o777).toBe(0o700);
	});

	it("skips a fallback dir that is a symlink", () => {
		const target = join(root, "elsewhere");
		mkdirSync(target, { mode: 0o700 });
		mkdirSync(join(root, "l"));
		const linked = join(root, "l", `pi-bus-${userInfo().uid}`);
		symlinkSync(target, linked);
		const path = socketPathFor(ID, deep(), "", [join(root, "l"), join(root, "s")]);
		expect(path).toBe(join(root, "s", `pi-bus-${userInfo().uid}`, LEAF));
		expect(lstatSync(linked).isSymbolicLink()).toBe(true);
	});

	it("names each tried dir when no fallback dir is usable", () => {
		mkdirSync(join(root, "l"));
		const linked = join(root, "l", `pi-bus-${userInfo().uid}`);
		symlinkSync(root, linked);
		expect(() => socketPathFor(ID, deep(), "", [join(root, "l")])).toThrow(
			`no usable bus socket dir: ${linked} is a symlink`,
		);
	});

	it("throws before any bind when no candidate path fits", () => {
		const dirs = deep();
		expect(() => socketPathFor(ID, dirs, "", [join(root, "t".repeat(80))])).toThrow(
			`bus socket path is too long: ${join(dirs.socks, LEAF)}`,
		);
	});
});
