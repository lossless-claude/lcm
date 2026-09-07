# @lossless-claude/lcm

## [0.10.0] - 2026-09-07

### Added
- `llm.reasoning` config key: passes a reasoning object (e.g. `{"effort":"minimal"}`) to the `openai` summarizer, so OpenAI-compatible models like GLM Flash stop thinking at length before every summary (#342).
- `copilot-process` summarizer provider, backed by the GitHub Copilot CLI. `auto` resolves to it once a client identifies itself as `copilot`; today select it with `LCM_SUMMARY_PROVIDER=copilot-process` (#313).
- Normalized token cost reporting across all three process providers. `llm_usage_stats` now stores input, cached, and output tokens alongside the total, and `lcm import --replay` prints the breakdown.
- Native evidence search with session fusion (#321), FTS5-ready natural-language queries with stopword filtering and AND→OR fallback (#311), and `lcm bench build|run` for real-corpus recall benchmarks.
- Summarizer evaluation bench under `test/bench/` with OpenRouter, OpenAI-compatible and `claude-process` providers (#338).
- Resumable replay runs: manifest/ledger tables, resume planner, signal drain, `--restart` (#302, #326, #330, #331).
- Prompt-time memory injection budget and deduplication (#220), feedback-based reranking of recalled memories (#218), stale-memory review pipeline (#221), auto-promotion of reinforced passive-learning patterns (#217).

### Changed
- `codex-process` reads its usage from `codex exec --json` instead of the stderr banner, gaining an exact input/cached/output split (the stderr total remains a fallback for older Codex builds).
- `claude-process` reads `--output-format json`, so it now reports token usage and cost.
- The `claude-process` summarizer subprocess is isolated from user plugins, MCP servers and settings (#328).
- Summary output cap follows the requested target instead of a fixed constant (#336).
- `lcm daemon start` is idempotent; `stop`/`restart` added; the daemon carries a content-hash build fingerprint and `lcm doctor` checks the real plugin install (#325, #329).
- Tag prefix `category:` normalized to `type:` everywhere (#212, #219).

### Fixed
- Summarizer fails on empty model output instead of echoing the input back as a summary (#341).
- Hooks: `PostToolUseFailure` registered, hook POSTs bounded by deadlines, sensitive paths screened on tool failures and in the Bash command prefix, never exit non-zero on malformed stdin (#334).
- SQLite `datetime('now')` columns read as UTC.
- `DaemonClient` uses `node:http`, removing undici's 300 s headersTimeout false failures on `/compact`.
- `lcm_search` natural-language queries no longer return empty on AND-only FTS5 matching (#311).
- Restore no longer echoes CLAUDE.md on startup/resume, captures it once when cwd is `$HOME`, and shares SQLite connections throughout (#271).
- VS Code and Codex `lcm` workflows restored (#227); plugin hook commands point argv[1] at the CLI so they actually run (#272).
- Session-end fire-and-forget requests send the daemon auth header.

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
