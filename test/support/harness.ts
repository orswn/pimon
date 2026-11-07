import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxProvider, type Message } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
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
	dispose(): void;
}

export interface HarnessOptions {
	features: readonly AnyFeature[];
	appendSystemPrompt?: string[];
	setupAgentDir?: (agentDir: string) => void;
	/** Bind like an interactive or RPC host. Without bindings pi skips session_start on reload. Default true. */
	hostBindings?: boolean;
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
		dispose() {
			session.dispose();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
