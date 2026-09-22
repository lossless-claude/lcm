---
"@lossless-claude/lcm": minor
---

feat: one tool vocabulary every harness translates onto, so no harness's tools raise nothing

Passive learning keyed on Claude Code's tool names, and each harness carried its own bespoke
renamer: `normalizeCodexTool` translated two Codex ids, the Oh My Pi hook translated eleven of
its own. Anything else fell through and recorded nothing on success.

`src/hooks/tool-vocabulary.ts` is now the seam. A harness owns a table; the module owns what a
table means — an id is mapped to a canonical name (optionally rewriting the payload into the
fields the extractor reads), declared silent with the reason written down, or left absent. A
declined mapping still passes the call through under the harness's own name, so a failed tool
records its error regardless of whether its payload fit a shape.

`src/hooks/extractors.ts` exports the canonical set the harnesses may target and gains four
shapes they needed: GitHub write operations (`github_pr_create`, `github_pr_push`,
`github_pr_checkout`, `github_run_watch`), a started security scan (`security_scan`), an
agent-written context note (`context_note`), and context lifecycle changes
(`context_checkpoint`, `context_rewind`, `context_reset`). Promotion tags the two new categories
through the documented `category:<category>` fallback, as `task`, `subagent`, `skill` and `mcp`
already do.

Codex gains `update_plan` (a `task_update` naming the step in progress) and `spawn_agent` (a
`subagent_dispatch` when the payload names one); a `write_stdin` poll is declared transport. Oh
My Pi gains `todo`, `github`, `security_scan`, `context_notes`, `checkpoint`, `rewind` and
`new_context`, and declares its own memory tools silent so lcm neither duplicates nor feeds back
what the harness already remembers.
