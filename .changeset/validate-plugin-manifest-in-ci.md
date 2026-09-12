---
"@lossless-claude/lcm": patch
---

fix: the four bundled agents now load with their frontmatter, and CI validates the plugin

`agents/memory-explorer.md`, `agents/compaction-reviewer.md`,
`agents/transcript-debugger.md` and `agents/health-investigator.md` each wrote a
multi-line `description` as a plain YAML scalar, which does not parse. Every one
of them had been loading with its name taken from the filename and every other
field — description, model, color, tools — silently dropped, since the first
release that shipped them. The descriptions are now literal block scalars, byte
for byte the same text, and they parse.

`ci.yml` runs `claude plugin validate` after `check-manifest`: strictly against
`.claude-plugin/marketplace.json`, and, naming `.claude-plugin/plugin.json`, a
full walk of the plugin's agents, skills, commands and hooks module. That walk is
what found the frontmatter defect above. `.claude-plugin/marketplace.json` also
gains the top-level `description` that `--strict` asks for.

This does not replace `npm run typecheck:hooks`, which stays local-only:
`plugin validate` checks structure, not whether a `$` method still exists on the
running build. Both reasons are now written down, in `docs/ci-runner.md` and
`docs/hook-protocol.md`.
