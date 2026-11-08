// pi expands a prompt template only for raw editor text and runs extension commands first, so
// `/goal /name args` expands the template here with the same argument rules as pi.

export interface TemplateCommand {
	name: string;
	description?: string;
	source: string;
	sourceInfo: { path: string };
}

/** Suggests prompt templates while the `/goal` argument is still a bare `/name`. */
export function goalTemplateCompletions(
	argumentPrefix: string,
	commands: readonly TemplateCommand[],
): { value: string; label: string; description?: string }[] | null {
	const match = argumentPrefix.match(/^\/(\S*)$/);
	if (!match) return null;
	const query = (match[1] ?? "").toLowerCase();
	const templates = commands.filter((entry) => entry.source === "prompt" && entry.name.toLowerCase().includes(query));
	const ranked = [
		...templates.filter((entry) => entry.name.toLowerCase().startsWith(query)),
		...templates.filter((entry) => !entry.name.toLowerCase().startsWith(query)),
	];
	const items = ranked.map((entry) => ({
		value: `/${entry.name} `,
		label: entry.name,
		...(entry.description && { description: entry.description }),
	}));
	return items.length > 0 ? items : null;
}

export function parseTemplateArgs(text: string): string[] {
	const args: string[] = [];
	let current = "";
	let hasToken = false;
	let quote: string | null = null;
	for (const char of text) {
		if (quote) {
			if (char === quote) quote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			hasToken = true;
		} else if (/\s/.test(char)) {
			if (hasToken) args.push(current);
			current = "";
			hasToken = false;
		} else {
			current += char;
			hasToken = true;
		}
	}
	if (hasToken) args.push(current);
	return args;
}

export function substituteTemplateArgs(content: string, args: string[]): string {
	const all = args.join(" ");
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
			if (defaultTarget) {
				const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? all : args[Number(defaultTarget) - 1];
				return value ? value : defaultValue;
			}
			if (sliceStart) {
				const start = Math.max(Number(sliceStart) - 1, 0);
				return (sliceLength ? args.slice(start, start + Number(sliceLength)) : args.slice(start)).join(" ");
			}
			if (simple === "ARGUMENTS" || simple === "@") return all;
			return args[Number(simple) - 1] ?? "";
		},
	);
}

export function templateBody(raw: string): string {
	const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	if (!text.startsWith("---")) return text;
	const end = text.indexOf("\n---", 3);
	return end === -1 ? text : text.slice(end + 4).trim();
}

/** Returns the input unchanged unless it starts with `/name` for a loaded prompt template. */
export function expandGoalTemplate(
	input: string,
	commands: readonly TemplateCommand[],
	readFile: (path: string) => string,
): { condition: string; template?: string } {
	const match = input.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
	if (!match) return { condition: input };
	const command = commands.find((entry) => entry.source === "prompt" && entry.name === match[1]);
	if (!command) return { condition: input };
	const body = templateBody(readFile(command.sourceInfo.path));
	return { condition: substituteTemplateArgs(body, parseTemplateArgs(match[2] ?? "")).trim(), template: command.name };
}
