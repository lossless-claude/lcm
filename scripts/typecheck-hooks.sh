#!/usr/bin/env bash
# Type-check the function-hooks module against the declarations of the Claude
# Code build installed right now.
#
# Run it before touching hooks/lcm-hooks.ts, and again after a Claude Code
# update: the plugin API is early access, so a green run is also the answer to
# "did this release move anything the module stands on".
set -euo pipefail

TYPES=".claude/types/claude-code.d.ts"

if [ ! -f "$TYPES" ]; then
  echo "Missing $TYPES."
  echo "The declarations are written from the running build and are not committed."
  echo "Generate them by running /plugin-types in a Claude Code session, then run this again."
  exit 1
fi

echo "Types written by: $(head -1 "$TYPES" | sed 's|^// ||')"
npx tsc -p tsconfig.hooks.json
echo "hooks/ type-checks clean against this build."
