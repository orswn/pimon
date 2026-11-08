export const GOAL_PROMPT = `## Autonomous goals

- An autonomous goal is active when an \`<active-goal>\` block states its objective.
- The objective authorizes unattended work until it is done, paused, cleared, blocked, or replaced by the human.
- Outside an active goal, do not call \`goal_done\`. Ordinary run boundaries apply.
- During an active goal, a run that ends with no armed \`timer\` gets a continuation at once. To wait for external work, start it, then set a \`timer\` for when it should be done.
- When a timer fires, inspect the work it was set for. Do not use timers as a polling interval.
- Call \`goal_done\` only when the objective holds now and tool results of this goal show it. A plan, partial work, or a skipped check is not done.
`;
