export const BACKGROUND_PROMPT = `## Background jobs and monitors

- Run a command that ends within about one minute with \`bash\`. Use \`background\` for a longer command, or when independent work can continue while it runs. Use \`monitor\` instead when a matching line matters before process exit. Choose one owner when launching the command.
- A \`background\` job wakes on exit. Inspect its bounded digest first. Use its \`logs\` or \`status\` action when more evidence is needed. Never rerun the command merely to recover output.
- A \`monitor\` owns the command it watches. Arm it with the specific line that changes what should happen next. Broad matches are not progress tracking.
- Background and monitor notifications report process facts. Reconcile them with the current objective before acting.
`;

export const TIMER_PROMPT = "- Use `timer` to come back later.";

export const SCRIPTS_PROMPT =
	"- Use `background_codemode` or `monitor_codemode` for async work that needs pi or MCP tools. Use shell jobs only for shell commands.";
