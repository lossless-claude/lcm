# Blocking Migration Gate for Hook Duplicates

## Problem
Upgrading from binary-based install (hooks in `settings.json`) to plugin-based system (hooks in `plugin.json`) leaves stale hooks firing in duplicate. Users discover this only via `lcm diagnose`.

## Solution: Auto-Healing SessionStart Hook
The `restore` hook (SessionStart) detects and self-heals duplicate hook entries before proceeding:

1. **Detection**: Check `settings.json` for REQUIRED_HOOKS entries (lcm restore, lcm compact, etc.)
2. **Cleanup**: Call `mergeClaudeSettings()` to strip legacy hooks from settings.json
3. **Rewrite**: Atomically persist cleaned settings.json
4. **Signal**: Return special exit code or stderr message so Claude Code logs "Migration completed"

## How It Works
```typescript
// In restore.ts handleSessionStart()
const { existsSync, readFileSync, writeFileSync } = require('fs');
const settingsPath = join(homedir(), '.claude', 'settings.json');

if (existsSync(settingsPath)) {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  const cleaned = mergeClaudeSettings(settings);

  // Detect duplicates: REQUIRED_HOOKS present in settings.json?
  const hasDuplicates = REQUIRED_HOOKS.some(({ event, command }) => {
    return settings.hooks?.[event]?.some((e: any) =>
      e.hooks?.some((h: any) => h.command === command)
    );
  });

  if (hasDuplicates && JSON.stringify(settings) !== JSON.stringify(cleaned)) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(cleaned, null, 2));
    // Signal cleanup: write to stdout or return specific exit code
    const msg = `<lcm-migration>Removed duplicate hooks from ~/.claude/settings.json</lcm-migration>`;
    stdout = msg + '\n' + stdout; // Prepend to existing restore output
  }
}
```

## Pros
- **Zero user friction**: Fixes on first session after upgrade
- **Idempotent**: Re-running `mergeClaudeSettings()` is safe and tested
- **Isolated**: Hook mutation is confined to single SessionStart call
- **Observable**: Claude Code can parse `<lcm-migration>` tag to log action

## Cons
- **File I/O in hook**: Mutates user's `settings.json` during hook execution (rare but non-zero risk if process dies mid-write)
- **Silent heal**: Users won't see notification unless stdout is parsed
- **Migration logic duplication**: Cleanup logic already exists in `bootstrap.ts` and `auto-heal.ts`

## Tradeoffs
- **Effort**: 3/5 (reuse existing `mergeClaudeSettings`, add dupcheck + file write)
- **Reliability**: 4/5 (atomic writes via writeFileSync; mergeClaudeSettings is proven)
- **User Impact**: 5/5 (self-heals without user intervention or error messages)

## Alternative: Warn Instead of Auto-Heal
Return exit code 42 + stderr message to signal presence of duplicates. User sees warning in Claude Code and runs `lcm doctor --fix` manually.
- **Pros**: No file mutation from hook; explicit user action
- **Cons**: Users see error on every session; requires manual step; many won't run `doctor`

## Recommendation
**Implement auto-healing in restore.ts** with atomic file write and `<lcm-migration>` stdout tag. Test atomicity with process crash scenarios. Consider wrapping write in try-catch to fall back to warning if I/O fails.
