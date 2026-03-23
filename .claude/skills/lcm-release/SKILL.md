---
name: lcm-release
description: "Use when the user says 'cut a release', 'release vX.Y.Z', 'publish a new version', or 'bump the version'. Covers the full release flow: version bump → PR to main → CI → merge → publish → develop sync."
---

# lcm-release

Cut a versioned release of lossless-claude/lcm. This is a **public npm package** — never delete or overwrite existing git tags.

## Normal flow — use the script

Run `.claude/skills/lcm-release/scripts/release.sh` from the repo root:

```bash
bash .claude/skills/lcm-release/scripts/release.sh <version>
# e.g.
bash .claude/skills/lcm-release/scripts/release.sh 0.4.2
```

**Resuming after a failure** — pass `--from-step N` to skip already-completed steps:

```bash
bash .claude/skills/lcm-release/scripts/release.sh 0.4.2 --from-step 8  # re-watch publish.yml
bash .claude/skills/lcm-release/scripts/release.sh 0.4.2 --from-step 9  # just run develop sync
```

**Sync develop standalone** — when Step 9 needs to run independently:

```bash
bash .claude/skills/lcm-release/scripts/sync-develop.sh 0.4.2
```

The script handles everything end-to-end:

| Step | What it does |
|------|--------------|
| 0 | Checkout develop, pull, verify clean, sync develop←main (via PR if needed) |
| 1 | Guard: abort if tag or npm version already exists |
| 2 | Create `release/vX.Y.Z` branch from develop |
| 3 | Bump all 3 version files, verify they all match |
| 4 | Commit and push |
| 5 | Open PR targeting `main` |
| 6 | Wait for CI (skips gracefully if no CI configured) |
| 7 | Merge with `--merge` (preserves commit SHA on main) |
| 8 | Wait for `publish.yml` to complete |
| 9 | Open and merge sync PR to bring the release commit back into develop |

## Prerequisites

- All feature PRs for this release are merged into `develop`
- `gh` CLI is authenticated
- You have a version number that is higher than any existing tag/npm release

## Key invariants

- **Never delete tags** on a public package — if a version is taken, pick a higher one
- **Release PRs target `main`** — the only exception to "PRs target develop"
- **Use `--merge`** (not squash) so the version bump SHA is preserved on main
- **All 3 version files must match**: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - Note: marketplace.json stores version at `.plugins[0].version`, not root

## Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Guard fails: tag exists | Version already tagged | Pick a higher version |
| Guard fails: npm version exists | Already published | Pick a higher version |
| publish.yml conclusion is `skipped` | Tag or npm version exists (race) | Pick a higher version; start over |
| develop diverged from main (cannot fast-forward) | Branches were manually changed or cherry-picked | Manually reconcile `develop` and `main` until fast-forwardable, then rerun |
| publish.yml conclusion is not `success` | Build/test/publish failed | Check the run URL printed by the script |

## Scripts

```
.claude/skills/lcm-release/scripts/release.sh       ← full end-to-end, supports --from-step N
.claude/skills/lcm-release/scripts/sync-develop.sh  ← standalone Step 9 (develop sync)
```
