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

REPO="lossless-claude/lcm"
SYNC_BRANCH="chore/sync-develop-v$VERSION"

err() { echo ""; echo "✗ ERROR: $*" >&2; exit 1; }
ok()  { echo "  ✓ $*"; }

echo ""
echo "━━━ Sync develop←main after v$VERSION release ━━━"

git checkout develop
git pull origin develop
git fetch origin main

BEHIND=$(git rev-list --count develop..origin/main)
if [[ "$BEHIND" -eq 0 ]]; then
  ok "develop is already up to date with main — nothing to sync."
  exit 0
fi

echo "  develop is $BEHIND commit(s) behind main — merging..."
git merge origin/main --no-edit

# develop is branch-protected — open a PR
if git rev-parse --verify "origin/$SYNC_BRANCH" >/dev/null 2>&1; then
  err "Branch $SYNC_BRANCH already exists on remote. Has the sync PR already been opened?"
fi

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
