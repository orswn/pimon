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
  - A tool that is off but needed shows a warning: `pi_agents` needs `pi_bus`, `goal_done` needs `timer` and `notify`, `goal_set` needs `goal_done`, the `goal` feature needs `goal_done`, and each codemode job tool needs its shell tool.
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

- Purpose: autonomous goals that the human or the model sets. The model marks a goal done.
- Needs: `notify`, `background`.
- Options: none.
- Tools: `goal_done`, `goal_set`.
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

- Purpose: messages between pi sessions through a `pimon-hub` (see [Hub](#hub)), on one host or several. Gives digests, presence, and a one-line status per session.
- The bus address of a session is its session id: `id:<12 hex>`. It stays the same across reloads and restarts.
- Messages to an offline session wait in its hub mailbox. A send result says `delivered`, `queued`, `unconfirmed`, or `failed` per recipient.
- Options:
  - `hub.url`: string, no default. The hub base URL, such as `https://hub.example`. Without it, the bus does no network work and `pi_bus` actions other than `whoami` return an error.
  - `hub.tokenFile`: string, default `<agentDir>/pimon-hub.token`. The file holds the bearer token of a `host` principal. The file must be readable only by its owner, for example mode `0600`. The bus refuses any other file.
  - `historyRetentionDays`: accepted and ignored. The hub owns retention.
- Example: `{ "features": { "bus": { "hub": { "url": "https://hub.example" } } } }`.
- Tools: `pi_bus`.
- Commands: `/bus`, `/bus-peers`, `/bus-inbox`, `/bus-send`, `/bus-status`, `/bus-probe`, `/bus-pending`, `/bus-doctor`.

### `agents`

- Purpose: starts visible child pi instances in Herdr panes, with roles and a lifecycle.
- Needs: `bus`, with a hub. The parent gives the child its session id and sends the first task through the hub.
- Options: none.
- Tools: `pi_agents`.
- Commands: `/agents`, `/agents-roles`, `/agents-where`, `/agents-close`, `/agents-kill`, `/agents-focus`, `/agents-prune`.
- External commands: `herdr`. It starts `pi` in a Herdr pane.
- Role files: `~/.pi/agent/agents/<name>.md`. With the `pi_agents` parameter `projectRoles: true`, also `.pi/agents/<name>.md` in the cwd or a parent dir.
  - Frontmatter keys: `name`, `description`, `tools`, `model`, `thinking`, `labels`, `mcp`.

### `stale`

- Purpose: tells the model about a gap in the session before a run. The model has no clock.
- A run gets one `<session-gap>` message when one of these happened since the last activity:
  - The session was idle for `idleMinutes` or more. Activity is the last user, assistant, or tool result message in the session branch. A stored notice without a run does not count.
  - pi reloaded its extensions. A reload before the first run keeps a pending restart.
  - pi restarted: pi started into a session that has messages, or switched to such a session that this pi process did not run before.
    - A new session and a fork do not count.
    - A switch back to a session that this pi process ran does not count. Its jobs still run.
  - The host was suspended for 60 s or more while this pi process ran.
  - The host restarted before a pi restart.
    - On Linux, the kernel boot id differs from the boot id saved in the session.
    - Elsewhere, or with an old saved entry that has no boot id, the boot time differs by more than 5 s.
- Each event gives one message, at the first run after it. Every run kind gets it: prompts, wakes, and timers.
- The message has the gap, the local time with the UTC offset, and the events.
  - After a pi or host restart, it also says that jobs, monitors, timers, and bus endpoints of the old process are lost.
- A reload alone, under the idle limit, gives no line that asks the model to check facts. A reload keeps jobs, timers, and the session.
- Model-visible text: about 120 chars for a reload alone. About 135 chars for an idle gap. About 280 chars for all lines. Nothing on other runs. No prompt section and no tool.
- The boot time and boot id are saved in a `pimon-stale` session entry at a session start when the session has none, the boot changed, or the boot id is new. The model does not see it.
- Files read: `/proc/sys/kernel/random/boot_id` on Linux.
- Options:
  - `idleMinutes`: integer, default `30`, minimum `1`.

### `statusline`

- Purpose: footer status line and working indicator.
- The context segment shows tokens against the compaction threshold: `contextWindow - reserveTokens`, with the per-model override first.
  - With compaction off, it shows tokens against the model context window.
  - With a reserve at or above the window, it shows tokens only. pi then compacts at every check.
  - A settings change shows from the next run.
- The work counts show on the right, before the model: `A:1 B:2 M:0 T:1`.
  - `A`: children of this pi that are starting or running, from the `agents` feature.
  - `B`, `M`: running background jobs and monitors of this pi process, shell and script, from the `background` feature.
  - `T`: armed timers of the current session, from the `background` feature.
  - A letter shows only when its feature is on. A narrow terminal drops the counts first.
  - In fullscreen mode, a left click on `A`, `B`, `M`, or `T` shows the same list as `/agents`, `/background list`, `/monitor list`, or `/timers`.
- Options:
  - `usage`: boolean, default `true`. Shows provider usage for `anthropic` and `openai-codex`. It calls their usage endpoints.
  - `usagePollSeconds`: integer, default `60`, from `30` to `3600`.
  - `gitStatus`: boolean, default `true`.
  - `workCounts`: boolean, default `true`. Shows the work counts.
- External commands: `git`.

### `vi`

- Purpose: modal vi editor for the prompt. It replaces the default editor. Set `"vi": false` to keep the default editor.
- Options:
  - `clipboard`: `"yank"` or `"never"`, default `"yank"`. `"yank"` copies yanked text to the system clipboard.
  - `cursorShape`: boolean, default `true`. Changes the terminal cursor shape for each mode. It keeps the hardware cursor shown, so pi's `showHardwareCursor` setting has no effect while it is on.
- Esc: in insert mode, Esc goes to normal mode. In normal mode, Esc goes to pi, so it stops a run, and a double Esc runs pi's double-Escape action (`/tree` by default). Esc keys pressed in quick succession after leaving insert mode or a pending command reach pi only once.
- External commands: only with `clipboard: "yank"`. Through pi, one of `wl-copy`, `xclip`, `xsel`, `pbcopy`, or `termux-clipboard-set`. pi also writes OSC 52.

## Hub

`src/hub/` is `pimon-hub`, a message hub for pi sessions on several hosts. It is an A2A 1.0 server (JSON-RPC binding) with its own task store in SQLite. The pi extension does not load it.

Run it with Node 24:

```bash
node src/hub/main.ts --listen 127.0.0.1:8080 --data ./hub-data --tokens ./tokens.json
```

| Flag            | Env                 | Default          | Meaning                                                                                  |
| --------------- | ------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `--listen`      | `HUB_LISTEN`        | `0.0.0.0:8080`   | Bind address. Port `0` picks a free port. The hub prints `listening <port>` when ready.  |
| `--data`        | `HUB_DATA`          | `/data`          | SQLite directory. `:memory:` keeps nothing.                                              |
| `--tokens`      | `HUB_TOKENS_FILE`   | none             | Token file. Without it, every authenticated route answers 401.                           |
| `--external`    | `HUB_EXTERNAL_FILE` | none             | External A2A agents, such as Hermes, that the hub sends tasks to.                        |
| `--public-url`  | `HUB_PUBLIC_URL`    | from the request | Base URL on agent cards.                                                                 |
| `--push-allow`  | `HUB_PUSH_ALLOW`    | none             | Host names, addresses, and CIDRs that push webhooks may reach although they are private. |
| `--test-agents` | `HUB_TEST_AGENTS=1` | off              | Built-in `tck` and `echo` agents without a token, for conformance tests.                 |

The token file maps a principal name to a kind and the sha256 of its bearer token. `SIGHUP` reloads it.

```json
{ "mars": { "kind": "host", "sha256": "<hex>" }, "hermes": { "kind": "peer", "sha256": "<hex>" } }
```

- A `host` token acts for the pi sessions of that host. The first registration binds a session id to its host.
- A `peer` token may use only the A2A routes.
- Routes:
  - `GET /healthz`: no token.
  - `GET /a2a/<agent>/.well-known/agent-card.json` and `POST /a2a/<agent>`: one A2A agent per pi session. `<agent>` is a session id or `@<name>`.
  - `/link/...`: the pimon session link: registration, an event stream with replay by `Last-Event-ID` and acks, task updates, status, inbox. Host tokens only.
  - `GET /agents`: the registry. Host tokens only.
- Push webhooks to loopback, private, link-local, and CGNAT addresses are refused unless `--push-allow` lists them.
- CI runs the A2A TCK against the `tck` agent and the official Python SDK client against `echo`. A `v*` tag publishes the image `ghcr.io/orswn/pimon-hub` from `Containerfile`.

### External agents

The external file maps an agent id to an A2A server outside the hub. `SIGHUP` reloads it with the token file. Keep it at mode `0600`: it holds bearer tokens.

```json
{
	"hermes": {
		"name": "hermes",
		"url": "http://hermes:9900/",
		"token": "<bearer token that the agent accepts>",
		"description": "Hermes Agent",
		"pollMs": 10000,
		"cardTtlMs": 600000,
		"replyTimeoutMs": 960000
	}
}
```

- Required: `url` and `token`. The token must be visible ASCII. `name` defaults to the id and uses the same characters as an id. Unknown fields are an error.
- More optional fields: `idleMs` (default `30000`), `retryMs` (default `60000`), and `offlineMs` (default `600000`).
- pi sessions reach the agent at `/a2a/<id>` or `/a2a/@<name>`. The external name wins over a pi session with the same name.
- The hub card takes `description` from the file and the skills from the card of the agent. The hub reads that card every `cardTtlMs` and keeps the last good copy. After 3 failed reads the agent shows offline.
- The hub sends each task message with `SendStreamingMessage`. The text starts with `[from <sender name> on <host>]`.
- One message per context runs at a time. The next message of the context waits.
- The hub accepts only `task`, `question`, and `correction` messages for an external agent. It refuses other kinds.
- A message with a task id continues that task only while the task waits for input. Else the hub refuses it.
- A message without a task id continues the one task of its context that waits for input from the same sender.
- A removed agent keeps its row and its `@<name>`. It shows offline. Its queued and running tasks fail.
- Push is never sent to the agent. Hub clients use hub push on the hub task.
- Errors:
  - 401 or 403: the task fails.
  - 429: the hub retries after `retryMs`, at most 5 times.
  - Connection refused: the agent shows offline. The hub retries until `offlineMs`, then the task fails.
  - No answer within `replyTimeoutMs`: the task fails.
- Limit: when the stream drops, the hub polls `GetTask` every `pollMs`. It uses `ListTasks` when it has no remote task id. Hermes fails a task when its stream client goes away. So a dropped stream, or a hub restart during a task, fails the hub task with a text that says to ask again in the same context.
- The push guard does not apply to these URLs. The operator writes them.

## Environment

Names that pimon reads:

- `PI_BACKGROUND_DIR`: state dir for background leases. Default: `<agentDir>/background`.
- `PI_BUS_NAME`: bus name of this session.
- `PI_BUS_ROLE`: role of this session.
- `PI_BUS_PARENT`: parent session id of a session started by hand. The hub stores it as given. That parent can then close this session.
- `PI_BUS_TEAM`: `team` label.
- `PI_BUS_LABELS`: more labels, as `key=value,key=value`.
- `PI_BUS_WAKE_POLICY`: `all`, `parent`, or `none`. Default `all`.
- `PI_BUS_CONTROL`: `parent` or `none`. Default `parent`. With `none`, this session refuses a close request from its parent. `any` acts as `parent`.
- `PI_BUS_DEBUG`: `1` writes bus debug lines to stderr.
- `PI_CODING_AGENT_DIR`: `agents` gives it to a child.
- `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`: `agents` uses them to place children.
- `SHELL`: `agents` uses it to find an idle pane.
- `PI_ASK_SECRET_REASON`: `pi-ask-secret` shows it to the human. The caller sets it.
- `XDG_RUNTIME_DIR`: base dir for the `ask-secret` socket and the usage cache. Default `/tmp`.
- `TMPDIR`: base dir for the temporary files below. `agents` gives its temp dir to a child.

Names that pimon sets:

- `PI_ASK_SECRET_SOCK`: socket of the `ask-secret` prompt.
- `SUDO_ASKPASS`: the `pi-ask-secret` client.
- `PI_SECRET_<NAME>`: a secret that the human gave.
- `PI_CODING_AGENT_DIR`: `agents` sets it in a child pane when the parent has it.
- `TMPDIR`: `agents` sets it in a child pane to the temp dir of the parent.

At start, pimon removes these names from its own env. Commands and child processes do not inherit them:

- `PI_BUS_NAME`, `PI_BUS_LABELS`, `PI_BUS_ROLE`, `PI_BUS_PARENT`, `PI_BUS_TEAM`.
- Names that earlier versions used: `PI_BUS_OWNER`, `PI_BUS_CONTROL_TOKEN`, `PI_BUS_DIR`, `PI_AGENT_LABEL`, `PI_AGENTS_TOOLS`, `PIMON_SPAWN_FILE`.

Background jobs also do not inherit the other `PI_BUS_*` names.

## Files

pimon reads or writes these paths:

- `<agentDir>/pimon-hub.token`: read only. The hub token of the `bus` feature. Set another path with `hub.tokenFile`.
- `<agentDir>/background/leases/`: crash-recovery leases. With `PI_BACKGROUND_DIR`: `$PI_BACKGROUND_DIR/leases/`.
- `$TMPDIR/pi-background-logs/`: job logs without a `logFile`.
- `$TMPDIR/pi-agents-<uid>/`: child records, spawn files, child pid files, close hooks, and session roles.
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
- The versioned records: lease, spawn file, child pid file, agent record, and usage cache. Log files are not covered.

The hub HTTP API is versioned by `HUB_PROTOCOL`, not by the pimon version. A pimon client works with a hub of the same `HUB_PROTOCOL`.

Prompt text and tool descriptions can change in a minor version.
