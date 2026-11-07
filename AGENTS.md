# pimon

One pi package. One extension entry point: `src/index.ts`. Each feature is a module in `src/features/<id>/`.

## Commands

- `npm run verify`: format check, lint, type check, and tests. Run it before each commit.
- `npm run check`: `vp check` (Oxfmt, Oxlint, type-aware lint with type check).
- `npm run typecheck`: `tsc --noEmit` with TypeScript 7.
- `npm test`: unit, integration, and process tests.
- `npm run test:e2e`: real `pi --mode rpc` with a real model. Run by hand only.
- `npx vp check --fix`: apply formatting.

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

## Prompt and cache rules

- Add model guidance with `ctx.promptSection`. Never return `systemPrompt` from `before_agent_start`.
- A section's text depends only on its `PromptInput`. No time, counters, job lists, or other live state.
- Never change tool names, descriptions, or schemas after load.
- Live state reaches the model through tool results or custom messages, never through the system prompt.
- Each change to prompt text or tool text updates the snapshot test in the same commit.

## Tests

- Each bug fix starts with a failing regression test that names the issue.
- Each test uses its own temp agent dir. No test reads or writes `~/.pi`.

## Releases

- SemVer. `CHANGELOG.md` headings are `## [x.y.z] - YYYY-MM-DD`.
- A release is one `chore(release): vX.Y.Z` commit and a `vX.Y.Z` tag.
- Commit headers follow Conventional Commits. Bodies follow the Linux kernel style.
