#!/usr/bin/env bash
# lcm-release — full end-to-end release script
#
# Usage:
#   ./release.sh <version>               Run all steps (0-9)
#   ./release.sh <version> --from-step N Resume from step N after a failure
#
# Steps:
#   0  Clean state + sync develop←main
#   1  Guard: verify tag and npm version are free
#   2  Create release branch
#   3  Bump all 3 version files + verify
#   4  Commit and push
#   5  Open PR targeting main
#   6  Wait for CI
#   7  Merge release PR
#   8  Wait for publish.yml
#   9  Sync develop with main via PR
set -euo pipefail

# ─── Args ────────────────────────────────────────────────────────────────────
VERSION=""
FROM_STEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-step)
      FROM_STEP="${2:-}"
      [[ -z "$FROM_STEP" ]] && { echo "--from-step requires a number (0-9)"; exit 1; }
      if ! [[ "$FROM_STEP" =~ ^[0-9]$ ]]; then
        echo "Invalid --from-step '$FROM_STEP'; must be an integer between 0 and 9."
        echo "Usage: $0 <version> [--from-step N]"
        exit 1
      fi
      shift 2
      ;;
    --from-step=*)
      FROM_STEP="${1#*=}"
      if ! [[ "$FROM_STEP" =~ ^[0-9]$ ]]; then
        echo "Invalid --from-step '$FROM_STEP'; must be an integer between 0 and 9."
        echo "Usage: $0 <version> [--from-step N]"
        exit 1
      fi
      shift
      ;;
    -*)
      echo "Unknown flag: $1"; exit 1
      ;;
    *)
      VERSION="$1"
      shift
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version> [--from-step N]"
  echo "       $0 0.4.2"
  echo "       $0 0.4.2 --from-step 8   # resume after publish.yml failure"
  exit 1
fi

# ─── Helpers ─────────────────────────────────────────────────────────────────
REPO="lossless-claude/lcm"
RELEASE_BRANCH="release/v$VERSION"
SYNC_BRANCH="chore/sync-develop-v$VERSION"
PACKAGE_NAME=$(node -p "require('./package.json').name")

err()    { echo ""; echo "✗ ERROR: $*" >&2; exit 1; }
step()   { echo ""; echo "━━━ $* ━━━"; }
ok()     { echo "  ✓ $*"; }
skip()   { echo "  (skipping — already past this step)"; }
run_step() { [[ "$1" -ge "$FROM_STEP" ]]; }  # true if step N should run

# When resuming mid-flow, look up state we would have captured earlier.
PR_NUMBER=""
if [[ "$FROM_STEP" -ge 6 && "$FROM_STEP" -le 7 ]]; then
  PR_NUMBER=$(gh pr list --repo "$REPO" --base main --head "$RELEASE_BRANCH" \
    --state open --json number --jq '.[0].number' 2>/dev/null || true)
  [[ -z "$PR_NUMBER" || "$PR_NUMBER" == "null" ]] && \
    err "Resuming from step $FROM_STEP but no open PR found from $RELEASE_BRANCH → main. Has it already been merged? Use --from-step 8 or --from-step 9."
  echo "  Resuming: found PR #$PR_NUMBER"
fi

# ─── STEP 0: Clean state and develop sync ────────────────────────────────────
if run_step 0; then
  step "Step 0 — Clean state"

  [[ "$(git rev-parse --abbrev-ref HEAD)" != "develop" ]] && git checkout develop
  git pull origin develop

  [[ -n "$(git status --porcelain)" ]] && \
    err "Working tree is dirty. Commit or stash changes first."
  ok "Working tree is clean."

  git fetch origin
  BEHIND=$(git rev-list --count develop..origin/main)
  if [[ "$BEHIND" -gt 0 ]]; then
    echo "  develop is $BEHIND commit(s) behind main — syncing before release..."
    git merge origin/main --no-edit --ff-only 2>/dev/null || \
      err "develop has diverged from main and cannot be fast-forwarded. Resolve manually."

    PRE_BRANCH="chore/sync-develop-pre-v$VERSION"
    git checkout -b "$PRE_BRANCH"
    git push -u origin "$PRE_BRANCH"
    PRE_URL=$(gh pr create \
      --repo "$REPO" \
      --base develop \
      --title "chore: sync develop with main before v$VERSION release" \
      --body "Pre-release sync: brings develop up to date with main.")
    PRE_PR=$(echo "$PRE_URL" | grep -o '[0-9]*$')
    echo "  Opened pre-release sync PR #$PRE_PR — merging..."
    gh pr merge "$PRE_PR" --repo "$REPO" --merge
    git checkout develop && git pull origin develop
    ok "develop synced with main."
  else
    ok "develop is up to date with main."
  fi
else
  step "Step 0 — Clean state"; skip
fi

# ─── STEP 1: Guard ───────────────────────────────────────────────────────────
if run_step 1; then
  step "Step 1 — Guard: check v$VERSION is available"
  git fetch --tags

  git rev-parse --verify "refs/tags/v$VERSION" >/dev/null 2>&1 && \
    err "Tag v$VERSION already exists. Choose a higher version. Never delete tags on a public package."
  ok "Git tag v$VERSION is free."

  npm view "$PACKAGE_NAME@$VERSION" version >/dev/null 2>&1 && \
    err "$VERSION is already published to npm for $PACKAGE_NAME. Choose a higher version."
  ok "npm $PACKAGE_NAME@$VERSION is free."
else
  step "Step 1 — Guard"; skip
fi

# ─── STEP 2: Release branch ──────────────────────────────────────────────────
if run_step 2; then
  step "Step 2 — Create release branch"
  git rev-parse --verify "$RELEASE_BRANCH" >/dev/null 2>&1 && \
    err "Branch $RELEASE_BRANCH already exists. Delete it or choose a different version."
  git checkout -b "$RELEASE_BRANCH"
  ok "On branch $RELEASE_BRANCH."
else
  step "Step 2 — Create release branch"; skip
  git checkout "$RELEASE_BRANCH" 2>/dev/null || \
    err "Cannot resume: branch $RELEASE_BRANCH not found locally. Run without --from-step to start fresh."
fi

# ─── STEP 3: Bump all three version files ────────────────────────────────────
if run_step 3; then
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

  V1=$(node -p "require('./package.json').version")
  V2=$(node -p "require('./.claude-plugin/plugin.json').version")
  V3=$(node -p "require('./.claude-plugin/marketplace.json').plugins[0].version")
  [[ "$V1" != "$VERSION" || "$V2" != "$VERSION" || "$V3" != "$VERSION" ]] && \
    err "Version mismatch after bump! package.json=$V1  plugin.json=$V2  marketplace.json=$V3"
  ok "All three files verified at $VERSION."
else
  step "Step 3 — Bump version files"; skip
fi

# ─── STEP 4: Commit and push ─────────────────────────────────────────────────
if run_step 4; then
  step "Step 4 — Commit and push"
  git add package.json package-lock.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
  git commit -m "chore: bump version to $VERSION"
  git push -u origin "$RELEASE_BRANCH"
  ok "Pushed $RELEASE_BRANCH."
else
  step "Step 4 — Commit and push"; skip
fi

# ─── STEP 5: Open PR to main ─────────────────────────────────────────────────
if run_step 5; then
  step "Step 5 — Open PR targeting main"
  PR_URL=$(gh pr create \
    --repo "$REPO" \
    --base main \
    --title "chore: release v$VERSION" \
    --body "Version bump to $VERSION.")
  PR_NUMBER=$(echo "$PR_URL" | grep -o '[0-9]*$')
  ok "PR #$PR_NUMBER created: $PR_URL"
else
  step "Step 5 — Open PR targeting main"; skip
fi

# ─── STEP 6: Wait for CI ─────────────────────────────────────────────────────
if run_step 6; then
  step "Step 6 — Wait for CI"
  if gh pr checks "$PR_NUMBER" --watch 2>/dev/null; then
    ok "CI green."
  else
    echo "  (No CI checks configured — skipping.)"
  fi
else
  step "Step 6 — Wait for CI"; skip
fi

# ─── STEP 7: Merge release PR ────────────────────────────────────────────────
if run_step 7; then
  step "Step 7 — Merge release PR #$PR_NUMBER"
  gh pr merge "$PR_NUMBER" --repo "$REPO" --merge
  ok "PR #$PR_NUMBER merged to main."
else
  step "Step 7 — Merge release PR"; skip
fi

# ─── STEP 8: Wait for publish.yml ────────────────────────────────────────────
if run_step 8; then
  step "Step 8 — Wait for publish.yml"
  echo "  Waiting for workflow to appear..."
  sleep 8

  RUN_ID=$(gh run list --repo "$REPO" --workflow publish.yml --limit 1 \
    --json databaseId --jq '.[0].databaseId')
  [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]] && \
    err "Could not find a publish.yml run. Check https://github.com/$REPO/actions manually."

  echo "  Watching run $RUN_ID..."
  gh run watch "$RUN_ID" --repo "$REPO"

  CONCLUSION=$(gh run view "$RUN_ID" --repo "$REPO" --json conclusion --jq '.conclusion')
  if [[ "$CONCLUSION" == "skipped" ]]; then
    err "publish.yml was skipped — tag or npm version already exists. Pick a higher version and start over."
  fi
  [[ "$CONCLUSION" != "success" ]] && \
    err "publish.yml $CONCLUSION. See https://github.com/$REPO/actions/runs/$RUN_ID"
  ok "$PACKAGE_NAME@$VERSION published to npm."
else
  step "Step 8 — Wait for publish.yml"; skip
fi

# ─── STEP 9: Sync develop with main ──────────────────────────────────────────
if run_step 9; then
  step "Step 9 — Sync develop with main"
  bash "$(dirname "$0")/sync-develop.sh" "$VERSION"
else
  step "Step 9 — Sync develop"; skip
fi

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓  $PACKAGE_NAME@$VERSION released successfully"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
