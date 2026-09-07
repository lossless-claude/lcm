#!/bin/sh
# Mirror the freshly built dist/ into the installed plugin cache, when present.
#
# The cache is a copy of dist/ made at install time and is never refreshed on
# rebuild, so the installed copy silently drifts from the checkout. Syncing it
# after every build keeps both reporting the same build fingerprint.
#
# Never fails the build: a missing cache directory is a no-op.
# Set LCM_SKIP_CACHE_SYNC=1 to skip.
set -e

if [ "$LCM_SKIP_CACHE_SYNC" = "1" ]; then exit 0; fi

cd "$(dirname "$0")/.."

version=$(node -p "require('./package.json').version" 2>/dev/null) || exit 0
[ -n "$version" ] || exit 0

target="$HOME/.claude/plugins/cache/lossless-claude/lcm/$version/dist"
[ -d "$target" ] || exit 0
[ -d dist ] || exit 0

rsync -a --delete dist/ "$target/"
echo "synced dist/ -> $target"
