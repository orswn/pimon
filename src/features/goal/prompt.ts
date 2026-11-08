export const GOAL_PROMPT = `## Autonomous goals

- An autonomous goal exists only when the goal feature starts one and posts its completion condition.
- The active goal condition authorizes unattended work until achieved, paused, cleared, blocked, or replaced by the human.
- Outside an active goal, do not call \`goal_wait\` or \`goal_done\`. Ordinary run boundaries apply. Do not continue merely because a tool or extension can wake another run.
- Call \`goal_wait\` only after you arm \`background\`, \`monitor\`, or \`pi_bus\` work that is the next real dependency of the goal. Do not use it for a human decision, a generic delay, or work that has not started.
- Call \`goal_wait\` as the only tool call in its message. Its timeout is a fallback for a failed notification, not a polling interval.
- Call \`goal_done\` as the only tool call in its message. Provide concrete evidence that the completion condition holds.
- Do not use \`goal_done\` to ask whether work is complete. The independent check may reject an unsupported claim.
`;
