export const ENV_PREFIX = "PI_SECRET_";
export const MAX_SECRET_BYTES = 64 * 1024;
export const MAX_TOTAL_BYTES = 256 * 1024;
export const MIN_REDACT_LENGTH = 4;
export const MIN_LINE_REDACT_LENGTH = 16;
// Not a `$PI_SECRET_` handle: an askpass reply must not look like a usable shell variable.
export const ASKPASS_REDACTED = "[askpass reply redacted]";

// Crockford base32: no I, L, O, U. 256 is a multiple of 32, so `b & 31` is unbiased.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TAG = /(\\?)\[\[secret(?:[ \t]+([A-Za-z][A-Za-z0-9_]*))?:([\s\S]*?)\]\]/g;
// Only expansion forms ($X, ${X}, ${#X}) count, so commands that merely mention the prefix pass.
const HANDLE = /\$(?:\{#?)?PI_SECRET_([A-Za-z0-9_]+)/g;

export function newId(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => ALPHABET.charAt(b & 31)).join("");
}

export class SecretStore {
	private secrets = new Map<string, string>();
	private redactOnly = new Set<string>();
	private patterns: { text: string; handle: string }[] | undefined;

	has(name: string): boolean {
		return this.secrets.has(name);
	}

	get(name: string): string | undefined {
		return this.secrets.get(name);
	}

	get size(): number {
		return this.secrets.size + this.redactOnly.size;
	}

	names(): string[] {
		return [...this.secrets.keys()];
	}

	clear(): void {
		this.secrets.clear();
		this.redactOnly.clear();
		this.patterns = undefined;
	}

	totalBytes(): number {
		let total = 0;
		for (const value of this.secrets.values()) total += Buffer.byteLength(value);
		return total;
	}

	add(value: string, name?: string): { name: string; replaced: boolean } {
		if (!name) {
			for (const [existing, v] of this.secrets) if (v === value) return { name: existing, replaced: false };
			let id = newId();
			while (this.secrets.has(id)) id = newId();
			name = id;
		}
		const replaced = this.secrets.has(name) && this.secrets.get(name) !== value;
		this.secrets.set(name, value);
		this.patterns = undefined;
		return { name, replaced };
	}

	addRedactOnly(value: string): void {
		this.redactOnly.add(value);
		this.patterns = undefined;
	}

	redact(text: string): string {
		for (const { text: secret, handle } of this.redactionPatterns()) {
			if (text.includes(secret)) text = text.split(secret).join(handle);
		}
		return text;
	}

	private redactionPatterns() {
		if (this.patterns) return this.patterns;
		const patterns = new Map<string, string>();
		const sources = [
			...Array.from(this.redactOnly, (value) => [value, ASKPASS_REDACTED] as const),
			...Array.from(this.secrets, ([name, value]) => [value, `$${ENV_PREFIX}${name}`] as const),
		];
		for (const [value, handle] of sources) {
			if (value.length < MIN_REDACT_LENGTH) continue;
			patterns.set(value, handle);
			if (value.includes("\n")) patterns.set(value.replace(/\r?\n/g, "\r\n"), handle);
			for (const line of value.split(/\r?\n/)) {
				if (line.length >= MIN_LINE_REDACT_LENGTH) patterns.set(line, handle);
			}
		}
		this.patterns = [...patterns]
			.map(([text, handle]) => ({ text, handle }))
			.sort((a, b) => b.text.length - a.text.length);
		return this.patterns;
	}
}

export type TagResult = {
	text: string;
	added: { name: string; replaced: boolean; short: boolean }[];
};

// Validates every tag before storing any, so a rejected message stores nothing.
export function transformInput(text: string, store: SecretStore): TagResult {
	const found: { value: string; name?: string }[] = [];
	for (const match of text.matchAll(TAG)) {
		if (match[1]) continue;
		const value = (match[3] ?? "").replace(/^\r?\n/, "").replace(/\r?\n$/, "");
		if (!value) throw new Error("empty secret tag");
		if (value.includes("\0")) throw new Error("secret contains a NUL byte");
		if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new Error(`secret exceeds ${MAX_SECRET_BYTES} bytes`);
		found.push({ value, name: match[2]?.toUpperCase() });
	}
	const incoming = found.reduce((sum, f) => sum + Buffer.byteLength(f.value), 0);
	if (store.totalBytes() + incoming > MAX_TOTAL_BYTES)
		throw new Error(`secrets exceed ${MAX_TOTAL_BYTES} bytes in total`);

	const added: TagResult["added"] = [];
	let i = 0;
	const out = text.replace(TAG, (whole, escape: string) => {
		if (escape) return whole.slice(1);
		const item = found[i++];
		if (!item) throw new Error("secret tag changed while parsing");
		const { value, name } = item;
		const result = store.add(value, name);
		added.push({ ...result, short: value.length < MIN_REDACT_LENGTH });
		return `$${ENV_PREFIX}${result.name}`;
	});
	return { text: out, added };
}

export function hasTag(text: string): boolean {
	return text.includes("[[secret");
}

export function unknownHandles(text: string, store: SecretStore): string[] {
	const unknown = new Set<string>();
	for (const match of text.matchAll(HANDLE)) {
		const name = match[1] ?? "";
		if (!store.has(name)) unknown.add(`$${ENV_PREFIX}${name}`);
	}
	return [...unknown];
}

export function redactDeep<T>(value: T, store: SecretStore): T {
	if (typeof value === "string") return store.redact(value) as T;
	if (Array.isArray(value)) return value.map((v) => redactDeep(v, store)) as T;
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, store)])) as T;
	}
	return value;
}
