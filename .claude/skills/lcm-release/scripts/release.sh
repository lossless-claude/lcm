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

# Validate version is semver (fail fast, also guards node interpolation)
SEMVER_REGEX='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
if ! [[ "$VERSION" =~ $SEMVER_REGEX ]]; then
  echo "Invalid version '$VERSION'. Expected semver like '0.4.2' or '1.2.3-beta.1'."
  echo "Usage: $0 <version> [--from-step N]"
  exit 1
fi

# ─── Repo root ───────────────────────────────────────────────────────────────
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || \
  { echo "✗ ERROR: Not inside a git repository."; exit 1; }
cd "$REPO_ROOT"

# ─── Helpers ─────────────────────────────────────────────────────────────────
REPO="lossless-claude/lcm"
RELEASE_BRANCH="release/v$VERSION"
PACKAGE_NAME=$(node -p "require('./package.json').name")

err()    { echo ""; echo "✗ ERROR: $*" >&2; exit 1; }
step()   { echo ""; echo "━━━ $* ━━━"; }
ok()     { echo "  ✓ $*"; }
skip()   { echo "  (skipping — already past this step)"; }
run_step() { [[ "$1" -ge "$FROM_STEP" ]]; }  # true if step N should run

# When resuming mid-flow, look up state we would have captured earlier.
PR_NUMBER=""
MERGE_SHA=""
if [[ "$FROM_STEP" -ge 6 && "$FROM_STEP" -le 7 ]]; then
  PR_NUMBER=$(gh pr list --repo "$REPO" --base main --head "$RELEASE_BRANCH" \
    --state open --json number --jq '.[0].number' 2>/dev/null || true)
  [[ -z "$PR_NUMBER" || "$PR_NUMBER" == "null" ]] && \
    err "Resuming from step $FROM_STEP but no open PR found from $RELEASE_BRANCH → main. Has it already been merged? Use --from-step 8 or --from-step 9."
  echo "  Resuming: found PR #$PR_NUMBER"
fi
if [[ "$FROM_STEP" -eq 8 ]]; then
  MERGE_SHA=$(gh pr list --repo "$REPO" --base main --head "$RELEASE_BRANCH" \
    --state merged --json mergeCommit --jq '.[0].mergeCommit.oid' 2>/dev/null || true)
  [[ -z "$MERGE_SHA" || "$MERGE_SHA" == "null" ]] && \
    err "Resuming from step 8 but could not find merge commit for $RELEASE_BRANCH → main. Has the PR been merged? Check https://github.com/$REPO manually."
  echo "  Resuming: found merge commit $MERGE_SHA"
fi

# ─── STEP 0: Clean state and develop sync ────────────────────────────────────
if run_step 0; then
  step "Step 0 — Clean state"

  [[ -n "$(git status --porcelain)" ]] && \
    err "Working tree is dirty. Commit or stash changes first."
  ok "Working tree is clean."

  [[ "$(git rev-parse --abbrev-ref HEAD)" != "develop" ]] && git checkout develop
  git pull --ff-only origin develop || err "develop has diverged from origin/develop. Resolve manually before running the release."

  git fetch origin
  BEHIND=$(git rev-list --count develop..origin/main)
  if [[ "$BEHIND" -gt 0 ]]; then
    echo "  develop is $BEHIND commit(s) behind main — syncing before release..."

    PRE_BRANCH="chore/sync-develop-pre-v$VERSION"
    if git show-ref --verify --quiet "refs/heads/$PRE_BRANCH"; then
      err "Local branch '$PRE_BRANCH' already exists. Delete it (git branch -D \"$PRE_BRANCH\") or choose a different version, then rerun."
    fi
    if git ls-remote --exit-code --heads origin "$PRE_BRANCH" >/dev/null 2>&1; then
      err "Remote branch 'origin/$PRE_BRANCH' already exists. Delete it (git push origin --delete \"$PRE_BRANCH\") or choose a different version, then rerun."
    fi

    git checkout -b "$PRE_BRANCH"
    git merge origin/main --no-edit --ff-only 2>/dev/null || \
      err "develop has diverged from main and cannot be fast-forwarded. Resolve manually."

    git push -u origin "$PRE_BRANCH"
    PRE_PR=$(gh pr create \
      --repo "$REPO" \
      --base develop \
      --title "chore: sync develop with main before v$VERSION release" \
      --body "Pre-release sync: brings develop up to date with main." \
      --json number --jq '.number')
    echo "  Opened pre-release sync PR #$PRE_PR — merging..."
    gh pr merge "$PRE_PR" --repo "$REPO" --merge --yes --delete-branch
    git checkout develop
    git pull --ff-only origin develop || err "develop diverged after pre-release sync merge. Resolve manually."
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

  NPM_STATUS=0
  NPM_OUT=$(npm view "$PACKAGE_NAME@$VERSION" version 2>&1) || NPM_STATUS=$?
  if [[ "$NPM_STATUS" -eq 0 ]]; then
    err "$VERSION is already published to npm for $PACKAGE_NAME. Choose a higher version."
  elif echo "$NPM_OUT" | grep -qiE 'E404|404 Not Found'; then
    ok "npm $PACKAGE_NAME@$VERSION is free."
  else
    err "Failed to query npm for $PACKAGE_NAME@$VERSION: $NPM_OUT"
  fi
else
  step "Step 1 — Guard"; skip
fi

# ─── STEP 2: Release branch ──────────────────────────────────────────────────
if run_step 2; then
  step "Step 2 — Create release branch"
  git fetch origin "$RELEASE_BRANCH" >/dev/null 2>&1 || true
  if git rev-parse --verify "$RELEASE_BRANCH" >/dev/null 2>&1 || \
     git ls-remote --exit-code --heads origin "$RELEASE_BRANCH" >/dev/null 2>&1; then
    err "Branch $RELEASE_BRANCH already exists locally or on origin. Delete it or choose a different version."
  fi
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
  const s = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, s.replace(/\"version\":\s*\"[^\"]*\"/, '\"version\": \"$VERSION\"'));
  "
  ok "plugin.json → $VERSION"

  node -e "
  const fs = require('fs');
  const p = '.claude-plugin/marketplace.json';
  const s = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(p, s.replace(/\"version\":\s*\"[^\"]*\"/, '\"version\": \"$VERSION\"'));
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
  if git diff --cached --quiet; then
    ok "No staged changes to commit; skipping git commit."
  else
    git commit -m "chore: bump version to $VERSION"
  fi
  git push -u origin "$RELEASE_BRANCH"
  ok "Pushed $RELEASE_BRANCH."
else
  step "Step 4 — Commit and push"; skip
fi

# ─── STEP 5: Open PR to main ─────────────────────────────────────────────────
if run_step 5; then
  step "Step 5 — Open PR targeting main"
  PR_JSON=$(gh pr create \
    --repo "$REPO" \
    --base main \
    --title "chore: release v$VERSION" \
    --body "Version bump to $VERSION." \
    --json number,url)
  PR_NUMBER=$(node -pe "JSON.parse(process.argv[1]).number" "$PR_JSON")
  PR_URL=$(node -pe "JSON.parse(process.argv[1]).url" "$PR_JSON")
  if [[ -z "$PR_NUMBER" || ! "$PR_NUMBER" =~ ^[0-9]+$ || -z "$PR_URL" ]]; then
    echo "Raw gh pr create output:" >&2
    echo "$PR_JSON" >&2
    err "Failed to parse PR number/url from gh output."
  fi
  ok "PR #$PR_NUMBER created: $PR_URL"
else
  step "Step 5 — Open PR targeting main"; skip
fi

# ─── STEP 6: Wait for CI ─────────────────────────────────────────────────────
if run_step 6; then
  step "Step 6 — Wait for CI"
  if gh pr checks "$PR_NUMBER" --repo "$REPO" --watch; then
    ok "CI green."
  else
    if CHECK_COUNT=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json statusCheckRollup --jq '.statusCheckRollup | length' 2>/dev/null); then
      if [[ "$CHECK_COUNT" -eq 0 ]]; then
        echo "  (No CI checks configured — skipping.)"
      else
        err "CI checks did not pass ($CHECK_COUNT configured). Inspect the PR and rerun with --from-step 6 when resolved."
      fi
    else
      err "Failed to query CI checks for PR #$PR_NUMBER. Verify GitHub CLI auth/network and rerun with --from-step 6 when resolved."
    fi
  fi
else
  step "Step 6 — Wait for CI"; skip
fi

# ─── STEP 7: Merge release PR ────────────────────────────────────────────────
if run_step 7; then
  step "Step 7 — Merge release PR #$PR_NUMBER"
  gh pr merge "$PR_NUMBER" --repo "$REPO" --merge --yes --delete-branch
  MERGE_SHA=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json mergeCommit --jq '.mergeCommit.oid')
  [[ -z "$MERGE_SHA" || "$MERGE_SHA" == "null" ]] && \
    err "Could not determine merge commit SHA for PR #$PR_NUMBER. Check https://github.com/$REPO/pull/$PR_NUMBER."
  ok "PR #$PR_NUMBER merged to main (commit $MERGE_SHA)."
else
  step "Step 7 — Merge release PR"; skip
fi

# ─── STEP 8: Wait for publish.yml ────────────────────────────────────────────
if run_step 8; then
  step "Step 8 — Wait for publish.yml"

  # Use the exact merge commit SHA (not main HEAD, which may advance before we query it).
  [[ -z "$MERGE_SHA" || "$MERGE_SHA" == "null" ]] && \
    err "MERGE_SHA not set — internal error. Re-run from step 7."
  echo "  Waiting for publish.yml run for commit $MERGE_SHA..."

  RUN_ID=""
  WAIT_SECS=0
  MAX_WAIT=${PUBLISH_MAX_WAIT:-900}
  while [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; do
    if [[ "$WAIT_SECS" -ge "$MAX_WAIT" ]]; then
      err "publish.yml run not found after ${MAX_WAIT}s. Check https://github.com/$REPO/actions manually."
    fi
    sleep 5
    WAIT_SECS=$((WAIT_SECS + 5))
    RUN_ID=$(gh run list --repo "$REPO" --workflow publish.yml --branch main --limit 20 \
      --json databaseId,headSha \
      --jq "map(select(.headSha == \"$MERGE_SHA\")) | .[0].databaseId // empty")
  done

  echo "  Watching run $RUN_ID..."
  gh run watch "$RUN_ID" --repo "$REPO" || true

  CONCLUSION=$(gh run view "$RUN_ID" --repo "$REPO" --json conclusion --jq '.conclusion')
  if [[ "$CONCLUSION" == "skipped" ]]; then
    err "publish.yml was skipped — tag or npm version already exists. Pick a higher version and start over."
  fi
  [[ "$CONCLUSION" != "success" ]] && \
    err "publish.yml $CONCLUSION. See https://github.com/$REPO/actions/runs/$RUN_ID"

  # Verify publish actually landed — workflow conclusion can be 'success' even
  # when individual steps were skipped via if: guards.
  PUBLISHED_VERSION=$(npm view "$PACKAGE_NAME@$VERSION" version 2>/dev/null || true)
  if [[ "$PUBLISHED_VERSION" != "$VERSION" ]]; then
    err "publish.yml succeeded but $PACKAGE_NAME@$VERSION was not found on npm. Check https://github.com/$REPO/actions/runs/$RUN_ID and npm manually."
  fi
  git fetch --tags
  if ! git rev-parse --verify "refs/tags/v$VERSION" >/dev/null 2>&1; then
    err "publish.yml succeeded but git tag v$VERSION was not found on origin. Check https://github.com/$REPO/actions/runs/$RUN_ID."
  fi
  ok "$PACKAGE_NAME@$VERSION published to npm and tagged."
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
