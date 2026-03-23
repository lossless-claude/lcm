---
name: lcm-release
description: "Use when the user says 'cut a release', 'release vX.Y.Z', 'publish a new version', or 'bump the version'. Covers the full release flow: version bump → PR to main → CI → merge → publish → develop sync."
---

# lcm-release

Cut a versioned release of lossless-claude/lcm. This is a **public npm package** — never delete or overwrite existing git tags.

## Prerequisites

Before starting, confirm:
- All feature PRs for this release are merged into `develop`
- CI on `develop` is green
- You have a version number (e.g. `0.4.1`)

## Step 0 — Start clean on develop

```bash
git checkout develop
git pull origin develop
git status   # must be clean — stash or discard any changes first
```

Then sync develop with main in case the previous release was never synced back:

```bash
git fetch origin
git merge origin/main --no-edit   # fast-forward in normal cases
```

If `develop` is behind main (previous Step 9 was skipped), this brings it current. If there are conflicts, resolve them before proceeding.

> **Note:** `develop` is branch-protected — you cannot push directly. If the merge above produces new commits, open a PR (`chore/sync-develop-pre-vX.Y.Z` → `develop`) and merge it before continuing.

## Step 1 — Guard: check the version is clean

```bash
VERSION="0.4.1"   # substitute target version

git fetch --tags

# Abort if tag already exists
if git rev-parse --verify "refs/tags/v$VERSION" >/dev/null 2>&1; then
  echo "ERROR: tag v$VERSION already exists. Choose a higher version."
  exit 1
fi

# Abort if already published to npm
if npm view lossless-claude@$VERSION version >/dev/null 2>&1; then
  echo "ERROR: $VERSION already on npm. Choose a higher version."
  exit 1
fi
```

If either check fails, **stop and pick a different version**. Never delete tags on a public package.

## Step 2 — Create release branch from develop

```bash
git checkout develop
git pull origin develop
git checkout -b release/v$VERSION
```

## Step 3 — Bump all three version files

Three files must always stay in sync:

| File | Field |
|------|-------|
| `package.json` | `"version"` |
| `.claude-plugin/plugin.json` | `"version"` |
| `.claude-plugin/marketplace.json` | `"plugins[0].version"` |

Use `npm version` for `package.json` (no git tag), then edit the other two manually:

```bash
npm version $VERSION --no-git-tag-version
# then edit .claude-plugin/plugin.json and .claude-plugin/marketplace.json
```

Verify all three match before committing:

```bash
node -p "require('./package.json').version"
node -p "require('./.claude-plugin/plugin.json').version"
node -p "require('./.claude-plugin/marketplace.json').plugins[0].version"
```

> **Note:** `marketplace.json` stores version at `.plugins[0].version`, not at the root.

## Step 4 — Commit and push

```bash
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version to $VERSION"
git push -u origin release/v$VERSION
```

## Step 5 — Open PR targeting main

```bash
gh pr create \
  --base main \
  --title "chore: release v$VERSION" \
  --body "Version bump to $VERSION."
```

> **Note:** Release PRs target `main` directly — this is the one exception to the "PRs target develop" rule.

If GitHub reports the PR as conflicting, it means develop was not synced after the last release. The conflicts will be in the version files only (old version vs new version). Resolve by keeping the new version (`--ours`) and pushing the resolution commit.

## Step 6 — Wait for CI

```bash
gh pr checks <PR_NUMBER> --watch
```

Do not merge until CI is green. If no CI checks are configured, this command exits with "no checks reported" — that is expected; proceed to Step 7.

## Step 7 — Merge the release PR

```bash
gh pr merge <PR_NUMBER> --repo lossless-claude/lcm --merge
```

Use `--merge` (not `--squash`) to preserve the version bump commit SHA on main.

## Step 8 — Wait for the publish workflow

Merging a `package.json` change to `main` auto-triggers `publish.yml`. Monitor it:

```bash
gh run list --repo lossless-claude/lcm --workflow publish.yml --limit 3
gh run watch <RUN_ID> --repo lossless-claude/lcm
```

The workflow runs typecheck + tests + build, then:
- `npm publish --access public`
- Creates git tag `vX.Y.Z`
- Creates GitHub release with auto-generated notes

**If the workflow says "skipping":** the tag or npm version already exists. The version is taken — pick a higher version and start over from Step 1.

## Step 9 — Sync develop with main

After the release PR merges, `main` has the release merge commit that `develop` is missing. Because `develop` is branch-protected, the sync requires a PR:

```bash
git checkout develop
git pull origin develop
git merge origin/main --no-edit
git checkout -b chore/sync-develop-v$VERSION
git push -u origin chore/sync-develop-v$VERSION
gh pr create \
  --base develop \
  --title "chore: sync develop with main after v$VERSION release" \
  --body "Brings the release merge commit back into develop."
gh pr merge <SYNC_PR_NUMBER> --repo lossless-claude/lcm --merge
```

## Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| publish.yml says "skipping" | Tag or npm version already exists | Pick a higher version; start over from Step 1 |
| 3 files show different versions | Missed a file in Step 3 | Push a fix commit before merging |
| PR to main is conflicting | Develop not synced after last release | Resolve version-file conflicts keeping the new version (`git checkout --ours`) |
| `gh pr checks --watch` says "no checks reported" | No CI configured on this repo | Expected — skip to Step 7 |
| `git push origin develop` rejected | Branch is protected | Use the sync PR flow in Step 9 |
| PR accidentally targets develop | Wrong `--base` flag | Close and reopen targeting `main` |

## Version file locations (quick ref)

```
package.json                      ← npm package version  (.version)
.claude-plugin/plugin.json        ← Claude Code plugin version  (.version)
.claude-plugin/marketplace.json   ← Marketplace listing version  (.plugins[0].version)
```

All three must match exactly.
