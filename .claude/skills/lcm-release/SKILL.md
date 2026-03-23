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
| `.claude-plugin/marketplace.json` | `"version"` |

Verify all three match before committing:

```bash
node -p "require('./package.json').version"
node -p "require('./.claude-plugin/plugin.json').version"
node -p "require('./.claude-plugin/marketplace.json').version"
```

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

## Step 6 — Wait for CI

```bash
gh pr checks <PR_NUMBER> --watch
```

Do not merge until CI is green.

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

After the release PR merges, `main` has the version bump that `develop` is missing:

```bash
git checkout develop
git pull origin develop
git merge main
git push origin develop
```

This is a fast-forward merge — no conflicts expected.

## Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| publish.yml says "skipping" | Tag or npm version already exists | Pick a higher version; start over from Step 1 |
| 3 files show different versions | Missed a file in Step 3 | Push a fix commit before merging |
| Develop conflicts after sync | Direct push to main outside this flow | Resolve conflicts; do not force-push |
| PR accidentally targets develop | Wrong `--base` flag | Close and reopen targeting `main` |

## Version file locations (quick ref)

```
package.json                      ← npm package version
.claude-plugin/plugin.json        ← Claude Code plugin version
.claude-plugin/marketplace.json   ← Marketplace listing version
```

All three must match exactly.
