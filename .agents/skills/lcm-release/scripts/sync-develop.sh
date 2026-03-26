#!/usr/bin/env bash
# sync-develop.sh — sync develop←main after a release
#
# Use when Step 9 of release.sh needs to run standalone, e.g.:
#   - publish.yml succeeded but release.sh was interrupted before Step 9
#   - A release was cut manually outside of release.sh
#
# Usage: ./sync-develop.sh <version>  (e.g. 0.4.2)
set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>  (e.g. 0.4.2)"
  exit 1
fi

SEMVER_REGEX='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
if ! [[ "$VERSION" =~ $SEMVER_REGEX ]]; then
  echo "Invalid version '$VERSION'. Expected semver like '0.4.2' or '1.2.3-beta.1'."
  echo "Usage: $0 <version>  (e.g. 0.4.2)"
  exit 1
fi

REPO="lossless-claude/lcm"
SYNC_BRANCH="chore/sync-develop-v$VERSION"

err() { echo ""; echo "✗ ERROR: $*" >&2; exit 1; }
ok()  { echo "  ✓ $*"; }

# Validate origin points at the canonical repo (not a fork)
ORIGIN_URL=$(git remote get-url origin 2>/dev/null || true)
if [[ "$ORIGIN_URL" != *"$REPO"* ]]; then
  err "origin does not point to $REPO (got: $ORIGIN_URL). Run from the canonical repo, not a fork."
fi

echo ""
echo "━━━ Sync develop←main after v$VERSION release ━━━"

if [[ -n "$(git status --porcelain | grep -v '^??')" ]]; then
  err "Working tree is dirty. Commit or stash changes first."
fi

git checkout develop
git pull --ff-only origin develop || err "develop has diverged from origin/develop. Resolve manually before syncing."
AHEAD=$(git rev-list --count origin/develop..develop)
if [[ "$AHEAD" -ne 0 ]]; then
  err "Local develop has $AHEAD commit(s) not on origin/develop. Push or reset develop before running this script."
fi
git fetch origin main

BEHIND=$(git rev-list --count develop..origin/main)
if [[ "$BEHIND" -eq 0 ]]; then
  ok "develop is already up to date with main — nothing to sync."
  exit 0
fi

echo "  develop is $BEHIND commit(s) behind main — creating sync branch..."

if git show-ref --verify --quiet "refs/heads/$SYNC_BRANCH"; then
  err "Branch $SYNC_BRANCH already exists locally. Delete it (git branch -D \"$SYNC_BRANCH\") or reuse it."
fi

if git ls-remote --exit-code --heads origin "$SYNC_BRANCH" >/dev/null 2>&1; then
  echo "  Branch $SYNC_BRANCH already exists on remote — checking for open PR..."
  EXISTING_PR=$(gh pr list --repo "$REPO" --head "$SYNC_BRANCH" --base develop --json number --jq '.[0].number' 2>/dev/null)
  if [[ -n "$EXISTING_PR" && "$EXISTING_PR" =~ ^[0-9]+$ ]]; then
    echo "  Found open PR #$EXISTING_PR — merging..."
    gh pr merge "$EXISTING_PR" --repo "$REPO" --merge --delete-branch
    ok "develop is now in sync with main."
    exit 0
  fi
  # Branch exists but no open PR — create the PR from the existing branch
  echo "  No open PR found — creating PR from existing branch..."
  SYNC_URL=$(gh pr create \
    --repo "$REPO" \
    --head "$SYNC_BRANCH" \
    --base develop \
    --title "chore: sync develop with main after v$VERSION release" \
    --body "Syncs develop with main after the v$VERSION release. Merges the release commit into develop.")
  SYNC_PR="${SYNC_URL##*/}"
  if [[ -z "$SYNC_PR" || ! "$SYNC_PR" =~ ^[0-9]+$ ]]; then
    err "Failed to parse PR number from gh pr create output: $SYNC_URL"
  fi
  echo "  Opened sync PR #$SYNC_PR — merging..."
  gh pr merge "$SYNC_PR" --repo "$REPO" --merge --delete-branch
  ok "develop is now in sync with main."
  exit 0
fi

git checkout -b "$SYNC_BRANCH"
if ! git merge --no-edit origin/main; then
  err "Unable to merge origin/main into $SYNC_BRANCH. Resolve conflicts manually."
fi
git push -u origin "$SYNC_BRANCH"

SYNC_URL=$(gh pr create \
  --repo "$REPO" \
  --base develop \
  --title "chore: sync develop with main after v$VERSION release" \
  --body "Syncs develop with main after the v$VERSION release. Merges the release commit into develop.")
SYNC_PR="${SYNC_URL##*/}"

if [[ -z "$SYNC_PR" || ! "$SYNC_PR" =~ ^[0-9]+$ ]]; then
  echo "Raw gh pr create output:" >&2
  echo "$SYNC_URL" >&2
  err "Failed to parse PR number from gh pr create output."
fi

echo "  Opened sync PR #$SYNC_PR: $SYNC_URL — merging..."
gh pr merge "$SYNC_PR" --repo "$REPO" --merge --delete-branch

ok "develop is now in sync with main."

echo "  Checking out updated develop and cleaning up local sync branch..."
git checkout develop
git pull --ff-only origin develop || err "develop has diverged after sync merge. Resolve manually."
if git show-ref --verify --quiet "refs/heads/$SYNC_BRANCH"; then
  git branch -D "$SYNC_BRANCH" || err "Failed to delete local sync branch $SYNC_BRANCH. Please delete it manually."
  ok "Local develop is up to date and sync branch cleaned up."
else
  ok "Local develop is up to date (no local sync branch to clean up)."
fi
