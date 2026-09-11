#!/usr/bin/env bash
# Type-check the function-hooks module against the declarations of the Claude
# Code build installed right now.
#
# Run it before touching hooks/lcm-hooks.ts, and again after a Claude Code
# update: the plugin API is early access, so a green run is also the answer to
# "did this release move anything the module stands on".
set -euo pipefail

TYPES="${HOOKS_TYPES:-.claude/types/claude-code.d.ts}"

if [ ! -f "$TYPES" ]; then
  echo "Missing $TYPES."
  echo "The declarations are written from the running build and are not committed."
  echo "Generate them by running /plugin-types in a Claude Code session, then run this again."
  exit 1
fi

header=$(head -1 "$TYPES" | sed 's|^// ||')
echo "Types written by: $header"

# The check is only worth what the declarations are worth. They state the API of
# the build that wrote them, so against a newer build they describe methods that
# may no longer exist and this script agrees with them — which is how a rename
# reached a session green. Compare, and refuse rather than reassure.
# Ends on a digit: the header is a sentence, so the version is followed by a full
# stop that would otherwise be read as part of it and never match a bare version.
declared=$(printf '%s' "$header" | sed -n 's|.*Claude Code \([0-9][0-9.]*[0-9]\).*|\1|p')
running=$(claude --version 2>/dev/null | sed -n 's|^\([0-9][0-9.]*\).*|\1|p' || true)

if [ -z "$running" ]; then
  # No Claude Code here — CI, or a machine without it. The type-check still says
  # something about the module; it just cannot say the declarations are current.
  echo "No Claude Code on PATH: cannot confirm the declarations match a running build."
elif [ -z "$declared" ]; then
  echo "$TYPES has no version in its header; cannot confirm it matches Claude Code $running."
elif [ "$declared" != "$running" ]; then
  echo "Declarations are from Claude Code $declared, but $running is installed."
  echo "The plugin API is early access and moves between releases, so this check would"
  echo "hold hooks/ to an API that may no longer exist."
  echo "Run /plugin-types in a Claude Code session, then run this again."
  exit 1
fi

npx tsc -p tsconfig.hooks.json
echo "hooks/ type-checks clean against this build."
