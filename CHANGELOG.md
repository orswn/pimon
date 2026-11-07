# Changelog

All notable changes to pimon are listed here. Versions follow SemVer.

## [Unreleased]

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
