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

echo ""
echo "━━━ Sync develop←main after v$VERSION release ━━━"

if [[ -n "$(git status --porcelain)" ]]; then
  err "Working tree is dirty. Commit or stash changes first."
fi

git checkout develop
git pull origin develop
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
  err "Branch $SYNC_BRANCH already exists on remote. Has the sync PR already been opened?"
fi

git checkout -b "$SYNC_BRANCH"
if ! git merge --ff-only origin/main; then
  err "Unable to fast-forward $SYNC_BRANCH to origin/main. Has develop diverged from main?"
fi
git push -u origin "$SYNC_BRANCH"

SYNC_JSON=$(gh pr create \
  --repo "$REPO" \
  --base develop \
  --title "chore: sync develop with main after v$VERSION release" \
  --body "Brings the v$VERSION release merge commit back into develop." \
  --json number,url)
SYNC_PR=$(node -pe "JSON.parse(process.argv[1]).number" "$SYNC_JSON")
SYNC_URL=$(node -pe "JSON.parse(process.argv[1]).url" "$SYNC_JSON")

if [[ -z "$SYNC_PR" || ! "$SYNC_PR" =~ ^[0-9]+$ ]]; then
  echo "Raw gh pr create output:" >&2
  echo "$SYNC_JSON" >&2
  err "Failed to parse PR number from gh pr create output."
fi

echo "  Opened sync PR #$SYNC_PR: $SYNC_URL — merging..."
gh pr merge "$SYNC_PR" --repo "$REPO" --merge

ok "develop synced with main."
