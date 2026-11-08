import type { FindKind, Motion, MotionKey } from "./motions.ts";
import { OBJECT_KEYS } from "./text-objects.ts";

export type Operator = "d" | "c" | "y";
export type SimpleKey = "x" | "s" | "S" | "D" | "C" | "Y" | "J" | "p" | "P" | "u" | "i" | "a" | "A" | "I" | "o" | "O";

export type Target = { motion: Motion } | { object: "i" | "a"; key: string } | { line: true };

interface Counted {
	count: number;
	hasCount: boolean;
}

export type Command =
	| ({ type: "move"; motion: Motion } & Counted)
	| ({ type: "operator"; op: Operator; target: Target } & Counted)
	| ({ type: "simple"; key: SimpleKey } & Counted)
	| ({ type: "replace"; char: string } & Counted);

export type Feed = { kind: "pending" } | { kind: "none" } | { kind: "command"; command: Command };

export const MAX_COUNT = 9999;

const MOTIONS = new Set<string>(["h", "j", "k", "l", "0", "^", "_", "$", "w", "b", "e", "W", "B", "E", "G", ";", ","]);
const SIMPLE = new Set<string>(["x", "s", "S", "D", "C", "Y", "J", "p", "P", "u", "i", "a", "A", "I", "o", "O"]);
const FINDS = new Set<string>(["f", "F", "t", "T"]);
const OPERATORS = new Set<string>(["d", "c", "y"]);

type Wait = "g" | "r" | "i" | "a" | FindKind;

/** Pure normal-mode key parser. One printable key in, a command out once complete. */
export class Parser {
	private prefix = "";
	private op: Operator | undefined;
	private opCount = "";
	private wait: Wait | undefined;

	get pending(): boolean {
		return this.label() !== "";
	}

	label(): string {
		const text = `${this.prefix}${this.op ?? ""}${this.opCount}${this.wait ?? ""}`;
		return text === "" ? "" : `${text}_`;
	}

	reset(): void {
		this.prefix = "";
		this.op = undefined;
		this.opCount = "";
		this.wait = undefined;
	}

	/** The typed count for a key outside the parser, such as `ctrl+r`. Resets the parser. */
	takeCount(): number {
		const { count } = this.counted();
		this.reset();
		return count;
	}

	feed(key: string): Feed {
		const wait = this.wait;
		if (wait !== undefined) return this.finishWait(wait, key);
		if (/^[0-9]$/.test(key) && (key !== "0" || (this.op ? this.opCount : this.prefix) !== "")) {
			if (this.op) this.opCount += key;
			else this.prefix += key;
			return { kind: "pending" };
		}
		const op = this.op;
		if (op) {
			if (key === op) return this.done({ type: "operator", op, target: { line: true } });
			if (key === "i" || key === "a" || key === "g" || FINDS.has(key)) return this.waitFor(key as Wait);
			if (MOTIONS.has(key)) return this.done({ type: "operator", op, target: { motion: { key: key as MotionKey } } });
			return this.cancel();
		}
		if (OPERATORS.has(key)) {
			this.op = key as Operator;
			return { kind: "pending" };
		}
		if (MOTIONS.has(key)) return this.done({ type: "move", motion: { key: key as MotionKey } });
		if (SIMPLE.has(key)) return this.done({ type: "simple", key: key as SimpleKey });
		if (key === "r" || key === "g" || FINDS.has(key)) return this.waitFor(key as Wait);
		return this.cancel();
	}

	private finishWait(wait: Wait, key: string): Feed {
		if (wait === "r") return this.done({ type: "replace", char: key });
		if (wait === "i" || wait === "a") {
			if (!OBJECT_KEYS.has(key) || !this.op) return this.cancel();
			return this.done({ type: "operator", op: this.op, target: { object: wait, key } });
		}
		let motion: Motion;
		if (wait === "g") {
			if (key !== "g") return this.cancel();
			motion = { key: "gg" };
		} else {
			motion = { key: wait, char: key };
		}
		return this.done(this.op ? { type: "operator", op: this.op, target: { motion } } : { type: "move", motion });
	}

	private waitFor(wait: Wait): Feed {
		this.wait = wait;
		return { kind: "pending" };
	}

	private counted(): Counted {
		const prefix = this.prefix === "" ? 1 : Number(this.prefix);
		const opCount = this.opCount === "" ? 1 : Number(this.opCount);
		return {
			count: Math.min(MAX_COUNT, prefix * opCount),
			hasCount: this.prefix !== "" || this.opCount !== "",
		};
	}

	private done(command: DistributiveOmit<Command, keyof Counted>): Feed {
		const result = { kind: "command", command: { ...command, ...this.counted() } as Command } as const;
		this.reset();
		return result;
	}

	private cancel(): Feed {
		this.reset();
		return { kind: "none" };
	}
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
