---
"@lossless-claude/lcm": patch
---

fix: one owner for Claude Code's project-directory name, and documentation corrections

Three modules encoded Claude Code's `~/.claude/projects/<cwd>` naming rule and two disagreed with
the third and with Claude Code: `cwdToProjectHash` in `src/import.ts` replaced only slashes, and
the daemon's periodic transcript sweep additionally stripped the leading dash. A cwd holding a
`.`, `_` or `+` was therefore never matched, so `lcm import --all` skipped those projects, `lcm
diagnose` looked in a directory that does not exist, and the ten-minute catch-up sweep found
nothing for any project. The rule now lives once, as `claudeProjectSlug` in
`src/daemon/project.ts`, and every reader of `~/.claude/projects/` goes through it.

`lcm compact --help` lists `-v, --verbose`, and `lcm stats --help` lists `--pool` and `--json`;
all three were installed and undiscoverable. The "Anthropic provider needs a key" error names the
variable the daemon actually reads — `llm.apiKey` in `config.json`, or `ANTHROPIC_API_KEY` — where
it previously named `LCM_SUMMARY_API_KEY`, which no code path ever read and the docs taught.

Corrections in tracked documentation: `docs/privacy.md` states the real default summarizer
(`auto`, so the running harness's CLI does send the text it summarizes) and what `lcm uninstall`
actually removes; `docs/hook-protocol.md` describes auto-heal's direction, the `<memory-context>`
block, the `tool_output` shape, the post-tool daemon call and the `Stop` event;
`docs/architecture.md` drops the assembler, the `<summary>` XML format and the non-existent
lifecycle hooks and reconciliation in favour of what `createRestore` and the transcript sources
do; `docs/import.md` states that Codex tool calls and outputs are imported as `tool` messages;
`RELEASING.md` states that merging the version PR publishes and that the tag precedes npm;
`docs/configuration.md`, `docs/agent-tools.md`, `docs/search.md`, `docs/fts5.md`,
`docs/passive-learning.md`, `docs/ci-runner.md`, `README.md` and `AGENTS.md` carry the rest.