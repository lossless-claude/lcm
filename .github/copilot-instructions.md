# Copilot Instructions

## Reference Documents

When reviewing changes, consult the relevant sources of truth:

| Area | Document |
|------|----------|
| PR review & merge conventions | [AGENTS.md](/AGENTS.md) |
| Development workflow & phases | [WORKFLOW.md](/WORKFLOW.md) |
| Release & publish process | [RELEASING.md](/RELEASING.md) |
| Hook lifecycle & auto-heal | [.claude-plugin/hooks/README.md](/.claude-plugin/hooks/README.md) |
| Design specs & decisions | `.xgh/specs/YYYY-MM-DD-<topic>-design.md` |
| Implementation plans | `.xgh/specs/YYYY-MM-DD-<topic>-plan.md` |
| CLI entry points | `bin/lossless-claude.ts` |
| Daemon routes | `src/daemon/routes/*.ts` |
| Config type & defaults | `src/daemon/config.ts` (`DaemonConfig`) |

## Review Scope

Always review every file in the PR diff, including documentation, specs, plans, configs, and markdown files — not just code. If a PR contains design specs (`.xgh/specs/`), implementation plans, workflow docs, or instruction files, review them for clarity, correctness, internal consistency, and alignment with existing project conventions.

## Code Review Checklist

These rules apply to **new and changed code** in the PR. Do not flag pre-existing code that the PR did not touch.

### Hook Safety
- Hook handlers (`handle*` functions in `src/hooks/*.ts`) must return `{ exitCode: 0 }` on error — never throw or return non-zero
- The hook dispatcher (`dispatchHook` in `src/hooks/dispatch.ts`) may throw on invalid input — that is intentional
- Hooks must never crash Claude Code, even if the daemon is unreachable

### Database Safety
- New `DatabaseSync()` calls should have a matching `db.close()` in a `finally` block
- New database connections should set `PRAGMA busy_timeout = 5000` before queries
- `--dry-run` commands must not call `runLcmMigrations()` or otherwise write to disk

### Import Discipline
- Required dependencies are listed in `package.json` `dependencies` (not `devDependencies`)
- Optional SDK packages (e.g., `openai`, `@anthropic-ai/sdk`) have dedicated wrapper modules in `src/llm/` — new call sites should import from those wrappers, not directly from the SDK
- Prefer `node:` prefix for Node.js built-ins in new code

### Type Completeness
- When adding fields to shared types (e.g., `DaemonConfig`), verify all test mocks and fixtures include the new field

### Shell Script Safety
- All `gh` CLI commands that parse output must use `--json` + `--jq` (or pipe to `node -pe "JSON.parse(...)"`), never `grep`/`sed`/`awk` on human-readable output
- All `gh pr merge` and `gh pr create` commands must include `--repo "$REPO"` — the script may run from a fork or different remote
- `git pull` in automation must use `--ff-only` to prevent unintended merge commits
- Hardcoded timeouts and limits (e.g., `MAX_WAIT=300`) should be overridable via environment variables (e.g., `${PUBLISH_MAX_WAIT:-900}`)
- Semver version arguments interpolated into shell commands must be validated against a regex before use
- `set -euo pipefail` is required at the top of all bash scripts

### JSON File Manipulation
- Never use `JSON.parse` + `JSON.stringify` to update a single field in a JSON file — this reformats the entire file (indentation, key order, trailing newlines)
- Use targeted in-place string replacement (e.g., `s.replace(/"version": "[^"]*"/, ...)`) to preserve original formatting
- After any version bump, verify all version files agree (package.json, plugin.json, marketplace.json)

### Documentation Consistency
- When code and documentation describe the same behavior (flags, merge strategies, command descriptions), verify they match
- If a PR changes a flag or behavior in code, check whether any markdown files, help text, or table entries in the same PR need a corresponding update
- Help text summaries in command tables must accurately describe what the command does — e.g., a "purge" command that deletes all project data should not be summarized as "remove patterns"

### Review Completeness

When reviewing a PR, report **all** issues found across the changed files — do not limit output to only the most critical. Triage by severity within the review:

1. **Correctness / safety** — bugs, data loss, crashes, security issues
2. **Reliability** — error handling, edge cases, resume flows
3. **Documentation consistency** — code/docs mismatches, stale comments
4. **Style / minor** — naming, formatting, whitespace

Do not save issues for a follow-up review. If an issue exists in a changed file, include it now.

### Merge Strategy Consistency
- All sync PRs (develop←main) must use `--merge`, never `--rebase` — rebase fails when the PR contains merge commits from main
- Release PRs (branch→main) use `--merge` to preserve the commit SHA for publish.yml tracking
- If multiple `gh pr merge` calls exist in the same script or related scripts, verify they use consistent merge strategies
