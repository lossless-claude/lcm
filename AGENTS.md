# Repository Instructions

<!-- Claude Code include: @WORKFLOW.md -->
See [WORKFLOW.md](./WORKFLOW.md) for the full development workflow.

## PR Review And Merge

- Before merging a PR, check whether it changes user-facing behavior or should appear in npm release notes.
- If yes, make sure a maintainer adds a `.changeset/*.md` file before merge or immediately after in a follow-up PR.
- Do not expect external contributors to know or run the Changesets workflow.
- Use the smallest appropriate bump:
  - `patch`: fixes, compatibility work, docs-visible behavior changes
  - `minor`: new features or notable new behavior
  - `major`: breaking changes
- Treat a PR as not release-ready until the changeset question has been answered.

## Local Environment Stability

After merging a feature PR, always rebuild and verify the local environment before moving on:

```bash
git checkout develop && git fetch origin develop && git reset --hard origin/develop
npm run build && chmod +x dist/bin/lcm.js && npm link
lcm doctor          # must show 0 failures
npm test            # must pass
```

Also sync the global plugin cache so Claude Code picks up updated hooks and commands:

```bash
# Find the cached plugin directory (version and owner may vary)
CACHE=$(ls -d ~/.claude/plugins/cache/*/lossless-claude/*/ 2>/dev/null | head -1)
if [ -n "$CACHE" ]; then
  rm -rf "$CACHE" && mkdir -p "$CACHE"
  cp .claude-plugin/plugin.json "$CACHE/"
  cp -r .claude-plugin/commands "$CACHE/"
  cp -r .claude-plugin/hooks "$CACHE/"
fi
```

Then run `/reload-plugins` inside Claude Code to apply the changes.

If anything fails, fix it before starting the next feature. A broken local env wastes time on every subsequent session (stale dist, wrong binary, hook errors, mismatched plugin cache).

## Documentation Requirements

All changes that affect user-facing behavior must include complete documentation in the `docs/` folder. This includes new features, configuration changes, CLI commands, hook additions, and API changes. Documentation should be written for end users, not developers — explain what it does, how to use it, and any configuration options.

## Coding Style

- **Prefer pure functions.** Functions should return their results rather than accumulating state on an object. Avoid mutable side-effect patterns (e.g., shared counters on a class instance) when a return value works just as well.

## Bug Triage During Investigation

When you stumble across a bug while working on something else, **stop and file a GitHub issue immediately** before continuing:

```bash
gh issue create \
  --title "Short description of bug" \
  --body "**Observed:** what you saw\n**Expected:** what should happen\n**Root cause:** if known\n**Repro:** steps or code snippet" \
  --label bug
```

Then carry on with the original task. This ensures bugs are tracked and can be assigned to another agent without holding up the current work.

## Copilot Code Review Workflow

Copilot reviews PRs targeting `main` and `develop` automatically. The ruleset has `review_on_push: true` — every push triggers a fresh review. No manual re-request needed.

### Custom instructions

`.github/copilot-instructions.md` contains project-specific review rules that Copilot reads server-side. When you learn a new pattern from a review round (something Copilot flagged that was a real issue), add it to that file so it's caught automatically next time.

### Reducing review rounds

Most multi-round Copilot reviews happen because of preventable issues. Before pushing a PR:

1. **Doc/code alignment** — if you changed a flag or behavior, check whether help text, SKILL.md tables, or README entries need updating
2. **Shell scripts** — use `--ff-only` for `git pull`, env var overrides for timeouts; see `gh` CLI notes below
3. **JSON files** — use in-place string replacement, never `JSON.stringify` (it reformats the file)
4. **Merge strategies** — sync PRs use `--merge` (never `--rebase` — fails on merge commits)
5. **Consistency** — if the same flag/strategy appears in multiple places, verify they all match
6. **GitHub Actions workflows** — always declare `permissions:` explicitly; add `actions/setup-node` before using `node`; make branch/PR creation idempotent (check if branch/PR exists before creating)

### gh CLI conventions (v2.88.1)

Some flags that look reasonable don't exist in the installed version:

- **`gh pr create` does not support `--json`/`--jq`** — it outputs a URL. Extract the PR number with `${url##*/}`:
  ```bash
  PR_URL=$(gh pr create --repo "$REPO" --base develop --title "..." --body "...")
  PR_NUMBER="${PR_URL##*/}"
  [[ "$PR_NUMBER" =~ ^[0-9]+$ ]] || { echo "bad PR number: $PR_URL" >&2; exit 1; }
  ```
- **`gh pr merge --yes` does not exist** — omit it; the command is non-interactive by default
- **`gh pr list --json number`** works fine for listing/querying

### Handling review comments

- **Suggestion commits**: for trivial fixes, accept Copilot's suggestion directly on GitHub (zero tokens)
- **Simple fixes** (renames, string updates): dispatch a haiku subagent
- **Logic changes**: dispatch a sonnet subagent
- Never implement fixes inline in the main session — always dispatch a subagent

## Release Process

The canonical release process is `.claude/skills/lcm-release/scripts/release.sh` — use it for all releases. `RELEASING.md` and `WORKFLOW.md` describe an older Changesets-based flow that is no longer in use.

See `SKILL.md` in the `lcm-release` skill for the full step table and failure modes.

## Git Gotchas

- **`.claude/` is gitignored** — skill and script files under `.claude/` are tracked but require `git add -f` to stage them. If `git add .claude/...` silently does nothing, that's why.
- **`develop` has branch protection** — direct push is rejected. Always push to a feature branch and open a PR, even for trivial fixes.

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any shell command containing `curl` or `wget` will be intercepted and blocked by the context-mode plugin. Do NOT retry.
Instead use:
- `context-mode_ctx_fetch_and_index(url, source)` to fetch and index web pages
- `context-mode_ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any shell command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` will be intercepted and blocked. Do NOT retry with shell.
Instead use:
- `context-mode_ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### Direct web fetching — BLOCKED
Do NOT use any direct URL fetching tool. Use the sandbox equivalent.
Instead use:
- `context-mode_ctx_fetch_and_index(url, source)` then `context-mode_ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Shell (>20 lines output)
Shell is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `context-mode_ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `context-mode_ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### File reading (for analysis)
If you are reading a file to **edit** it → reading is correct (edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `context-mode_ctx_execute_file(path, language, code)` instead. Only your printed summary enters context.

### grep / search (large results)
Search results can flood context. Use `context-mode_ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `context-mode_ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `context-mode_ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `context-mode_ctx_execute(language, code)` | `context-mode_ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `context-mode_ctx_fetch_and_index(url, source)` then `context-mode_ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `context-mode_ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `upgrade` MCP tool, run the returned shell command, display as checklist |
