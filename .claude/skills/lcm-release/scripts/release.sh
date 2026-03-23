#!/usr/bin/env bash
# lcm-release — full end-to-end release script
# Usage: ./release.sh <version>  (e.g. 0.4.2)
set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>  (e.g. 0.4.2)"
  exit 1
fi

REPO="lossless-claude/lcm"
RELEASE_BRANCH="release/v$VERSION"
SYNC_BRANCH="chore/sync-develop-v$VERSION"

err()  { echo ""; echo "✗ ERROR: $*" >&2; exit 1; }
step() { echo ""; echo "━━━ $* ━━━"; }
ok()   { echo "  ✓ $*"; }

# ─── STEP 0: Clean state and develop sync ────────────────────────────────────
step "Step 0 — Clean state"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "develop" ]]; then
  echo "  Switching to develop (was on $CURRENT_BRANCH)..."
  git checkout develop
fi

git pull origin develop

if [[ -n "$(git status --porcelain)" ]]; then
  err "Working tree is dirty. Commit or stash changes first."
fi
ok "Working tree is clean."

# Sync develop←main in case previous release was never synced back
git fetch origin
BEHIND=$(git rev-list --count develop..origin/main)
if [[ "$BEHIND" -gt 0 ]]; then
  echo "  develop is $BEHIND commit(s) behind main — syncing before release..."

  if ! git merge origin/main --no-edit --ff-only 2>/dev/null; then
    err "develop has diverged from main and cannot be fast-forwarded. Resolve conflicts manually before releasing."
  fi

  # develop is branch-protected — sync via PR
  PRE_BRANCH="chore/sync-develop-pre-v$VERSION"
  git checkout -b "$PRE_BRANCH"
  git push -u origin "$PRE_BRANCH"
  PRE_URL=$(gh pr create \
    --base develop \
    --title "chore: sync develop with main before v$VERSION release" \
    --body "Pre-release sync: brings develop up to date with main.")
  PRE_PR=$(echo "$PRE_URL" | grep -o '[0-9]*$')
  echo "  Opened pre-release sync PR #$PRE_PR — merging..."
  gh pr merge "$PRE_PR" --repo "$REPO" --merge
  git checkout develop
  git pull origin develop
  ok "develop synced with main."
else
  ok "develop is up to date with main."
fi

# ─── STEP 1: Guard ───────────────────────────────────────────────────────────
step "Step 1 — Guard: check v$VERSION is available"

git fetch --tags

if git rev-parse --verify "refs/tags/v$VERSION" >/dev/null 2>&1; then
  err "Tag v$VERSION already exists. Choose a higher version. Never delete tags on a public package."
fi
ok "Git tag v$VERSION is free."

if npm view "lossless-claude@$VERSION" version >/dev/null 2>&1; then
  err "$VERSION is already published to npm. Choose a higher version."
fi
ok "npm lossless-claude@$VERSION is free."

# ─── STEP 2: Release branch ──────────────────────────────────────────────────
step "Step 2 — Create release branch"

if git rev-parse --verify "$RELEASE_BRANCH" >/dev/null 2>&1; then
  err "Branch $RELEASE_BRANCH already exists. Delete it or choose a different version."
fi

git checkout -b "$RELEASE_BRANCH"
ok "On branch $RELEASE_BRANCH."

# ─── STEP 3: Bump all three version files ────────────────────────────────────
step "Step 3 — Bump all three version files to $VERSION"

npm version "$VERSION" --no-git-tag-version --silent
ok "package.json → $VERSION"

node -e "
const fs = require('fs');
const p = '.claude-plugin/plugin.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.version = '$VERSION';
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"
ok "plugin.json → $VERSION"

node -e "
const fs = require('fs');
const p = '.claude-plugin/marketplace.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
j.plugins[0].version = '$VERSION';
fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
"
ok "marketplace.json → $VERSION"

# Verify all three match
V1=$(node -p "require('./package.json').version")
V2=$(node -p "require('./.claude-plugin/plugin.json').version")
V3=$(node -p "require('./.claude-plugin/marketplace.json').plugins[0].version")

if [[ "$V1" != "$VERSION" || "$V2" != "$VERSION" || "$V3" != "$VERSION" ]]; then
  err "Version mismatch after bump! package.json=$V1  plugin.json=$V2  marketplace.json=$V3"
fi
ok "All three files verified at $VERSION."

# ─── STEP 4: Commit and push ─────────────────────────────────────────────────
step "Step 4 — Commit and push"

git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump version to $VERSION"
git push -u origin "$RELEASE_BRANCH"
ok "Pushed $RELEASE_BRANCH."

# ─── STEP 5: Open PR to main ─────────────────────────────────────────────────
step "Step 5 — Open PR targeting main"

PR_URL=$(gh pr create \
  --base main \
  --title "chore: release v$VERSION" \
  --body "Version bump to $VERSION.")
PR_NUMBER=$(echo "$PR_URL" | grep -o '[0-9]*$')
ok "PR #$PR_NUMBER created: $PR_URL"

# ─── STEP 6: Wait for CI ─────────────────────────────────────────────────────
step "Step 6 — Wait for CI"

if gh pr checks "$PR_NUMBER" --watch 2>/dev/null; then
  ok "CI green."
else
  echo "  (No CI checks configured — skipping.)"
fi

# ─── STEP 7: Merge release PR ────────────────────────────────────────────────
step "Step 7 — Merge release PR #$PR_NUMBER"

gh pr merge "$PR_NUMBER" --repo "$REPO" --merge
ok "PR #$PR_NUMBER merged to main."

# ─── STEP 8: Wait for publish.yml ────────────────────────────────────────────
step "Step 8 — Wait for publish.yml"

echo "  Waiting for workflow to appear..."
sleep 8

RUN_ID=$(gh run list --repo "$REPO" --workflow publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')
if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
  err "Could not find a publish.yml run. Check https://github.com/$REPO/actions manually."
fi

echo "  Watching run $RUN_ID..."
gh run watch "$RUN_ID" --repo "$REPO"

CONCLUSION=$(gh run view "$RUN_ID" --repo "$REPO" --json conclusion --jq '.conclusion')
if [[ "$CONCLUSION" != "success" ]]; then
  if [[ "$CONCLUSION" == "skipped" ]]; then
    err "publish.yml was skipped — tag or npm version already exists. The version is taken. Pick a higher version and start over."
  fi
  err "publish.yml $CONCLUSION. Check https://github.com/$REPO/actions/runs/$RUN_ID"
fi
ok "lossless-claude@$VERSION published to npm."

# ─── STEP 9: Sync develop with main ──────────────────────────────────────────
step "Step 9 — Sync develop with main"

git checkout develop
git pull origin develop
git fetch origin main
git merge origin/main --no-edit
git checkout -b "$SYNC_BRANCH"
git push -u origin "$SYNC_BRANCH"

SYNC_URL=$(gh pr create \
  --base develop \
  --title "chore: sync develop with main after v$VERSION release" \
  --body "Brings the v$VERSION release merge commit back into develop.")
SYNC_PR=$(echo "$SYNC_URL" | grep -o '[0-9]*$')

echo "  Opened sync PR #$SYNC_PR — merging..."
gh pr merge "$SYNC_PR" --repo "$REPO" --merge
ok "develop synced with main."

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓  lossless-claude@$VERSION released successfully"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
