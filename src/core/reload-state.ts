const KEY = Symbol.for("pimon.reload-state");

interface Slot {
	version: number;
	value: unknown;
}

type Store = Map<string, Slot>;

function store(): Store {
	const holder = globalThis as { [KEY]?: Store };
	holder[KEY] ??= new Map();
	return holder[KEY];
}

export function reloadSlot<T>(owner: string, key: string, version: number, create: () => T): T {
	const slots = store();
	const id = `${owner}/${key}`;
	const existing = slots.get(id);
	if (existing && existing.version === version) return existing.value as T;
	const value = create();
	slots.set(id, { version, value });
	return value;
}

export function clearReloadState(): void {
	store().clear();
}
