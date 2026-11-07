import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxProvider, type Message } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AnyFeature } from "../../src/core/feature.ts";
import { createPimon, type PimonRuntime } from "../../src/core/runtime.ts";

export interface Harness {
	session: AgentSession;
	runtime: PimonRuntime;
	agentDir: string;
	cwd: string;
	requests: Message[][];
	extensionErrors: string[];
	respond(steps: FauxResponseStep[]): void;
	/** Resolves once the model has received at least `count` requests, then waits for the session to go idle. */
	waitForRequests(count: number, timeoutMs?: number): Promise<void>;
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
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "pimon-test-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "work");
	for (const dir of [agentDir, cwd]) mkdirSync(dir);
	options.setupAgentDir?.(agentDir);

	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
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
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
	});
	const extensionErrors: string[] = [];
	await session.bindExtensions(
		options.hostBindings === false
			? {}
			: { onError: (error) => extensionErrors.push(`${error.extensionPath} ${error.event}: ${error.error}`) },
	);
	if (!runtime) throw new Error("pimon factory did not run");

	const requests: Message[][] = [];
	return {
		session,
		runtime,
		agentDir,
		cwd,
		requests,
		extensionErrors,
		respond(steps) {
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
		},
		async waitForRequests(count, timeoutMs = 10_000) {
			const deadline = Date.now() + timeoutMs;
			while (requests.length < count) {
				if (Date.now() > deadline)
					throw new Error(`expected ${count} model request(s), saw ${requests.length} after ${timeoutMs}ms`);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			await session.waitForIdle();
		},
		dispose() {
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
