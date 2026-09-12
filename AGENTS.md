# lcm — agent contract

This file routes; it does not repeat what the sources say. Read [CONTEXT.md](CONTEXT.md) first: it fixes the vocabulary.

## Sources of truth

| Working on | Read | The code it must agree with |
|---|---|---|
| anything | [CONTEXT.md](CONTEXT.md) | `src/transcript.ts`, `src/subagent-attribution.ts` |
| the data model, compaction, ingestion | [docs/architecture.md](docs/architecture.md) | `src/store/`, `src/compaction.ts`, `src/daemon/` |
| hooks, the function-hooks module | [docs/hook-protocol.md](docs/hook-protocol.md) | `.claude-plugin/plugin.json`, `src/hooks/`, `hooks/lcm-hooks.ts` |
| env vars, `config.json`, the summarizer | [docs/configuration.md](docs/configuration.md) | `src/db/config.ts`, `src/daemon/config.ts` |
| MCP tools and their parameters | [docs/agent-tools.md](docs/agent-tools.md) | `src/mcp/tools/*.ts` |
| cutting a release | [docs/releasing.md](docs/releasing.md) | `.github/workflows/publish.yml`, `.github/workflows/version-pr.yml` |
| CI, the self-hosted runner | [docs/ci-runner.md](docs/ci-runner.md) | `.github/workflows/ci.yml` |

A change that alters what one of these documents states updates the document in the same PR.

## What is the plugin and what is the repository

The plugin is distributed from this repository's root, so everything the plugin loads must be usable by someone who installed lcm and never opens this repo:

- Plugin: `.claude-plugin/plugin.json`, `skills/`, `hooks/`, `bundle/` (built by `npm run build:bundle`, committed by version PRs).
- Repository only: `.claude/`, `.agents/`, `.github/`, `scripts/`, `test/`, `tools/`, `plans/`, and every doc about developing lcm rather than using it.

Development skills have two homes and no copies: `.agents/skills/` for what Codex and Copilot load (both read that directory), `.claude/skills/` for what only Claude Code loads.

A skill that exists to work **on** lcm goes under `.claude/` or `.agents/`, never under the plugin. The plugin's own surface is skills only: a skill that only a person should invoke sets `disable-model-invocation: true`, and it routes to `lcm help <command>` rather than restating options, so the CLI stays the one reference.

## Invariants

- No tracked file names a repository that merely consumes lcm: not a doc, comment, test, fixture, changeset or workflow.
- No session-, machine- or account-local evidence in a shared artifact. Exception: an evaluation result on a named corpus that justifies a design constant is the rule together with its evidence, and stays.
- Design notes go in `docs/design/`. There is no roadmap source; do not invent one.
- Any PR that changes published behaviour carries a changeset (`npm run changeset`).
- Bot reviews (Copilot, Codex) only when asked explicitly, one per round.
- `main` is the only long-lived branch; there is no release branch. PRs target it. `version-pr.yml` is run by hand when a release is wanted; merging the version PR it opens changes `package.json`, which runs `publish.yml`: tag, then npm, then GitHub release, each only if still missing. The marketplace entry pins plugin installs to that tag; npm pins every other host.

## Verification

Before claiming a documentation, skill, command or agent change is done:

```sh
npm run check-docs     # every `lcm` flag on the command path it follows, LCM_* variable and lcm_* tool a document names exists in the code
npm run check-agents   # this contract and its declared sources are consistent
npm run typecheck && npm test
```

CI runs the same three. What they do not verify: `check-docs` proves a name exists in the code, not that the code path is reachable or that the prose around it is true; `check-agents` proves the sources exist, are non-empty and are linked from this file, not that a source agrees with the code it names. Those two remain review work. `claude plugin validate .claude-plugin/plugin.json` walks the plugin's skills; run it after touching one.
