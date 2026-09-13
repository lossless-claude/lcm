#!/bin/sh
# Mirror the freshly built plugin artifact into the installed plugin cache, when present.
#
# The cache is a copy of the repository made at install time and is never refreshed
# on rebuild, so the installed copy silently drifts from the checkout. The plugin
# runs from bundle/ (built by `npm run build:bundle`) and hooks/, so those are what
# is mirrored; dist/ is the npm artifact and the plugin never loads it.
#
# Never fails the build: a missing cache directory or bundle is a no-op.
# Set LCM_SKIP_CACHE_SYNC=1 to skip.
set -e

if [ "$LCM_SKIP_CACHE_SYNC" = "1" ]; then exit 0; fi

# Best-effort: never fail the build.
[ -n "${HOME:-}" ] || exit 0
command -v rsync >/dev/null 2>&1 || exit 0

cd "$(dirname "$0")/.." || exit 0

version=$(node -p "require('./package.json').version" 2>/dev/null) || exit 0
[ -n "$version" ] || exit 0

target="$HOME/.claude/plugins/cache/lossless-claude/lcm/$version"
[ -d "$target" ] || exit 0

# Only build:bundle sets LCM_SYNC_BUNDLE: a plain build must not mirror a bundle/ it did not produce.
if [ -d bundle ] && [ "${LCM_SYNC_BUNDLE:-}" = 1 ]; then
  rsync -a --delete bundle/ "$target/bundle/" || { echo "sync-plugin-cache: rsync failed (ignored)" >&2; exit 0; }
  echo "synced bundle/ -> $target/bundle"
fi

# The function-hooks module is loaded from the plugin root, so it drifts the same way.
if [ -d hooks ]; then
  rsync -a --delete hooks/ "$target/hooks/" \
    || { echo "sync-plugin-cache: hooks rsync failed (ignored)" >&2; exit 0; }
  echo "synced hooks/ -> $target/hooks"
fi
