# pimon

One pi package. One extension entry point: `src/index.ts`. Each feature is a module in `src/features/<id>/`.

## Commands

- `npm run verify`: format check, lint, type check, and tests. Run it before each commit.
- `npm run check`: `vp check` (Oxfmt, Oxlint, type-aware lint with type check).
- `npm run typecheck`: `tsc --noEmit` with TypeScript 7.
- `npm test`: unit, integration, and process tests.
- `npm run test:e2e`: real `pi --mode rpc` with a real model. Run by hand only.
- `npx vp check --fix`: apply formatting.
- `scripts/fetch-hub.sh`: puts the a2a-hub binary that `scripts/a2a-hub.pin` names at `.hub/a2a-hub`. Run it before the first `npm test` and after each pin change. Local mode builds it from source over SSH with `mise` and Go.

## Layout

- `src/core/`: feature contract, config, prompt sections, events, services, reload state.
- `src/features/<id>/`: one feature. `index.ts` exports a `defineFeature(...)` value.
- `src/features/index.ts`: the list of features in load order.
- `src/**/*.test.ts`: unit tests next to the code.
- `test/integration/`: in-process `AgentSession` with the faux model. Use `test/support/harness.ts`.
- `test/process/`: tests that start child processes, sockets, or timers.
- `test/e2e/`: tests that start real pi and a real model.

## Feature rules

- `setup` registers tools, commands, hooks, and prompt sections. It starts no process, socket, or timer.
- Start long-lived work in `ctx.onSessionStart`. Stop it in `ctx.onSessionShutdown`.
- Keep state that must survive `/reload` in `ctx.reloadState(key, version, create)`. Bump the version when the shape changes.
- Use `ctx.service(id)` for another feature's service. List that feature in `dependsOn`.
- Use `ctx.events` for events between features. Do not use `pi.events` or `globalThis` for that.
- Read options only from `ctx.config`. Declare them in `configSchema`.
- Start or steer a model run only through `ctx.wake`. Do not call `pi.sendMessage` with `triggerTurn`.
- One exception: the agents feature sends the first task of a spawned child with `pi.sendUserMessage`, so the task is a user message.

## Prompt and cache rules

- Add model guidance with `ctx.promptSection`. Never return `systemPrompt` from `before_agent_start`.
- A section's text depends only on:
  - its `PromptInput`,
  - state that a feature fixes before the first render and never changes for that runtime.
- No time, counters, job lists, or other live state in section text.
- Sections render once per runtime, after all `onSessionStart` handlers. Later tool changes do not re-render them.
- `requiresTools` chooses at each run if a section is sent. It never changes the text.
- Never change tool names, descriptions, or schemas after load.
- Live state reaches the model through tool results or custom messages, never through the system prompt.
- Each change to prompt text or tool text updates the snapshot test in the same commit.
- Model tokens count like CPU and memory. A change to model-visible text (prompt sections, tool descriptions and schemas, tool results, wake and notice messages) states its chars before and after in the commit body. For text that changes with input, state the chars of one typical instance and of the fixed part.
- A change must not start more model runs or change the request prefix without a stated reason.

## Tests

- Each bug fix starts with a failing regression test that describes the behavior. Test names carry no issue ids.
- Each test uses its own temp agent dir. No test reads or writes `~/.pi`.
- Unit, integration, and process tests run in a sandbox (`test/support/sandbox.ts`): temp `HOME`, `XDG_RUNTIME_DIR`, `PI_CODING_AGENT_DIR`, recording stubs first in `PATH`, and no `PI_BUS_*`, `HERDR_*`, `PI_ASK_SECRET_SOCK`, `SUDO_ASKPASS`.
- No test may reach the human: no real desktop or phone notification, terminal multiplexer, `sudo`, or live pi socket. Code that runs an external command takes an injectable exec. A new external command also goes into `STUBBED_COMMANDS`.
- Run tests only through `npm test`, `npm run verify`, or `vp test run --project ...`. Never run the old standalone extension test files.
- Tests that need a hub start an a2a-hub process: `HUB_BIN` if set, else `.hub/a2a-hub`. They reach it only over HTTP. The a2a-hub repository owns the hub tests.

## Releases

- SemVer. `CHANGELOG.md` headings are `## [x.y.z] - YYYY-MM-DD`.
- A release is one `chore(release): vX.Y.Z` commit and a `vX.Y.Z` tag.
- A release pins an a2a-hub release: `scripts/a2a-hub.pin` names its tag and image digest, and the `@orswn/a2a-hub-protocol` dev dependency names the same tag. CI pulls the image only by digest.
- Commit headers follow Conventional Commits. Bodies follow the Linux kernel style.
