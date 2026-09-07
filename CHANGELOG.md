# @lossless-claude/lcm

## Unreleased

### Added
- `copilot-process` summarizer provider, backed by the GitHub Copilot CLI. `auto` resolves to it once a client identifies itself as `copilot`; today select it with `LCM_SUMMARY_PROVIDER=copilot-process`.
- Normalized token cost reporting across all three process providers. `llm_usage_stats` now stores input, cached, and output tokens alongside the total, and `lcm import --replay` prints the breakdown.

### Changed
- `codex-process` reads its usage from `codex exec --json` instead of the stderr banner, gaining an exact input/cached/output split (the stderr total remains a fallback for older Codex builds).
- `claude-process` reads `--output-format json`, so it now reports token usage and cost.

## [0.8.1] - 2026-03-30

### Added
- User notification when sensitive data is filtered from LCM history (closes #178)

### Fixed
- Compact-restore test isolation — eliminate tmpdir() contamination (#184)

### Changed
- Quality-gates CI: label-based merge requirements (#185)
- autoimprove.yaml: add missing forbidden paths (closes #182) (#183)

## [0.8.0] - 2026-03-28

### Added
- Connection pooling for sidecar EventsDb (issue #131)
- Portable knowledge export/import commands — `lcm export`, `lcm import-knowledge` (issue #132)
- Pool stats observable — `lcm stats --pool` + `GET /stats/pool` daemon endpoint
- AR coverage gate CI workflow
- Copilot auto-review on all PRs

### Fixed
- `post-tool` command not registered in CLI dispatcher (#162)
- Security: upgraded hono, rollup, picomatch (3 high CVEs)
- Security: CodeQL hostname regex escaping + sanitizeError in daemon
- Atomic meta.json write in `importKnowledge` — prevents corruption on crash mid-write
- `redaction_stats` CHECK constraint migration for v0.7.0 → v0.8.0 upgrades (adds `'gitleaks'` category)

## 0.1.0

Initial release under `@lossless-claude/lcm`.
