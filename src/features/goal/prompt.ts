export const GOAL_PROMPT = `## Autonomous goals

- An autonomous goal exists only when the goal feature starts one and posts its completion condition.
- The active goal condition authorizes unattended work until achieved, paused, cleared, blocked, or replaced by the human.
- Outside an active goal, do not call \`goal_done\`. Ordinary run boundaries apply. Do not continue merely because a tool or extension can wake another run.
- During an active goal, a run ends only while a \`timer\` is armed. To wait for external work, arm it first, then set a timer for when it should be done.
- When a timer fires, inspect the work it was set for. Do not use timers as a polling interval.
- Call \`goal_done\` as the only tool call in its message. Provide concrete evidence that the completion condition holds.
- Do not use \`goal_done\` to ask whether work is complete. The independent check may reject an unsupported claim.
`;
