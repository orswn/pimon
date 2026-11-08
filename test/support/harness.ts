import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxModelDefinition,
	type FauxResponseStep,
	fauxProvider,
	type Message,
	type ModelsStore,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	type ExtensionContext,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AnyFeature } from "../../src/core/feature.ts";
import { createPimon, type PimonRuntime } from "../../src/core/runtime.ts";

type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;
type ExtensionMode = ExtensionContext["mode"];

export interface Harness {
	session: AgentSession;
	runtime: PimonRuntime;
	modelRuntime: ModelRuntime;
	agentDir: string;
	cwd: string;
	requests: Message[][];
	extensionErrors: string[];
	notifications: { message: string; level: string | undefined }[];
	/** Notices shown through the UI context. Empty without `ui`. */
	uiNotices: string[];
	respond(steps: FauxResponseStep[]): void;
	/** Resolves once the model has received at least `count` requests, then waits for the session to go idle. */
	waitForRequests(count: number, timeoutMs?: number): Promise<void>;
	/** Emit session_shutdown like a quitting host. */
	shutdown(): Promise<void>;
	dispose(): void;
}

export interface HarnessOptions {
	features: readonly AnyFeature[];
	appendSystemPrompt?: string[];
	setupAgentDir?: (agentDir: string) => void;
	/** Bind like an interactive or RPC host. Without bindings pi skips session_start on reload. Default true. */
	hostBindings?: boolean;
	/** Extensions that load after pimon. */
	extensions?: ExtensionFactory[];
	mode?: ExtensionMode;
	/** Merged over the default in-memory settings, one level deep. */
	settings?: Partial<Settings>;
	fauxModels?: FauxModelDefinition[];
	modelsStore?: ModelsStore;
	/** Bind a UI that records notifications. Given methods replace the recording no-ops. */
	ui?: Partial<ExtensionUIContext>;
	/** Set before the extensions bind, for a run that starts at session start. */
	responses?: FauxResponseStep[];
	/** Defaults to an empty in-memory session. */
	sessionManager?: (cwd: string) => SessionManager;
}

const DEFAULT_SETTINGS: Partial<Settings> = { compaction: { enabled: false }, retry: { enabled: false } };

function mergeSettings(overrides: Partial<Settings> = {}): Partial<Settings> {
	const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
	for (const [key, value] of Object.entries(overrides)) {
		const base = merged[key];
		const bothObjects = isPlainObject(base) && isPlainObject(value);
		merged[key] = bothObjects ? { ...base, ...value } : value;
	}
	return merged as Partial<Settings>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordingUI(
	notifications: Harness["notifications"],
	uiNotices: string[],
	overrides: Partial<ExtensionUIContext>,
): ExtensionUIContext {
	const base: Partial<ExtensionUIContext> = {
		notify: (message, level) => {
			notifications.push({ message, level });
			uiNotices.push(message);
		},
		onTerminalInput: () => () => {},
		custom: async () => undefined as never,
		getEditorText: () => "",
		...overrides,
	};
	return new Proxy(base, {
		get: (target, key) => {
			if (key in target) return target[key as keyof typeof target];
			// `then` is probed when the context is awaited; it must stay absent.
			if (typeof key !== "string" || key === "then") return undefined;
			return () => {
				throw new Error(`harness UI has no ${key}(); pass it in createHarness({ ui })`);
			};
		},
	}) as ExtensionUIContext;
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pimon-test-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	for (const dir of [agentDir, cwd]) mkdirSync(dir);
	options.setupAgentDir?.(agentDir);

	const faux = fauxProvider(options.fauxModels ? { models: options.fauxModels } : undefined);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		...(options.modelsStore ? { modelsStore: options.modelsStore } : {}),
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);

	let runtime: PimonRuntime | undefined;
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		appendSystemPrompt: options.appendSystemPrompt ?? [],
		extensionFactories: [
			{
				name: "pimon",
				factory: createPimon(options.features, {
					agentDir,
					onRuntime: (created) => {
						runtime = created;
					},
				}),
			},
			...(options.extensions ?? []).map((factory, index) => ({ name: `test-extension-${index}`, factory })),
		],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model: faux.getModel(),
		thinkingLevel: "off",
		resourceLoader,
		sessionManager: options.sessionManager?.(cwd) ?? SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory(mergeSettings(options.settings)),
	});
	const requests: Message[][] = [];
	const respond = (steps: FauxResponseStep[]) => {
		faux.setResponses(
			steps.map((step) =>
				typeof step === "function"
					? (context, streamOptions, state, model) => {
							requests.push(structuredClone(context.messages));
							return step(context, streamOptions, state, model);
						}
					: (context) => {
							requests.push(structuredClone(context.messages));
							return step;
						},
			),
		);
	};
	if (options.responses) respond(options.responses);
	const extensionErrors: string[] = [];
	const notifications: Harness["notifications"] = [];
	const uiNotices: string[] = [];
	await session.bindExtensions({
		...(options.hostBindings === false
			? {}
			: {
					onError: (error) => extensionErrors.push(`${error.extensionPath} ${error.event}: ${error.error}`),
					commandContextActions: {
						waitForIdle: () => session.waitForIdle(),
						newSession: async () => ({ cancelled: true }),
						fork: async () => ({ cancelled: true }),
						navigateTree: async () => ({ cancelled: true }),
						switchSession: async () => ({ cancelled: true }),
						reload: async () => await session.reload(),
					},
				}),
		...(options.mode ? { mode: options.mode } : {}),
		...(options.ui ? { uiContext: recordingUI(notifications, uiNotices, options.ui) } : {}),
	});
	if (!runtime) throw new Error("pimon factory did not run");

	return {
		session,
		runtime,
		modelRuntime,
		agentDir,
		cwd,
		requests,
		extensionErrors,
		notifications,
		uiNotices,
		respond,
		async waitForRequests(count, timeoutMs = 10_000) {
			const deadline = Date.now() + timeoutMs;
			while (requests.length < count) {
				if (Date.now() > deadline)
					throw new Error(`expected ${count} model request(s), saw ${requests.length} after ${timeoutMs}ms`);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			await session.waitForIdle();
		},
		async shutdown() {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		},
		dispose() {
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
