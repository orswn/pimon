# pimon

A pi package that holds one set of extensions as features of one extension.

## Install

```bash
pi install git:git@github.com:orswn/pimon@v1.0.0
```

- The repo is private. The clone needs SSH access to `github.com:orswn/pimon`.
- pimon needs Node 24 or newer.
- To update, set a new ref in the `packages` entry of `settings.json`. Then run `pi update --extensions`.

## Configure

Optional file: `~/.pi/agent/pimon.json`.

```json
{
	"features": {
		"vi": false,
		"background": { "enabled": true }
	},
	"tools": {
		"background_codemode": false
	}
}
```

- `true` or `false` turns a feature on or off.
- An object can set `enabled` and the feature's options.
- An invalid or unknown option shows an error and turns that feature off.
- An unknown feature shows a warning.
- `tools` turns single pimon tools off. `"<tool>": false` keeps that tool out of every request.
  - A missing entry or `true` keeps the tool on.
  - A prompt section that needs only tools that are off is left out.
  - A value that is not `true` or `false` shows an error.
  - A name that no enabled feature registers shows a warning.
  - A tool that is off but needed shows a warning: `pi_agents` needs `pi_bus`, `goal_done` needs `timer` and `notify`, the `goal` feature needs `goal_done`, and each codemode job tool needs its shell tool.
- A feature is off when a feature in its `Needs` list is off.
- Run `/pimon` to see feature status, prompt sections, and diagnostics.

## Features

All features are on by default. The list is in load order.

### `harness`

- Purpose: core operating rules for the model in the system prompt.
- Options: none.

### `image-budget`

- Purpose: replaces old tool-result images with placeholders before a request passes the provider size limit.
- Options:
  - `triggerBytes`: integer, default `28000000`, minimum `1`. Request size that starts the replacement.
  - `targetBytes`: integer, default `20000000`, minimum `1`. Size to reach. Must be below `triggerBytes`.
  - `keepRecentImages`: integer, default `8`, minimum `0`. Newest images that stay.

### `background`

- Purpose: background jobs that wake the model on exit, monitors that wake it on a matching line, and timers.
- Options:
  - `maxScriptJobs`: integer, default `4`, from `1` to `16`. Codemode script jobs that can run at one time.
  - `inlineWaitMs`: integer, default `5000`, from `0` to `30000`. A `background` start waits this long for the job to exit. A job that exits in time returns its exit digest at once and sends no wake. `0` turns the wait off.
- Tools: `background`, `monitor`, `timer`, `background_codemode`, `monitor_codemode`.
- Commands: `/background`, `/monitor`, `/timers`.
- External commands: the job commands, through `/bin/sh`.

### `notify`

- Purpose: desktop and phone notifications when the human must act.
- Options: none.
- Tools: `notify`.
- External commands: `notify-send`, `kdeconnect-cli`.

### `goal`

- Purpose: autonomous goals that end only after an independent check.
- Needs: `notify`, `background`.
- Options: none.
- Tools: `goal_done`.
- Commands: `/goal`, `/goal-check`.
- External commands: the goal check command, through `bash -c`.

### `ask-secret`

- Purpose: gets secrets from the human into commands. The model and the session file do not see them.
- Options: none.
- External commands: `notify-send`.

### `compaction`

- Purpose: warns about models that compact later than a token limit. Prints settings overrides for them.
- Options:
  - `maxThresholdTokens`: integer, default `256000`, minimum `1`.
- Commands: `/compaction-overrides`.

### `ancestor-config`

- Purpose: loads skills, prompts, and MCP servers from directories above the repo, below `$HOME`.
- It works only for a trusted project in `$HOME`.
- Options: none.

### `discovery`

- Purpose: lists the models of providers that have `dynamicDiscovery` in `models.json`. It reads their models endpoint.
- Options: none in `pimon.json`.
- `models.json` provider key `dynamicDiscovery`: `true` or `{ endpoint, path, timeoutMs }`.
  - Defaults: `path` `/models`, `timeoutMs` `5000`.
  - `endpoint` is a full URL. It replaces `baseUrl` and `path`.

### `bus`

- Purpose: messages between pi instances on this host. Gives digests and presence.
- Options:
  - `historyRetentionDays`: integer, default `30`, minimum `0`. Deletes older message history files. `0` keeps all.
- Tools: `pi_bus`.
- Commands: `/bus`, `/bus-peers`, `/bus-inbox`, `/bus-send`, `/bus-probe`, `/bus-pending`, `/bus-doctor`.

### `agents`

- Purpose: starts visible child pi instances in Herdr panes, with roles and a lifecycle.
- Needs: `bus`.
- Options: none.
- Tools: `pi_agents`.
- Commands: `/agents`, `/agents-roles`, `/agents-where`, `/agents-close`, `/agents-kill`, `/agents-focus`, `/agents-prune`.
- External commands: `herdr`. It starts `pi` in a Herdr pane.
- Role files: `~/.pi/agent/agents/<name>.md`. With the `pi_agents` parameter `projectRoles: true`, also `.pi/agents/<name>.md` in the cwd or a parent dir.
  - Frontmatter keys: `name`, `description`, `tools`, `model`, `thinking`, `labels`, `mcp`.

### `statusline`

- Purpose: footer status line and working indicator.
- The context segment shows tokens against the compaction threshold: `contextWindow - reserveTokens`, with the per-model override first.
  - With compaction off, it shows tokens against the model context window.
  - With a reserve at or above the window, it shows tokens only. pi then compacts at every check.
  - A settings change shows from the next run.
- Options:
  - `usage`: boolean, default `true`. Shows provider usage for `anthropic` and `openai-codex`. It calls their usage endpoints.
  - `usagePollSeconds`: integer, default `60`, from `30` to `3600`.
  - `gitStatus`: boolean, default `true`.
- External commands: `git`.

### `vi`

- Purpose: modal vi editor for the prompt. It replaces the default editor. Set `"vi": false` to keep the default editor.
- Options:
  - `clipboard`: `"yank"` or `"never"`, default `"yank"`. `"yank"` copies yanked text to the system clipboard.
  - `cursorShape`: boolean, default `true`. Changes the terminal cursor shape for each mode.
- External commands: only with `clipboard: "yank"`. Through pi, one of `wl-copy`, `xclip`, `xsel`, `pbcopy`, or `termux-clipboard-set`. pi also writes OSC 52.

## Environment

Names that pimon reads:

- `PI_BACKGROUND_DIR`: state dir for background leases. Default: `<agentDir>/background`.
- `PI_BUS_DIR`: bus dir. Default: `<agentDir>/bus`.
- `PI_BUS_NAME`: bus name of this instance.
- `PI_BUS_ROLE`: `role` label.
- `PI_BUS_PARENT`: `parent` label.
- `PI_BUS_TEAM`: `team` label.
- `PI_BUS_LABELS`: more labels, as `key=value,key=value`.
- `PI_BUS_OWNER`: owner id of this instance.
- `PI_BUS_WAKE_POLICY`: `all`, `parent`, or `none`. Default `all`.
- `PI_BUS_CONTROL`: who can send control requests: `parent`, `any`, or `none`. Default `parent`.
- `PI_BUS_CONTROL_TOKEN`: token that control requests must carry.
- `PI_BUS_DEBUG`: `1` writes bus debug lines to stderr.
- `PIMON_SPAWN_FILE`: spawn file of a child that `agents` started.
- `PI_CODING_AGENT_DIR`: `agents` gives it to a child.
- `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`: `agents` uses them to place children.
- `SHELL`: `agents` uses it to find an idle pane.
- `PI_ASK_SECRET_REASON`: `pi-ask-secret` shows it to the human. The caller sets it.
- `XDG_RUNTIME_DIR`: base dir for the `ask-secret` socket and the usage cache. Default `/tmp`.
- `TMPDIR`: base dir for the temporary files below.

Names that pimon sets:

- `PI_ASK_SECRET_SOCK`: socket of the `ask-secret` prompt.
- `SUDO_ASKPASS`: the `pi-ask-secret` client.
- `PI_SECRET_<NAME>`: a secret that the human gave.
- `PIMON_SPAWN_FILE`, `PI_BUS_DIR`, `PI_CODING_AGENT_DIR`: `agents` sets them in a child pane.

At start, pimon removes these names from its own env. Commands and child processes do not inherit them:

- `PI_BUS_OWNER`, `PI_BUS_NAME`, `PI_BUS_LABELS`, `PI_BUS_ROLE`, `PI_BUS_PARENT`, `PI_BUS_TEAM`, `PI_BUS_CONTROL_TOKEN`.
- `PI_AGENT_LABEL`, `PI_AGENTS_TOOLS`, `PIMON_SPAWN_FILE`.

Background jobs also do not inherit the other `PI_BUS_*` names, except `PI_BUS_DIR`.

## Files

pimon writes these paths:

- `<agentDir>/bus/`: presence, sockets, and message history.
- `$TMPDIR/pi-bus-<uid>/`: bus sockets when the socket path is too long.
- `<agentDir>/background/leases/`: crash-recovery leases. With `PI_BACKGROUND_DIR`: `$PI_BACKGROUND_DIR/leases/`.
- `$TMPDIR/pi-background-logs/`: job logs without a `logFile`.
- `$TMPDIR/pi-agents-<uid>/`: child records, spawn files, prompts, and session roles.
- `$XDG_RUNTIME_DIR/pi-ask-secret/<pid>.sock`: `ask-secret` socket.
- `$XDG_RUNTIME_DIR/pimon-<uid>/statusline/`: provider usage cache.
- `ask-secret` rewrites pi tool output files that contain a secret.
- `agents` with `context: fork` writes a child session file next to the parent session.

## Stability

From 1.0.0, SemVer covers these surfaces:

- Tool names and parameters.
- `pimon.json` features, options, and `tools`.
- `dynamicDiscovery` in `models.json`.
- Commands.
- Environment names that pimon reads or sets, except `PI_BUS_DEBUG`. Names that other programs own are not covered.
- Role file frontmatter.
- The bus wire protocol, `BUS_PROTOCOL = 1`.
- The versioned records: presence, lease, spawn file, agent record, usage cache, and history lines. Log files are not covered.

Prompt text and tool descriptions can change in a minor version.

Interop with the standalone bus and agents extensions is temporary. SemVer does not cover it. `PI_AGENTS_TOOLS` and `PI_AGENT_LABEL` are for this interop only.
