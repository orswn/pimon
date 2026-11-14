# Changelog

All notable changes to pimon are listed here. Versions follow SemVer.

## [Unreleased]

### Fixed

- The hub image carries the `org.opencontainers.image.source` label, so GitHub links the `ghcr.io/orswn/pimon-hub` package to this repository.

## [1.7.0] - 2026-11-14

### Added

- `pimon-hub` in `src/hub/`: an A2A 1.0 message hub for pi sessions on several hosts, with its own SQLite task store, per-host and per-peer bearer tokens, a session link with replay, and a registry. CI checks it with the A2A TCK and the official Python SDK, and a tag publishes the `ghcr.io/orswn/pimon-hub` image. The pi extension does not load it yet.

## [1.6.1] - 2026-11-09

### Fixed

- vi: after `/reload`, the hardware cursor shows again, so insert mode shows the bar cursor and normal mode the block. Before, pi hid it after the reload and drew its own block cursor.

## [1.6.0] - 2026-11-09

### Added

- In fullscreen mode, a left click on a footer count shows its list: `A` shows `/agents`, `B` shows `/background list`, `M` shows `/monitor list`, and `T` shows `/timers`.

## [1.5.2] - 2026-11-09

### Fixed

- vi: a double Esc pressed in normal mode reaches pi again, so it opens `/tree` (or the configured double-Escape action). Esc keys mashed right after leaving insert mode or a pending command still reach pi only once.

## [1.5.1] - 2026-11-09

### Removed

- Support for the standalone bus and agents extensions and for the old model cache. pimon no longer reads `PI_AGENTS_TOOLS`, the old bus owner on `globalThis`, or `~/.cache/pi/dynamic-models/`, and no longer prunes the old launcher dir. A reply to a message without a sender owner is an error.

## [1.5.0] - 2026-11-09

### Added

- The `goal_set` tool. The model creates, edits, pauses, resumes, or clears the goal, but only on a direct human message in the current run. A `/goal` text that points to earlier talk becomes a pending goal, and the model writes its objective. The human words stay on the record, and `/goal` shows them.

### Changed

- The model marks its own goal done. `goal_done` is accepted at once, and the model then writes a final message. The model check is gone. `/goal-check` still runs a shell check.
- Esc or an interrupted run leaves the goal active and waiting. It continues on the next human message or goal timer. A peer interrupt also sends a phone notice.
- `/reload` keeps a goal running. After a pi restart, an active goal with no timer waits, with one notice. A forked session pauses the copied goal.
- Goal continuation messages count continuations, not turns. Goal phone notices do not repeat their title.

## [1.4.0] - 2026-11-09

### Added

- The `stale` feature adds one short message to the first run after an idle gap of 30+ minutes, a pi reload or restart, a host suspend, or a host restart. Option `stale.idleMinutes`.

## [1.3.0] - 2026-11-09

### Changed

- The statusline work counts moved to the right side, before the model and a group separator.

## [1.2.0] - 2026-11-09

### Added

- The statusline shows work counts after the path and git status: `A` children that are starting or running, `B` background jobs, `M` monitors, `T` armed timers. Option `statusline.workCounts`.

## [1.1.1] - 2026-11-09

### Fixed

- `pi_agents` opens a child tab in the workspace that the parent pane is in now. Before, a parent pane moved to another Herdr workspace opened children in its first workspace.

## [1.1.0] - 2026-11-09

### Changed

- The statusline context segment shows tokens against the compaction threshold, not the model context window.
- The `notify` result names phones by count, not by a device id.
- `/compaction-overrides` names the settings key and file, sorts the models, and says when no model needs an override.

### Fixed

- A child whose first turn runs longer than 30 s no longer fails its Herdr placement and gets closed. The child sends its first task after the parent's placement returns.
- A prompt section that needs a tool is sent only in a run where that tool is active. Before, the tools at the first render decided it for the whole session.
- The bus state after a compaction no longer lists questions from peers that left.
- `background` and `monitor` status and logs find the newest log with the same name from another or an earlier pi process.
- A monitor that `once` stops after its first match shows `stopped (matched once)`, not a signal or `aborted`.
- The match wake and the mute notices of a monitor name `ignoreCase` like its status does.

## [1.0.0] - 2026-11-08

### Changed

- The monitor match digest and the timeout notice name the command only for a job with a generated name.
- First stable release. From this version, semantic versioning covers the surfaces that the README lists under Stability.

### Fixed

- The statusline no longer makes the prompt editor about 3 times slower on a long prompt.

## [0.13.0] - 2026-11-08

### Added

- README documents every feature, option, tool, command, environment name, and file, the git install source, and what semantic versioning covers.
- `background` start waits up to `inlineWaitMs` (default 5000 ms) and returns the exit digest of a job that ends in that time. No wake is sent for such a job.
- `pimon.json` `tools` turns single pimon tools off. A tool that is off is not registered, and a prompt section that needs only tools that are off is left out. pimon warns when a tool that is on needs a tool that is off.

### Changed

- Unknown `statusline` and `vi` options are an error that turns the feature off, like the options of other features. The message names the unknown option.
- A bus digest shows a subject only when it differs from the thread title.
- The goal continuation no longer repeats the timer rule of the goal section.
- pimon tools add no line to pi's tool list. The tool definitions still carry their descriptions.
- The background section tells the model to run a command that ends within about one minute with `bash`. The timer and codemode lines are separate sections, left out when their tools are absent.
- The `background` and `monitor` start result no longer repeats the command, the lifetime note, or the read hint. It names the cwd only when it differs from the session cwd.
- The exit digest no longer names the cwd. It names the command only for a job with a generated name.
- Shorter `background`, `monitor`, and `timer` tool text.
- The monitor `maxPerMinute` default is 6, down from 20.

## [0.12.1] - 2026-11-08

### Changed

- A context without images no longer gets the image-budget warning that images cannot be omitted.

### Fixed

- A bus socket bind error that a retry cannot fix no longer delays every prompt by 2.1 s. The bus tries again at the next session start.
- A fallback bus socket dir under `$TMPDIR` or `/tmp` is used only if it is a real directory that the user owns. Its mode is set to 0700.
- The bus unread count no longer includes messages that left the inbox.
- pimon shows a repeated diagnostic once and keeps the newest 100.

## [0.12.0] - 2026-11-08

### Added

- `vi` feature: a modal vi editor for the prompt. Moved from the standalone extension. Options: `clipboard` (`"yank"` or `"never"`) and `cursorShape`.

### Changed

- Peer presence files are written when the run state changes, not on each tool call. `pi_bus peers` shows the current tool within 5 s.
- Bus digests show message bodies up to 4000 bytes before they cut them. The limit was 1200 bytes.
- The `notify`, `goal`, `background`, and secrets prompt sections appear only when their tools are active.
- The prompt sections are about 1600 characters shorter. Text that pi or the tool descriptions already state is gone.
- A spawned child replies to a task that came as a bus message, and treats a coordinator task over the bus like its first task.
- Compared with the standalone vi extension: `p` and `P` put the vi register only. Paste the system clipboard with the terminal paste key.
- Compared with the standalone vi extension: deletes and changes no longer reach the system clipboard. Yanks still do, unless `clipboard` is `"never"`.
- Compared with the standalone vi extension: in normal mode, Esc no longer starts the double-Escape action of pi. The first Esc still stops a run or a `!` command.
- Compared with the standalone vi extension: `j` and `k` move by logical lines and do not browse the prompt history. The arrow keys still do. Counts before `i a A I o O` have no effect.

### Removed

- The `pi_agents` parameter `where`. It had no effect.
- Compared with the standalone vi extension: ex commands such as `:q`, the `{` and `}` motions, `gJ`, and the `piVim.clipboardMirror` setting. Use the vi option `clipboard`.

## [0.11.0] - 2026-11-08

### Changed

- The exit of a child after `pi_agents` `close` or `kill` no longer starts a model run. The exit notice is added to the session: in the current run when one is active, otherwise before the next one. A crash after `close`, and an exit with unanswered requests, still wake the parent.

## [0.10.0] - 2026-11-08

### Added

- `bus` feature with the `pi_bus` tool and the `/bus` commands. Moved from the standalone extension. Reply to a message with its `messageId` as `corrId`. Address a coordinator as `owner:<id>`, which stays the same across reloads. A send reports each recipient as `delivered`, `unconfirmed`, or `failed`. The bus identity reaches the status line on the pimon event bus.
- `agents` feature with the `pi_agents` tool and the `/agents` commands. Moved from the standalone extension. The parent gives the task and the control token to a child in a private spawn file, not in argv or env. A spawn says `Task delivered.` only after the child read its spawn file and joined the bus. Children start only in Herdr panes. A role with `mcp: false` starts its children without MCP servers. Children start with the parent's agent dir.

### Removed

- Compared with the standalone extension: tmux, kitty, and terminal placements for spawned children. Records of such children still load. Their panes are not managed.

## [0.9.0] - 2026-11-08

### Added

- `background_codemode` and `monitor_codemode` tools. They run a codemode script as a background job or a monitor. Scripts call pi tools through `tools`, log lines with `emit(text)`, and wait with `sleep(ms)`. Script jobs stop at reload, session switch, and quit. At most 4 run at once; the `background` option `maxScriptJobs` changes the limit.

## [0.8.0] - 2026-11-08

### Added

- `statusline` feature with the footer status line and the working indicator. Moved from the standalone extension. Options: `usage`, `usagePollSeconds`, `gitStatus`.

### Changed

- Session token and cost totals in the status line count all session entries, like pi's built-in footer. The old extension counted only the assistant messages of the current branch.
- Usage limits show for the `anthropic` and `openai-codex` providers with an OAuth login. Other providers show no limits. The old extension showed Codex limits for every provider except `claude-code`.
- The `goal` feature sends `goal:state` on the pimon event bus instead of `pi.events`. The `goal:refresh` event is gone. The goal sends its state at each session start.

## [0.7.0] - 2026-11-08

### Added

- `timer` tool and `/timers` command in the `background` feature. A timer wakes its session later with a reason. Timers end with the pi process.

### Changed

- An active goal ends a run only while a timer is armed. Without a timer the goal continues. Three runs in a row without a tool call and without a timer pause the goal as `stalled`.

### Removed

- The `goal_wait` tool. Set a `timer` instead.

## [0.6.0] - 2026-11-08

### Added

- `notify` feature with the `notify` tool and a notify service for other features. Moved from the standalone extension.
- `goal` feature with `/goal`, `/goal-check`, and the `goal_wait` and `goal_done` tools. Moved from the standalone extension.
- `<notify>` and `<goal>` prompt sections.

### Changed

- Each feature that starts processes owns its own process runner.

### Fixed

- `/goal`, pause, and clear during a run no longer abort the running tool.
- Replacing a goal in the TUI asks for confirmation. A short argument that looks like a verb, such as `/goal l resume`, is not taken as a new goal without confirmation.
- A run that the user aborts pauses the goal as user input, not as a model error.
- A goal check command can run for up to 15 minutes.
- A late tool result of the previous goal does not count as evidence for the new goal.
- Goal pause and blocked notifications are never muted by the rate limit.
- Monitor lines longer than 16 000 characters are split also when they arrive with their newline.
- A job that a timeout or a once monitor cannot kill is reported to the agent.
- A log file of a running sibling pi is not reused.

## [0.5.0] - 2026-11-08

### Added

- `ask-secret` feature: askpass socket in the TUI, `[[secret:...]]` input, and redaction of secrets from tool results, full output files, and model wakes. Moved from the standalone extension.
- `compaction` feature: warns when a model compacts later than `maxThresholdTokens`. `/compaction-overrides` prints the missing `compaction.modelOverrides`.
- `ancestor-config` feature: skills, prompts, and MCP servers from `.pi` and `.agents` dirs between the home dir and the working dir.
- `discovery` feature: lists the models of providers marked with `dynamicDiscovery` in `models.json`.
- `<secrets>` prompt section.
- Core `ctx.wake` and `ctx.wakeFilter` for messages that start or steer a model run.

### Changed

- Compaction thresholds come from pi's `compaction.modelOverrides`. The feature does not change the model or compact by itself.
- Model discovery no longer blocks startup on the network.

### Fixed

- A background digest or other wake that arrives during a manual compaction no longer starts a parallel run on the old context or a second compaction.
- An askpass reply is redacted from later tool output.
- Secrets in background job output no longer reach the model through the exit digest.
- Discovered models stay available while pi refreshes the model catalog.
- ancestor-config ignores a working dir outside the home dir.

## [0.4.0] - 2026-11-07

### Added

- `background` feature with the `background` and `monitor` tools and commands, moved from the standalone extension.
- `<background>` prompt section.

### Fixed

- Monitor `edit` of the pattern now rebuilds the matcher.
- A pi no longer reports or stops the live jobs of another pi. Leases record their owner.
- A burst of matches arrives as one digest instead of a silent mute.
- Digests wake only the session that started the job.
- Quit escalates to SIGKILL before exit.
- Monitors match the whole line up to 16 KB.
- `stop` confirms the exit in its result.
- The start result states the real job lifetime.

## [0.3.0] - 2026-11-07

### Added

- `image-budget` feature, moved from the standalone extension.
- Options `triggerBytes`, `targetBytes`, `keepRecentImages` in `pimon.json`.

### Fixed

- The "no image can be omitted" warning repeated on every turn. It now shows once and again after 4 MB more growth, with a next step.

## [0.2.0] - 2026-11-07

### Added

- `harness` feature: the core operating rules as the `<harness>` prompt section.
- Process runner with process group cancellation and failure marking.
- File snapshot test for all rendered prompt sections.

### Changed

- Prompt wording: parallel calls per message, "yield" and "run" instead of "turn", AGENTS.md proposals only in defect reports.

## [0.1.0] - 2026-11-07

### Added

- Package manifest with one pi extension entry point.
- Feature runtime: dependency order, typed options from `pimon.json`, per-feature failure isolation.
- Reload state that survives `/reload` and session replacement in one process.
- Static system prompt sections, rendered once per runtime and applied on every run.
- `/pimon` command with feature status, prompt sections, and diagnostics.
- Check for a second copy of the pi packages.
- Unit and in-process integration tests with the faux model. CI on push.
