# Hook Node Path Fix — Design Spec

**Issue:** lossless-claude/lcm#140
**Date:** 2026-03-26
**Status:** Approved

---

## Problem

All lcm plugin hooks use bare `node` in their command strings:

```json
{ "command": "node \"${CLAUDE_PLUGIN_ROOT}/lcm.mjs\" session-end" }
```

Claude Code's desktop app fires hooks in a clean macOS environment without the user's
interactive shell PATH. `node` is only on the system default PATH at `/usr/local/bin/node`
(Homebrew Intel). Every other common installation — nvm, Homebrew Apple Silicon, volta,
fnm, asdf, mise — places node at a non-default path. Result: `env: node: No such file or
directory` on every hook invocation. All six hooks silently fail. Promote never runs. The
daemon never starts. Core lcm functionality is dead for the majority of real users.

---

## Root Cause

`plugin.json` hooks are static strings baked at publish time. They cannot embed runtime
values like `process.execPath`. Additionally, `${CLAUDE_PLUGIN_ROOT}` is only expanded by
Claude Code for hooks registered via `plugin.json` — **not** for hooks in `settings.json`.
This is confirmed by inspecting working `settings.json` hooks from other plugins (e.g.
context-mode), which use fully absolute script paths.

The lcm installer already solved the equivalent problem for the MCP server: it bypasses
`plugin.json`'s `mcpServers` and writes the absolute `lcm` binary path directly to
`settings.json` via `resolveBinaryPath()`. Hooks must follow the same pattern.

---

## Decision: Approach B — settings.json owns hooks

Three approaches were evaluated with FOR/AGAINST agent review rounds:

| Approach | Decision | Killer |
|---|---|---|
| A — patch plugin.json cache | Rejected | Claude Code rebuilds cache silently |
| B — settings.json owns hooks | **Adopted** | — |
| C — `/bin/zsh --login` wrapper | Rejected | Load order machine-specific; `/bin/zsh` not universal |

A sub-question (where does the upsert live) was also reviewed with FOR/AGAINST rounds and
an Opus synthesis. The atomic-write insight from Opus unlocked Option B (self-heal in
`ensureCore`) as safe.

---

## Architecture

```
Before                             After
────────────────────────────────────────────────────────
plugin.json    owns hooks          plugin.json    NO hooks (metadata only)
settings.json  owns MCP only       settings.json  owns MCP + hooks
mergeClaudeSettings  removes hooks mergeClaudeSettings  upserts hooks
ensureCore     hook-unaware        ensureCore     self-heals hooks (atomic)
lcm.mjs        delegates only      lcm.mjs        writes hooks on first run
```

---

## Hook Command Format

```
"${process.execPath}" "${lcmMjsPath}" <subcommand>
```

Both paths are **fully absolute**, resolved at write time. No env-var placeholders.

- `process.execPath` — the exact node binary running the write. No PATH lookup, no shim
  ambiguity. Guaranteed correct at the moment of write.
- `lcmMjsPath` — resolved from the installer's `import.meta.url`:
  `join(dirname(fileURLToPath(import.meta.url)), "..", "lcm.mjs")`
  → e.g. `/Users/pedro/.claude/plugins/cache/lossless-claude/lcm/0.7.1/lcm.mjs`

**Why not `${CLAUDE_PLUGIN_ROOT}/lcm.mjs`?** Claude Code only expands that placeholder for
`plugin.json` hooks. `settings.json` hooks receive no such expansion — the string is passed
verbatim to the subprocess.

**Why not the global `lcm` binary?** Requires a global npm install. Marketplace installs
that skip `lcm install` have no global binary. Absolute `lcm.mjs` path works in all cases.

---

## Write Sites

Three sites write hooks to `settings.json`, all calling the same `requiredHooks()` function:

### 1. `lcm install` (authoritative)
Explicit user action. Runs in the user's active shell — `process.execPath` is the correct,
user-intended node binary. Writes hooks as part of the install sequence, after config and
MCP server registration.

### 2. `ensureCore` (self-healing)
Called on every hook invocation (SessionStart, Stop, etc.). Checks whether the hook commands
in `settings.json` match the current `process.execPath` + `lcmMjsPath`. If they differ,
rewrites atomically. **Atomic write**: write-to-temp-file then `fs.renameSync` — the same
pattern used in `src/daemon/auth.ts`. This is safe for concurrent hook fires because:
- The hot path (no mismatch) is a read-only string compare
- On mismatch, concurrent writers write the same correct value; last-rename-wins is valid JSON

### 3. `lcm.mjs` bootstrap (marketplace coverage)
When `lcm.mjs` runs for the first time and bootstraps (npm install + build), it also writes
hooks to `settings.json`. This covers the marketplace-install-without-`lcm install` path,
where hooks would otherwise never be registered. `lcm.mjs` resolves `lcmMjsPath` from
`import.meta.url` (always correct regardless of how it was invoked).

---

## Code Changes

### `src/installer/settings.ts`

**Type-safe intent discriminated union** (fixes TypeScript unsafety from optional `nodePath`):

```typescript
type HookOpts =
  | { intent: "remove" }
  | { intent: "upsert"; nodePath: string; lcmMjsPath: string };

export function requiredHooks(nodePath: string, lcmMjsPath: string) {
  return REQUIRED_HOOKS.map(({ event, subcommand }) => ({
    event,
    command: `"${nodePath}" "${lcmMjsPath}" ${subcommand}`,
  }));
}

/** Returns true if all required hooks exist in settings with the correct absolute paths. */
export function hooksUpToDate(existing: any, nodePath: string, lcmMjsPath: string): boolean { ... }

export function mergeClaudeSettings(existing: any, opts: HookOpts): any { ... }
```

- `intent: "remove"` → existing dedup/cleanup behavior (used during migration for callers
  that have not yet been updated, and for uninstall)
- `intent: "upsert"` → ensures all 6 hooks exist with the correct absolute paths; also
  removes stale entries (old bare `node "..."` commands from previous plugin.json ownership)

**Migration**: add old plugin.json-style commands to the `OLD_TO_NEW` map so they are
replaced rather than left as duplicates:
```typescript
`node "${CLAUDE_PLUGIN_ROOT}/lcm.mjs" session-end` → new absolute-path command
```

### `src/bootstrap.ts` (`ensureCore`)

1. Change `mergeClaudeSettings` call to `intent: "upsert"`, passing `process.execPath` and
   resolved `lcmMjsPath`
2. Change `writeFileSync` to atomic write (write-to-temp + `renameSync`):

```typescript
function atomicWriteJSON(path: string, data: unknown): void {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}
```

### `installer/install.ts`

Pass `process.execPath` and resolved `lcmMjsPath` to the settings merge step:

```typescript
const lcmMjsPath = join(dirname(fileURLToPath(import.meta.url)), "..", "lcm.mjs");
const merged = mergeClaudeSettings(existing, {
  intent: "upsert",
  nodePath: process.execPath,
  lcmMjsPath,
});
```

### `lcm.mjs`

After successful bootstrap (dist built, deps installed), write hooks to `settings.json` **only
if they are missing or stale**. The guard prevents a write on every subsequent dist rebuild
(e.g. CI, `npm run build`, or hook invocations that trigger a hot-reload):

```javascript
// Best-effort — never throws, never blocks hook execution
// Guard: only writes if hooks are absent or point to wrong paths
try {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const { mergeClaudeSettings, hooksUpToDate } = await import("./dist/src/installer/settings.js");
  const lcmMjsPath = fileURLToPath(import.meta.url);
  const existing = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf-8"))
    : {};
  if (!hooksUpToDate(existing, process.execPath, lcmMjsPath)) {
    const merged = mergeClaudeSettings(existing, {
      intent: "upsert",
      nodePath: process.execPath,
      lcmMjsPath,
    });
    atomicWriteJSON(settingsPath, merged);
  }
} catch { /* never block */ }
```

### `.claude-plugin/plugin.json`

Remove the entire `hooks` section. The file becomes metadata-only (name, version, description,
author, mcpServers, commands). Claude Code no longer registers any lcm hooks from this file.

Claude Code re-reads `plugin.json` on each plugin reload, so removing the `hooks` array takes
effect on the next Claude Code restart. Users upgrading from an old version will briefly have
the old bare-node hooks in Claude Code's registry until restart; `mergeClaudeSettings` with
`intent: "upsert"` removes those stale entries (via the `OLD_TO_NEW` migration map) on the
first `ensureCore` run, preventing double-fire.

### `src/doctor/doctor.ts`

Flip the hook invariant check:

- **Before**: hooks in `settings.json` = bad (duplicate with plugin.json). Remove them.
- **After**: hooks in `settings.json` = expected. Check that they exist and that the node
  path matches `process.execPath`. If stale: report `warn` + re-run upsert.

Two parsing helpers (not exported — internal to doctor):

```typescript
/** Returns the first double-quoted token (the node binary path). */
function extractNodeFromHookCommand(cmd: string): string | null {
  return cmd.match(/^"([^"]+)"/)?.[1] ?? null;
}

/** Returns the second double-quoted token (the lcm.mjs path). */
function extractLcmMjsFromHookCommand(cmd: string): string | null {
  return cmd.match(/^"[^"]*"\s+"([^"]+)"/)?.[1] ?? null;
}
```

These handle paths with spaces correctly because they match on the outer quotes, not on
whitespace.

```typescript
// New doctor check: hook-node-path
const hookNode = extractNodeFromHookCommand(lcmHooks[0].command);
const hookMjs  = extractLcmMjsFromHookCommand(lcmHooks[0].command);
if (!hookNode || !hookMjs) return { name: "hook-node-path", status: "fail", message: "lcm hooks missing — run `lcm install`" };
const staleNode = hookNode !== process.execPath;
const staleMjs  = !existsSync(hookMjs);   // deleted after plugin version bump
if (staleNode || staleMjs) {
  mergeClaudeSettings(settings, { intent: "upsert", nodePath: process.execPath, lcmMjsPath });
  const reason = staleNode
    ? `node path was ${hookNode}`
    : `lcm.mjs missing at ${hookMjs} (plugin updated to ${PKG_VERSION})`;
  return { name: "hook-node-path", status: "warn", message: `Repaired hooks (${reason})` };
}
return { name: "hook-node-path", status: "ok" };
```

### `src/installer/auto-heal.ts`

Flip from `intent: "remove"` to `intent: "upsert"` with `process.execPath` and `lcmMjsPath`.
This eliminates the oscillation risk where auto-heal was stripping hooks that ensureCore wrote.

---

## Caller Audit

All callers of `mergeClaudeSettings` must be updated to the discriminated union:

| Caller | Old intent | New intent |
|---|---|---|
| `src/bootstrap.ts` (ensureCore) | implicit remove | upsert |
| `installer/install.ts` | implicit remove | upsert |
| `src/installer/auto-heal.ts` | remove | upsert |
| `src/doctor/doctor.ts` | remove (anti-pattern) | upsert (repair) |
| `installer/uninstall.ts` | remove | remove (unchanged — but update the hook-matching predicate to identify lcm hooks by presence of the `lcm.mjs` path token rather than full command string equality, since the command format has changed from bare-node to quoted-absolute-path) |

---

## Error Handling

- `lcm.mjs` bootstrap write: wrapped in try/catch, never throws, never delays hook execution
- `ensureCore` atomic write: if `renameSync` fails (e.g. cross-filesystem temp dir), the
  error propagates and the write is not performed — no fallback. The hook remains stale
  until the next `ensureCore` run succeeds.
- Node path missing at hook fire time: hook exits non-zero, Claude Code skips it — same as
  current behavior; `lcm doctor` detects and repairs on next explicit run

---

## Testing

### Unit tests (existing vitest suite)

1. `mergeClaudeSettings` with `intent: "upsert"` — verifies all 6 hooks written with correct
   absolute paths
2. `mergeClaudeSettings` with `intent: "upsert"` over stale entries — verifies old bare-node
   commands are replaced, not duplicated
3. `mergeClaudeSettings` with `intent: "remove"` — existing behavior unchanged (uninstall path)
4. `requiredHooks(nodePath, lcmMjsPath)` — spot-check command string format
5. `ensureCore` with mismatched node path — verifies atomic rewrite fires
6. `ensureCore` with matching node path — verifies no write (read-only hot path)
7. Doctor hook-node-path check — verifies warn + repair on stale node path, ok on match, fail on missing
8. Doctor hook-node-path check — verifies warn + repair when `lcmMjsPath` does not exist on disk (plugin version bump scenario)
9. `hooksUpToDate` — returns true when all hooks match, false when any hook command differs or is absent

### Smoke tests (manual dogfood)

1. Install with nvm node → quit Claude Code → restart → verify hooks fire (promote runs)
2. `nvm use <other>` → open new session → verify `ensureCore` repairs hook path
3. `lcm doctor` with stale path → verify repair + ok on second run
4. `lcm install --dry-run` → verify hook commands shown with absolute paths

---

## Known Limitations

- **Volta/fnm shims**: `process.execPath` returns the shim path, not the real versioned binary.
  The shim resolves at hook-fire time from Claude Code's process context (no project directory).
  This may resolve a different version than the user's project `.node-version`. Accepted risk —
  no worse than current (total failure). Can be revisited if user reports emerge.
- **Per-project `.nvmrc`**: A single global node path in `settings.json` is correct for the
  majority. Users with per-project node version overrides that differ from their global node
  are an edge case; they can run `lcm install` from the correct shell context.
- **Windows**: Paths use backslashes; quoted absolute paths work the same way in cmd/pwsh.
  Not a target platform currently but the format is compatible.
