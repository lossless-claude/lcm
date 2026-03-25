# LCM Statusline Design

## Overview

A standalone statusline for the lossless-claude (lcm) plugin that displays daemon health, live activity, and memory stats in Claude Code's native status bar. Uses the Claude Code statusline API — no separate window, no tmux, works in any terminal.

## Requirements

- **Daemon health**: `●` alive/idle, `◐` active/working, `○` dead
- **Live activity**: show current operation (compacting, promoting, ingesting, idle)
- **Session context**: messages ingested, promoted memories count

## Rendering

Single line, three segments:

```
◐ compacting │ 234 msgs │ 12 promoted
●  idle       │ 234 msgs │ 12 promoted
○  dead
```

| Segment | Source | Format |
|---------|--------|--------|
| Health/activity | `GET /health` | `●` green idle, `◐` yellow active, `○` dim dead |
| Messages ingested | `POST /status` → `messageCount` | `{n} msgs` via `formatNumber()` |
| Promoted memories | `POST /status` → `promotedCount` | `{n} promoted` via `formatNumber()` |

Colors:
- `●` / activity verb: green when idle, yellow when working, dim gray when dead
- Stats: dim/default — secondary to the health indicator
- Reuse ANSI constants from `src/stats.ts`

Dead state: when daemon is unreachable, show `○ dead` only — no stale numbers.

## Architecture

### New files

| File | Purpose |
|------|---------|
| `src/statusline.ts` | Entry point. Reads stdin (required by API), calls daemon, renders line, writes stdout |
| `src/statusline-render.ts` | Pure function: takes health + status data, returns ANSI string |
| `src/daemon/activity.ts` | Global activity state tracker (`idle` / `compacting` / `promoting` / `ingesting`) |

### Modified files

| File | Change |
|------|--------|
| `src/daemon/server.ts` | Include `activity: getActivity()` in `GET /health` response |
| `src/daemon/routes/compact.ts` | Call `setActivity("compacting")` / `setActivity("idle")` around work |
| `src/daemon/routes/promote.ts` | Call `setActivity("promoting")` / `setActivity("idle")` around work |
| `src/daemon/routes/ingest.ts` | Call `setActivity("ingesting")` / `setActivity("idle")` around work |
| `src/daemon/client.ts` | Extend `health()` return type to include `activity?: string` |
| `package.json` | Add `statusline.mjs` to `files` array |
| `.claude-plugin/plugin.json` | No change — `statusLine` goes in user's `settings.json` |

### Build output

`statusline.mjs` — alongside existing `lcm.mjs` and `mcp.mjs`. Must be added to `package.json` `files` array so it ships with `npm publish`.

## Stdin Contract

Claude Code pipes JSON on stdin every tick. The shape (confirmed from claude-hud's `StdinData`):

```ts
interface StdinData {
  cwd?: string;                    // project working directory — used for POST /status
  transcript_path?: string;
  model?: { id?: string; display_name?: string };
  context_window?: { context_window_size?: number; current_usage?: { ... } };
  rate_limits?: { ... };
}
```

The statusline parses stdin to extract `cwd` (needed for the `/status` call). All other fields are ignored. Stdin must be fully drained before the process exits (Claude Code API requirement).

## Data Flow

Per tick (~300ms), Claude Code invokes the statusline command:

```
Claude Code → stdin JSON → statusline.ts (parse cwd from stdin)
                              ├─ GET /health → { status, version, uptime, activity }
                              ├─ POST /status { cwd } → { messageCount, promotedCount }
                              └─ statusline-render → stdout → Claude Code displays
```

- Both HTTP calls fire in parallel (`Promise.all`) to stay under 300ms
- If daemon is dead, both fail → render `○ dead` immediately, no retries
- If `cwd` is missing from stdin, fall back to `process.cwd()`

## Data Contract

### `GET /health` (extended)

```json
{
  "status": "ok",
  "version": "0.5.0",
  "uptime": 342,
  "activity": "idle"
}
```

`activity` is one of: `"idle"`, `"compacting"`, `"promoting"`, `"ingesting"`.

### `POST /status` (unchanged)

```json
{
  "daemon": { "version": "0.5.0", "uptime": 342, "port": 2847 },
  "project": {
    "messageCount": 234,
    "summaryCount": 47,
    "promotedCount": 12,
    "lastIngest": "2026-03-25T10:30:00Z",
    "lastCompact": "2026-03-25T10:25:00Z",
    "lastPromote": "2026-03-25T10:20:00Z"
  }
}
```

## Activity State Tracking

New module `src/daemon/activity.ts`:

```ts
let current: "idle" | "compacting" | "promoting" | "ingesting" = "idle";

export function setActivity(state: typeof current) { current = state; }
export function getActivity() { return current; }
```

Integration: each route handler calls `setActivity("X")` before work and `setActivity("idle")` in its finally block. Single global string, last-write-wins on overlap (acceptable for a status display).

## Setup

A `/lcm:statusline-setup` command writes the `statusLine` config into `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "command": "node",
    "args": ["<plugin-root>/statusline.mjs"]
  }
}
```

Similar to claude-hud's `/claude-hud:setup` pattern.

## Reused Code

From `src/stats.ts`:
- `formatNumber()` — compact number display (`1.2k`, `3.4M`)
- ANSI color constants

From `src/daemon/client.ts`:
- `DaemonClient` class — `health()` and `post()` methods

## Non-goals

- Compression ratio display (too detailed for a glance)
- Multi-line output (single line is sufficient)
- Replacing claude-hud (complementary — stacks with it)
- Fallback to direct SQLite reads (daemon-only data source)
