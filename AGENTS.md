# Repository Instructions

<!-- Claude Code include: @WORKFLOW.md -->
See [WORKFLOW.md](./WORKFLOW.md) for the full development workflow.

## Documentation Requirements

All user-facing behavior changes must update the matching docs under `docs/`.

## Changesets

If a PR changes user-facing behavior or belongs in release notes, make sure it includes a `.changeset/*.md` entry using the scoped package name `@lossless-claude/lcm`.

## Review Hygiene

Before pushing, verify that docs and instruction files still match the implemented behavior, and keep Copilot review/setup workflow configuration aligned between review and coding sessions.