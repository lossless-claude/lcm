# lcm Dogfood — Detailed Check Reference

All 39 checks organized by phase. Each check includes the command to run and pass/fail criteria.

## Phase 1: Health — 3 checks

### 1.1 Daemon status
```bash
node dist/bin/lcm.js status
```
Pass if: daemon shows "up", project registered for current cwd, port 3737.

### 1.2 Doctor
```bash
node dist/bin/lcm.js doctor
```
Pass if: all checks pass (8 passed, 0 failed). Record any warnings.

### 1.3 Version
```bash
node dist/bin/lcm.js --version
```
Pass if: prints version string matching package.json.

## Phase 2: Import — 3 checks

### 2.1 Import session transcripts
```bash
node dist/bin/lcm.js import --all --verbose
```
Pass if: message count > 0, no errors. Use `ctx_execute` — output can be large.

### 2.2 Status after import
```bash
node dist/bin/lcm.js status
```
Pass if: messages > 0, last ingest timestamp updated.

### 2.3 Idempotent re-import
Run import again immediately.
Pass if: message count unchanged or only current-session messages added (small delta).

## Phase 3: Compact — 3 checks

### 3.1 Compact messages
```bash
node dist/bin/lcm.js compact --all --verbose
```
Pass if: summaries created, compression ratio reported. Note: calls LLM summarizer, may take minutes. Use 5-minute timeout.

### 3.2 Status after compact
```bash
node dist/bin/lcm.js status
```
Pass if: summaries > 0.

### 3.3 Idempotent re-compact
Run compact again immediately.
Pass if: no new summaries created.

## Phase 4: Promote — 2 checks

### 4.1 Promote insights
```bash
node dist/bin/lcm.js promote --all --verbose
```
Pass if: promoted count increments OR "no promotable content" (valid if summaries too short).

### 4.2 Stats
```bash
node dist/bin/lcm.js stats --verbose
```
Pass if: shows messages, summaries, promoted counts, compression ratios. Numbers consistent with previous checks.

## Phase 5: Sensitive Patterns — 5 checks

### 5.1 List patterns
```bash
node dist/bin/lcm.js sensitive list
```
Pass if: shows 7 built-in patterns.

### 5.2 Test scrubbing
```bash
node dist/bin/lcm.js sensitive test "my api key is sk-1234567890abcdefghij and password=hunter2"
```
Pass if: both API key and password are `[REDACTED]`.

### 5.3 Add custom pattern
```bash
node dist/bin/lcm.js sensitive add "DOGFOOD_SECRET_\w+"
```
Pass if: pattern added.

### 5.4 Test custom pattern
```bash
node dist/bin/lcm.js sensitive test "the value is DOGFOOD_SECRET_abc123"
```
Pass if: `DOGFOOD_SECRET_abc123` is `[REDACTED]`.

### 5.5 Remove custom pattern
```bash
node dist/bin/lcm.js sensitive remove "DOGFOOD_SECRET_\w+"
```
Pass if: pattern removed. Run `sensitive list` to confirm.

## Phase 6: Full Pipeline — 2 checks

### 6.1 Curate (import + compact + promote)
```bash
node dist/bin/lcm.js import --all && node dist/bin/lcm.js compact --all && node dist/bin/lcm.js promote --all
```
Pass if: all three stages complete without error.

### 6.2 Diagnose
```bash
node dist/bin/lcm.js diagnose --verbose
```
Pass if: no hook failures or ingestion gaps detected.

## Phase 7: Hook Verification — 6 checks

Hooks are registered in `.claude-plugin/plugin.json`, NOT `~/.claude/settings.json`.

### 7.1 Hook wiring in plugin.json
Read `.claude-plugin/plugin.json` and verify all 4 hooks:
- `SessionStart` → `lcm restore`
- `UserPromptSubmit` → `lcm user-prompt`
- `PreCompact` → `lcm compact`
- `SessionEnd` → `lcm session-end`

Pass if: all 4 present with correct commands.

### 7.2 SessionStart live test
```bash
echo '{}' | node dist/bin/lcm.js restore
```
Pass if: returns `<memory-orientation>` block.

### 7.3 UserPromptSubmit live test
```bash
node -e 'console.log(JSON.stringify({prompt:"what changes were made to the summarizer",cwd:process.cwd()}))' | node dist/bin/lcm.js user-prompt
```
Pass if: returns `<memory-context>` block with hints.
**Known issue (Bug 1):** Currently only searches promoted store. If empty, record as ⚠️ KNOWN.

### 7.4 UserPromptSubmit daemon endpoint
```bash
node .claude-plugin/skills/lcm-dogfood/scripts/prompt-search-test.js "summarizer"
```
Pass if: returns hints (may be empty — see Bug 1).

### 7.5 Hook timeout
```bash
time node -e 'console.log(JSON.stringify({prompt:"test",cwd:process.cwd()}))' | node dist/bin/lcm.js user-prompt
```
Pass if: completes in < 5 seconds.

### 7.6 SessionEnd wiring (read-only)
Cannot trigger without ending session. Verify wiring in plugin.json (covered by 7.1).

## Phase 8: MCP Tools — 8 checks

Call lcm MCP tools directly from the session.

### 8.1 lcm_doctor via MCP
Pass if: returns diagnostic results.

### 8.2 lcm_stats via MCP (verbose: true)
Pass if: returns stats with counts.

### 8.3 lcm_search (query: "summarizer")
Pass if: episodic results > 0.

### 8.4 lcm_grep (query: "compact", scope: "all")
Pass if: returns matching entries.

### 8.5 lcm_store (text: "dogfood test memory — <date>", tags: ["dogfood","test"])
Pass if: returns stored UUID.

### 8.6 lcm_search retrieval ("dogfood test memory")
Pass if: memory from 8.5 appears in results.

### 8.7 lcm_expand (nodeId from prior results)
Pass if: returns expanded content. ⚠️ SKIP if no summary IDs.

### 8.8 lcm_describe (same nodeId)
Pass if: returns metadata. ⚠️ SKIP if no node.

## Phase 9: Resilience — 3 checks

### 9.1 Kill daemon
```bash
pkill -f "lcm.*daemon" || true
sleep 1
node dist/bin/lcm.js status
```
Pass if: reports daemon down (no crash/hang).

### 9.2 Auto-recovery
```bash
node dist/bin/lcm.js daemon start --detach
sleep 2
node dist/bin/lcm.js status
```
Pass if: daemon back up.

### 9.3 Graceful degradation
Kill daemon, then:
```bash
timeout 10 sh -c 'node -e "console.log(JSON.stringify({prompt:\"test\",cwd:process.cwd()}))" | node dist/bin/lcm.js user-prompt'
```
Pass if: returns within 10s, no crash. Restart daemon after.

## Phase 10: Debug Diagnostics — 4 checks

### 10.1 Daemon logs
```bash
tail -50 ~/.lossless-claude/daemon.log
```
Pass if: no ERROR entries.

### 10.2 PWD matches cwd
```bash
echo "PWD=$PWD" && echo "cwd=$(pwd)"
```
Pass if: identical.

### 10.3 Project DB exists
```bash
ls -la ~/.lossless-claude/projects/*/lcm.db 2>/dev/null
```
Pass if: at least one .db file exists.

### 10.4 DB integrity
```bash
node .claude-plugin/skills/lcm-dogfood/scripts/db-integrity.js
```
Pass if: all DBs report "ok".
