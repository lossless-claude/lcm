# Troubleshooting

## Quick diagnosis

Run these two commands to get a complete picture:

```bash
# Current installation health
lcm doctor

# Historical issues from recent sessions
lcm diagnose
```

Or from within a Claude Code session: `/lcm-doctor` and `/lcm-diagnose`.

## Common issues

### Hooks not firing

**Symptoms:** No context restored at session start, no memory search on prompts, native compaction instead of DAG compaction.

**Diagnosis:**
```bash
lcm doctor    # Check "Hooks" section
```

**Fixes:**
1. Run `lcm install` to re-register hooks
2. Verify the node binary path in `~/.claude/settings.json` exists
3. Restart Claude Code after fixing hooks

**Note:** Hooks auto-heal — if any single hook fires successfully, it repairs all 6 hook registrations automatically.

### Daemon not running

**Symptoms:** MCP tools return errors, hooks fail silently, no memory operations.

**Diagnosis:**
```bash
lcm status
```

**Fixes:**
```bash
lcm daemon start --detach
```

If the daemon won't start, check for port conflicts or stale PID files:
```bash
cat ~/.lossless-claude/daemon.pid
rm -f ~/.lossless-claude/daemon.pid
lcm daemon start --detach
```

### MCP server disconnected

**Symptoms:** `lcm_search`, `lcm_store`, and other MCP tools are unavailable in the session.

**Fix:** Restart the Claude Code session. The MCP server reconnects on session start. After restarting, run `/lcm-doctor` to verify.

### No results from search

**Possible causes:**
- No sessions have been imported yet — run `/lcm-import`
- Sessions were imported but not compacted — run `/lcm-compact`
- The query doesn't match any content — try `/lcm-stats` to check what's stored, then try different keywords with `lcm_grep`

### Summarizer failing

**Symptoms:** Compaction runs but produces no summaries, or summaries are empty.

**Diagnosis:**
```bash
lcm doctor    # Check "Summarizer" section
```

**Possible causes:**
- `LCM_SUMMARY_PROVIDER=disabled` — enable a provider
- API key not set — set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
- Model quota exceeded — check your API dashboard

### Missing sessions

**Symptoms:** Some conversations aren't searchable in memory.

**Fix:**
```bash
# Import missing sessions
lcm import --verbose

# Check for specific gaps
lcm diagnose --all --days 30
```

### PreCompact hook timeout

**Symptoms:** Context compaction falls back to native (no DAG summary), or hook takes too long.

**Possible causes:**
- Daemon is slow to respond — check `lcm status`
- Bootstrap is running during compact — this was fixed in v0.7.0+ (compact now skips bootstrap)
- Network latency to summarizer API — check provider response times

### Database issues

**Symptoms:** Errors mentioning SQLite, database locked, or corruption.

**Fixes:**
```bash
# Check integrity
sqlite3 ~/.claude/lcm.db "PRAGMA integrity_check;"

# Backup and start fresh if needed
cp ~/.claude/lcm.db ~/.claude/lcm.db.backup
```

### FTS5 not available

**Symptoms:** Search falls back to slower LIKE-based queries. Not a critical issue — everything still works.

The Node.js runtime running Claude Code needs SQLite compiled with FTS5. See [fts5.md](fts5.md) for instructions on building an FTS5-capable Node.js.

## Error messages

| Error | Cause | Fix |
|-------|-------|-----|
| `Daemon not running` | Background daemon isn't active | `lcm daemon start --detach` |
| `MCP server disconnected` | Session lost connection to MCP | Restart Claude Code session |
| `No results` | Empty database or no matching content | Run `/lcm-import` then `/lcm-compact` |
| `Node not found on expand` | Invalid summary node ID | Use `lcm_search` to find correct nodeId |
| `Connection refused on port 3737` | Daemon port conflict or not started | Check `lcm status`, restart daemon |
| `Summarizer returned empty response` | LLM failed to generate summary | Check API key and model availability |

## Getting help

1. Run `/lcm-doctor` for a full diagnostic report
2. Run `/lcm-diagnose --verbose` for historical issue analysis
3. Run `/lcm-dogfood` for a comprehensive self-test (39 checks)
4. Check daemon logs at `~/.lossless-claude/daemon.log`
