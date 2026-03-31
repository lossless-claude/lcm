#!/usr/bin/env bash
set -euo pipefail

# harvest-themes.sh — Goodhart-safe file targeting for theme-aware experiments
#
# Outputs JSON lines: {"path":"...","reason":"..."}
# NEVER outputs metric names — experimenter must remain blind to scoring.
#
# Usage: bash scripts/harvest-themes.sh <theme> [project_root]

THEME="${1:-}"
PROJECT_ROOT="${2:-.}"

case "$THEME" in
  test_coverage)
    # Find source files with no corresponding test file
    {
      find "$PROJECT_ROOT/scripts" -name "*.sh" 2>/dev/null
      find "$PROJECT_ROOT/skills" -name "*.sh" 2>/dev/null
    } | while read -r f; do
      basename=$(basename "$f" .sh)
      if ! find "$PROJECT_ROOT/test" -name "*${basename}*" 2>/dev/null | grep -q .; then
        printf '{"path":"%s","reason":"no test file found for this script"}\n' "$f"
      fi
    done
    ;;

  skill_quality)
    # Find SKILL.md files that are short (less thorough)
    find "$PROJECT_ROOT/skills" -name "SKILL.md" 2>/dev/null | while read -r f; do
      lines=$(wc -l < "$f" | tr -d ' ')
      if [ "$lines" -lt 50 ]; then
        printf '{"path":"%s","reason":"skill file is only %s lines — could be more thorough"}\n' "$f" "$lines"
      fi
    done
    ;;

  agent_prompts)
    # Find agent markdown files missing key structural sections
    find "$PROJECT_ROOT/agents" -name "*.md" 2>/dev/null | while read -r f; do
      missing=""
      grep -qi "when to use\|description:" "$f" || missing="${missing}description,"
      grep -qi "constraints\|guardrails\|important" "$f" || missing="${missing}constraints,"
      if [ -n "$missing" ]; then
        printf '{"path":"%s","reason":"missing sections: %s"}\n' "$f" "${missing%,}"
      fi
    done
    ;;

  command_docs)
    # Find command docs that are very short
    find "$PROJECT_ROOT/commands" -name "*.md" 2>/dev/null | while read -r f; do
      lines=$(wc -l < "$f" | tr -d ' ')
      if [ "$lines" -lt 20 ]; then
        printf '{"path":"%s","reason":"command doc is only %s lines"}\n' "$f" "$lines"
      fi
    done
    ;;

  *)
    # Unknown theme — no focus files (experimenter gets full autonomy)
    ;;
esac
