import { defineFeature } from "../../src/core/feature.ts";
import { bus, type BusService } from "../../src/features/bus/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";
import { writeHubConfig } from "./hub.ts";

/** Holds the bus service of the last harness that loaded `feature`. */
export function busCapture() {
	let service: BusService | undefined;
	const feature = defineFeature({
		id: "bus-capture",
		description: "test feature that captures the bus service",
		defaultEnabled: true,
		dependsOn: ["bus"],
		setup(ctx) {
			service = ctx.service("bus");
		},
	});
	return {
		feature,
		get(): BusService {
			if (!service) throw new Error("no bus service");
			return service;
		},
		peek: () => service,
		reset() {
			service = undefined;
		},
	};
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** A harness whose bus links to `url`. Resolves once the link is online. */
export async function busHarness(
	url: string,
	capture: ReturnType<typeof busCapture>,
	options: Partial<HarnessOptions> & { token?: string; config?: Record<string, unknown> } = {},
): Promise<Harness> {
	const { token, config, setupAgentDir, ...rest } = options;
	const harness = await createHarness({
		features: [bus, capture.feature],
		...rest,
		setupAgentDir: (agentDir) => {
			setupAgentDir?.(agentDir);
			writeHubConfig(agentDir, url, { ...(token ? { token } : {}), ...(config ? { features: config } : {}) });
		},
	});
	await until(() => capture.peek()?.online === true);
	return harness;
}

export function customMessages(harness: Harness, customType: string) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && (message as { customType?: string }).customType === customType,
	) as { content: unknown; details?: Record<string, unknown> }[];
}

export function toolTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map((message) =>
			((message as { content: { type: string; text?: string }[] }).content ?? [])
				.map((part) => part.text ?? "")
				.join(""),
		);
}

export const hex = (id: string) => id.replace(/-/g, "").slice(0, 12);
