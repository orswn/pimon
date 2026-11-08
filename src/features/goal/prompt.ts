export const GOAL_PROMPT = `## Autonomous goals

- An autonomous goal starts when an \`<active-goal>\` block states its completion condition.
- The active goal condition authorizes unattended work until achieved, paused, cleared, blocked, or replaced by the human.
- Outside an active goal, do not call \`goal_done\`. Ordinary run boundaries apply.
- During an active goal, a run that ends with no armed \`timer\` gets a continuation at once. To wait for external work, start it, then set a \`timer\` for when it should be done.
- When a timer fires, inspect the work it was set for. Do not use timers as a polling interval.
- Give \`goal_done\` concrete evidence that the completion condition holds.
- Do not use \`goal_done\` to ask whether work is complete. The independent check may reject an unsupported claim.
`;
