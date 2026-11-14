import {
	type Engine,
	HubError,
	type TaskChange,
	type WireArtifact,
	type WireMessage,
	type WirePart,
	messageText,
} from "./engine.ts";

export interface BuiltinAgent {
	id: string;
	name: string;
	description: string;
	/** A direct Message answer. When it returns a message, no task is made. */
	reply?(message: WireMessage, contextId: string): WireMessage | undefined;
	/** Runs after a task was created or got a follow-up. It drives the task through the engine. */
	start(engine: Engine, taskId: string, message: WireMessage): void;
}

type Step =
	| { do: "working" }
	| { do: "input" }
	| { do: "done"; text?: string }
	| { do: "reject" }
	| { do: "wait"; ms: number }
	| { do: "artifact"; part: WirePart; append?: boolean; lastChunk?: boolean };

const STREAM_TIMEOUT_MS = 2000;

const text = (value: string): WirePart => ({ text: value });
const file: WirePart = { raw: Buffer.from("tck").toString("base64"), filename: "output.txt", mediaType: "text/plain" };
const fileUrl: WirePart = { url: "https://example.com/output.txt", filename: "output.txt", mediaType: "text/plain" };
const lifecycle = (part: WirePart): Step[] => [{ do: "working" }, { do: "artifact", part }, { do: "done" }];

/** The a2a-tck scenario table (scenarios/*.feature), by messageId prefix. Longer prefixes come first. */
const TCK_TABLE: [string, Step[]][] = [
	[
		"tck-stream-artifact-chunked",
		[
			{ do: "working" },
			{ do: "artifact", part: text("chunk-1 "), append: true, lastChunk: false },
			{ do: "artifact", part: text("chunk-2"), append: true, lastChunk: true },
			{ do: "done" },
		],
	],
	["tck-stream-artifact-text", lifecycle(text("Streamed text content"))],
	["tck-stream-artifact-file", lifecycle(file)],
	["test-resubscribe-message-id", [{ do: "working" }, { do: "wait", ms: 2 * STREAM_TIMEOUT_MS }, { do: "done" }]],
	["tck-stream-ordering-001", lifecycle(text("Ordered output"))],
	["tck-artifact-file-url", [{ do: "artifact", part: fileUrl }, { do: "done" }]],
	["tck-input-required", [{ do: "input" }]],
	["tck-complete-task", [{ do: "done", text: "Hello from TCK" }]],
	["tck-artifact-text", [{ do: "artifact", part: text("Generated text content") }, { do: "done" }]],
	["tck-artifact-file", [{ do: "artifact", part: file }, { do: "done" }]],
	["tck-artifact-data", [{ do: "artifact", part: { data: { key: "value", count: 42 } } }, { do: "done" }]],
	["tck-reject-task", [{ do: "reject" }]],
	["tck-stream-001", lifecycle(text("Stream hello from TCK"))],
	["tck-stream-002", [{ do: "done" }]],
	["tck-stream-003", lifecycle(text("Stream task lifecycle"))],
];

export function tckSteps(messageId: string): Step[] {
	const hit = TCK_TABLE.find(([prefix]) => messageId.startsWith(prefix));
	return hit ? hit[1] : [{ do: "done", text: `Unhandled messageId prefix: ${messageId}` }];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function runSteps(engine: Engine, taskId: string, steps: Step[]): Promise<void> {
	const artifactId = engine.newId();
	for (const step of steps) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		let change: TaskChange;
		switch (step.do) {
			case "wait":
				await sleep(step.ms);
				continue;
			case "working":
				change = { state: "TASK_STATE_WORKING" };
				break;
			case "input":
				change = { state: "TASK_STATE_INPUT_REQUIRED", message: engine.agentMessage("need input") };
				break;
			case "done":
				change = { state: "TASK_STATE_COMPLETED" };
				if (step.text) change.message = engine.agentMessage(step.text);
				break;
			case "reject":
				change = { state: "TASK_STATE_REJECTED", message: engine.agentMessage("rejected") };
				break;
			case "artifact": {
				const artifact: WireArtifact = { artifactId, name: "tck", parts: [step.part] };
				const item: NonNullable<TaskChange["artifacts"]>[number] = { artifact };
				if (step.append !== undefined) item.append = step.append;
				if (step.lastChunk !== undefined) item.lastChunk = step.lastChunk;
				change = { artifacts: [item] };
				break;
			}
		}
		try {
			engine.applyChange(taskId, change);
		} catch (error) {
			// A canceled task ends the scenario.
			if (error instanceof HubError && (error.reason === "task-terminal" || error.reason === "task-not-found")) return;
			throw error;
		}
	}
}

function report(error: unknown): void {
	process.stderr.write(`test agent failed: ${error instanceof Error ? error.message : String(error)}\n`);
}

export const tckAgent: BuiltinAgent = {
	id: "tck",
	name: "tck",
	description: "Built-in A2A TCK scenario agent. It acts on the messageId prefix.",
	reply(message, contextId) {
		if (!message.messageId.startsWith("tck-message-response")) return undefined;
		return { messageId: crypto.randomUUID(), contextId, role: "ROLE_AGENT", parts: [text("Direct message response")] };
	},
	start(engine, taskId, message) {
		runSteps(engine, taskId, tckSteps(message.messageId)).catch(report);
	},
};

export const echoAgent: BuiltinAgent = {
	id: "echo",
	name: "echo",
	description: "Built-in echo agent. It completes each task at once with an artifact that echoes the text.",
	start(engine, taskId, message) {
		setImmediate(() => {
			const body = messageText(message);
			try {
				engine.applyChange(taskId, {
					state: "TASK_STATE_COMPLETED",
					message: engine.agentMessage(body),
					artifacts: [{ artifact: { artifactId: engine.newId(), name: "echo", parts: [text(body)] } }],
				});
			} catch (error) {
				if (!(error instanceof HubError && error.reason === "task-terminal")) report(error);
			}
		});
	},
};

export const BUILTIN_AGENTS: readonly BuiltinAgent[] = [tckAgent, echoAgent];

export function installBuiltins(engine: Engine): Map<string, BuiltinAgent> {
	const map = new Map<string, BuiltinAgent>();
	for (const agent of BUILTIN_AGENTS) {
		engine.ensureBuiltin(agent.id, agent.name);
		map.set(agent.id, agent);
	}
	return map;
}
