export const BACKGROUND_PROMPT = `## Background jobs and monitors

- Use \`background\` for a long command whose completion matters. Use \`monitor\` instead when a matching line matters before process exit. Choose one owner when launching the command.
- A \`background\` job wakes on exit. Inspect its bounded digest first. Use its \`logs\` or \`status\` action when more evidence is needed. Never rerun the command merely to recover output.
- A \`monitor\` owns the command it watches. Arm it with the specific line that changes what should happen next. Broad matches are not progress tracking.
- Background and monitor notifications report process facts. Reconcile them with the current objective before acting.
- Use \`timer\` to come back later.
`;
