# Development Workflow

This workflow is the default for all non-trivial features. When superpowers brainstorming asks design questions, these defaults apply unless the user overrides.

## Continuous Improvement

This document is a living record. **Update it whenever you learn something:**

- A step that failed or caused rework → add it to Common Pitfalls
- A new default answer that proved correct → add it to the Defaults table
- A Copilot interaction pattern that worked (or didn't) → update the Copilot section
- A phase that needed reordering or an extra step → revise the phase
- A new tool, command, or technique that saved time → document it

**When to update:** At the end of every feature cycle (after the implementation PR merges), review this doc against what actually happened. If reality diverged from the doc, fix the doc — not reality.

**How to update:** Create a `docs/<topic>` branch, push, get Copilot review, merge to develop. Same flow as any other docs change.

## Branch Strategy

```
feature/docs branches → develop (default, protected) → main (releases only, protected)
```

- **`develop`** — Default branch. All PRs target develop. Protected: PRs required, linear history, no force push.
- **`main`** — Releases only. Merging develop → main triggers the publish workflow.
- **Feature branches** — `feat/<topic>`, `docs/<topic>`, `fix/<topic>`. Always branch from develop.

### Release Flow

1. Changesets accumulate on `develop` (`.changeset/*.md` files)
2. Version PR is auto-created by `changesets/action` on each develop push
3. When ready to release: merge the version PR on develop (bumps package.json)
4. Create PR: `develop` → `main`
5. Merge to main triggers publish workflow:
   - Type-check, test, build
   - Publish to npm (`@lossless-claude/lcm`)
   - Create git tag + GitHub release
   - Update plugin manifest version

### CI Triggers

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push to develop/main + all PRs | Type-check, test, build |
| `version-pr.yml` | Push to develop | Auto-create version PR from changesets |
| `publish.yml` | `workflow_dispatch` (manual from main) | Publish npm + marketplace + tag |

## Defaults (predefined answers for brainstorming)

| Question | Default Answer |
|----------|---------------|
| Spec location | `.xgh/specs/YYYY-MM-DD-<topic>-design.md` |
| Visual companion | No (CLI project, no visual questions) |
| Implementation approach | Parallel tracks — breaking changes isolated from additive work |
| Registry/config format | TypeScript (type-safe, compile-time checks) |
| Install behavior | Auto-write files (match ByteRover (brv) UX) |
| State tracking | Filesystem scan (no state files) |
| Release strategy | Parallel tracks with separate PRs |
| PR review | Copilot via reviewers list, not @copilot tag |

## Phase 1: Design (Opus, max effort)

1. Study the spec/requirements using brainstorming skill
2. Ask clarifying questions only for genuinely ambiguous decisions — use defaults above for standard questions
3. Propose 2-3 approaches with trade-offs, recommend one
4. Present design sections incrementally, get user approval
5. Write design spec to `.xgh/specs/`
6. Run spec review loop (code-reviewer agent + user review)
7. Write implementation plan to `.xgh/specs/`

## Phase 2: Spec Review via PR

1. **Sync first:** `git push origin main` if there are unpushed local commits — stale diffs cause Copilot to review unrelated code
2. Create `docs/<topic>` branch from develop
3. Ensure only documentation files are in the diff — specs, plans, workflow docs
4. Push and open PR
5. Request Copilot review (add `copilot-pull-request-reviewer[bot]` to reviewers)
6. Run review loop (see Copilot Review Loop below)
7. Merge once Copilot has no issues (max 3 rounds — see Review Loop)

## Phase 3: Implementation (Sonnet subagents)

1. **Sync first:** `git pull origin main` to get latest (including merged specs)
2. Dispatch `model: sonnet` subagents with `isolation: worktree` for each task in the plan
3. **Independent tasks** → launch in parallel (e.g., PR A: delete files, PR D: add new module)
4. **Sequential tasks** → launch one at a time; after merging upstream PR, rebase downstream branch: `git fetch origin main && git rebase origin/develop`
5. Each subagent: implement code + tests, run `npm test`, commit (do NOT push)
6. After subagent completes: review the diff, push, open PR, request Copilot review

## Phase 4: Final Review (Opus, max effort)

1. Review all implementation work against the spec
2. Run full test suite — all tests must pass
3. Fix any issues found
4. Ensure changeset file exists if user-facing changes

## Phase 5: Implementation PR + Copilot Review

1. Push implementation branch, open PR
2. Request Copilot review (add to reviewers list)
3. Run review loop (see below)
4. Merge once Copilot review has no remaining inline comments

## Copilot Interaction

### Actions

- **Trigger code review:** Add `copilot-pull-request-reviewer` to PR reviewers via `gh pr edit --add-reviewer`
- **Re-trigger review** (after pushing fixes): `gh pr edit --remove-reviewer` then `--add-reviewer` (see Exact Commands)
- **Delegate work** (have Copilot open a PR): Tag `@copilot` in a PR comment
- **Reply to Copilot comments:** Start inline replies with `@copilot`
- **Never** tag `@copilot` in comments when you want a review — it opens a new PR instead

### Exact Commands

```bash
# Request review (and re-trigger after fixes)
gh pr edit {n} --repo {owner}/{repo} --remove-reviewer copilot-pull-request-reviewer
sleep 2
gh pr edit {n} --repo {owner}/{repo} --add-reviewer copilot-pull-request-reviewer
```

**Why `gh pr edit` and not the REST API:**
The REST `requested_reviewers` endpoint returns **422** for bot reviewers ("Reviews may only be requested from collaborators"). `gh pr edit` uses the GraphQL API internally and handles bot reviewers correctly. Confirmed working on PR #56.

**Methods that do NOT work:**
- `gh api -X POST .../requested_reviewers -f 'reviewers[]=copilot-pull-request-reviewer'` — 422 for bots
- Empty commits — Copilot does not reliably trigger on diffs with no substantive changes
- Tagging `@copilot` in comments — opens a new PR instead of reviewing

### Polling for Review Completion

Copilot reviews take 1-3 minutes. Do NOT sleep-poll in a loop. Use background commands.

```bash
# 1. Check if review request is still pending (Copilot hasn't started):
gh pr view {n} --json reviewRequests --jq '.reviewRequests[].login'
# Empty = Copilot picked it up. "copilot-pull-request-reviewer[bot]" = still pending.

# 2. Check review count (compare before/after):
gh api repos/{owner}/{repo}/pulls/{n}/reviews --jq '. | length'

# 3. Most reliable: check timeline for reviewed event:
gh api 'repos/{owner}/{repo}/issues/{n}/timeline?per_page=100' \
  --jq '[.[] | select(.event == "review_requested" or .event == "reviewed")] | .[-2:]'
# If last event is "reviewed" → review complete.
# If last event is "review_requested" → still in progress.

# 4. Get latest review details:
gh api repos/{owner}/{repo}/pulls/{n}/reviews \
  --jq '.[-1] | {state: .state, body: .body[:300]}'

# 5. Get new inline comments (after a timestamp):
gh api repos/{owner}/{repo}/pulls/{n}/comments \
  --jq '[.[] | select(.created_at > "TIMESTAMP")] | .[] | {path: .path, line: .line, body: .body[:250]}'
```

### Copilot Review Loop

1. Request review (POST to requested_reviewers)
2. Launch ONE background command: `sleep 180 && <check review count + comments>`
3. When notified, check latest review state and new comments
4. If comments found:
   a. **Batch ALL fixes** into a single commit (do not fix-push-review one at a time)
   b. Push once
   c. Re-trigger review (DELETE + POST)
5. **Max 3 rounds.** After round 3, if remaining comments are minor nits (1-2 editorial suggestions), merge. Do not chase zero comments indefinitely.
6. Review is "clean" when: 0 new comments, or only context-specific nits that Copilot can't understand (e.g., Claude Code conventions)

### Common Pitfalls

- **Stale diff**: Always push develop before creating branches. If main has unpushed commits, the PR diff includes unrelated code and Copilot reviews the wrong things.
- **@copilot in comments**: Opens a new PR instead of triggering review. Always use the reviewers API.
- **REST API 422 for Copilot bot**: The `requested_reviewers` REST endpoint rejects bot slugs. Use `gh pr edit --add-reviewer` instead.
- **Empty commits don't trigger Copilot**: Copilot only reviews on substantive diffs. Use `gh pr edit` re-request instead.
- **Code in docs PRs**: Cherry-pick only docs commits if the branch has mixed content. Use `git checkout -B <clean-branch> origin/develop && git cherry-pick <docs-commits>`.
- **Sequential PR chains**: After merging PR A, rebase PR B onto updated main before pushing: `git fetch origin main && git rebase origin/develop`.
