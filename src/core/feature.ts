import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Static, TObject } from "typebox";
import type { PimonEventBus } from "./events.ts";
import type { ServiceMap } from "./services.ts";

export type FeatureId = string;

export interface PromptInput {
	cwd: string;
	enabledFeatures: ReadonlySet<FeatureId>;
}

export interface PromptSection {
	/** Tag name of the section. Lower case letters, digits, `_` and `-`. */
	name: string;
	/** Render only when one of these tools is active at the first render. Later tool changes do not re-render. */
	requiresTools?: readonly string[];
	/** Must return the same text for the same input. Called once per session start. */
	render(input: PromptInput): string | undefined;
}

export type SessionStartHandler = (event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>;
export type SessionShutdownHandler = (event: SessionShutdownEvent, ctx: ExtensionContext) => void | Promise<void>;

export interface FeatureLog {
	warn(message: string): void;
	error(message: string, cause?: unknown): void;
}

export interface WakeMessage {
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display?: boolean;
	details?: unknown;
}

export interface FeatureContext<Config> {
	readonly id: FeatureId;
	readonly pi: ExtensionAPI;
	readonly config: Config;
	readonly agentDir: string;
	readonly events: PimonEventBus;
	readonly log: FeatureLog;
	/** Throws when the service's feature is disabled or failed. List the feature in `dependsOn`. */
	service<K extends keyof ServiceMap>(id: K): ServiceMap[K];
	/** State that survives `/reload` and session replacement in the same process. A version change discards it. */
	reloadState<T>(key: string, version: number, create: () => T): T;
	promptSection(section: PromptSection): void;
	/** Sends a message that starts or steers a model run, held while a compaction or tree summary runs. */
	wake(message: WakeMessage): void;
	/** Changes every wake from any feature just before it is sent. Filters run in registration order. */
	wakeFilter(filter: (message: WakeMessage) => WakeMessage): void;
	onSessionStart(handler: SessionStartHandler): void;
	onSessionShutdown(handler: SessionShutdownHandler): void;
}

export interface Feature<Schema extends TObject = TObject, Service = unknown> {
	id: FeatureId;
	description: string;
	dependsOn?: readonly FeatureId[];
	defaultEnabled: boolean;
	configSchema?: Schema;
	/** Runs inside the extension factory. Register tools, commands, and hooks. Start no processes, sockets, or timers here. */
	setup(ctx: FeatureContext<Static<Schema>>): Service;
}

export type AnyFeature = Feature<TObject, unknown>;

export function defineFeature<Schema extends TObject, Service>(
	feature: Feature<Schema, Service>,
): Feature<Schema, Service> {
	return feature;
}
