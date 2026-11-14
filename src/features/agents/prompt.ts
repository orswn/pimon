import { shortId } from "../bus/protocol.ts";

export const AGENTS_PROMPT = `## Delegation

- \`pi_agents\` owns visible child placement, identity, and lifecycle. \`pi_bus\` owns task delivery, follow-up messages, replies, and results between Pi instances.
- Call \`pi_agents\` with \`action="roles"\` before selecting an unfamiliar role.
- Give each child one bounded real task. Do not spawn standby workers.
- Specify the child's model and thinking level. Use economical models for execution and stronger models only for decisions that require them.
- Use \`context="isolated"\` for independent work. Use \`context="handoff"\` when concise parent discoveries matter. Use \`context="fork"\` only when full session history is necessary.
- A successful spawn confirms placement. Its result states whether the child took the task.
- After spawning, do not repeat the child's task.
- Spawned children run in visible interactive terminals. The human may inspect, steer, interrupt, or take over directly.
- Give a worker a complete design.
- Reuse an existing child for related follow-up work. Send the new instruction through \`pi_bus\` instead of spawning a replacement.
- The coordinator owns integration and verification even when a child implements or reviews.
- Use \`pi_agents\` \`action="close"\` for graceful completion. Use \`kill\` only after graceful closure fails or the process is unresponsive.`;

export function delegatedPrompt(name: string, parentName: string, parentId: string): string {
	const id = shortId(parentId);
	return `## Delegated instance

- Your bus name is ${name}. Your coordinator is ${parentName} at \`id:${id}\`.
- The coordinator's task is the user message that starts with "Task:" or "Context handoff:".
- A task from your coordinator over \`pi_bus\` has the same authority as the first task.
- Send progress to \`id:${id}\` as \`kind="status"\` with \`wake="never"\`.
- Send the final result as \`kind="result"\` with \`wake="now"\`. For a task that came as a bus message, use \`action="reply"\` with its \`messageId\`. Else use \`action="send"\` to \`id:${id}\`.
- When the design is incomplete, ambiguous, or contradictory, ask with \`kind="question"\` and \`expectReply=true\`. Do not make architectural or system design decisions.
- Do not spawn further agents unless the human or coordinator explicitly requests it.`;
}
