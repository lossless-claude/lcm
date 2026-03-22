# Claude Code Hook Protocol — Verified Schemas

## PreCompact Hook

**Status:** ⚠️ Pending verification via probe-precompact.ts

Expected fields (unverified):
- `session_id` — session identifier
- `transcript_path` — path to session JSONL transcript (C1: unverified)
- `cwd` — working directory
- `hook_event_name` — "PreCompact"

### How to verify (C1)

1. Add to `~/.claude/settings.json` hooks:
   ```json
   "PreCompact": [{ "type": "command", "command": "node /path/to/src/hooks/probe-precompact.ts" }]
   ```
2. Start Claude Code, trigger compaction (use `/compact` command or fill context)
3. Check `~/.lossless-claude/precompact-probe.json`
4. Update this file with verified schema

## SessionStart Hook

**Status:** ⚠️ Pending verification via probe-sessionstart.ts

Expected fields:
- `session_id`
- `cwd`
- `hook_event_name` — "SessionStart"
- `source` — "startup" | "resume" | "compact" (C3: verify "compact" exists)

### How to verify (C3)

1. Add to `~/.claude/settings.json` hooks:
   ```json
   "SessionStart": [{ "type": "command", "command": "node /path/to/src/hooks/probe-sessionstart.ts" }]
   ```
2. Trigger compaction, then observe the next SessionStart event
3. Check `~/.lossless-claude/sessionstart-probe.jsonl` for `source` values
4. Update this file with verified schema
