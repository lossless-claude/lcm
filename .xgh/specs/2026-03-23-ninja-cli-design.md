# Ninja CLI Renderer — Design Spec

**Date**: 2026-03-23
**Issue**: #64 (reusable ninja CLI interface for session commands)
**Project**: [Ingestion pipeline improvements](https://github.com/orgs/lossless-claude/projects/1)
**Status**: Draft

---

## Overview

A reusable, state-driven CLI renderer for all lcm session-handling commands. Replaces ad-hoc `console.log` / `process.stdout.write` scattered across `import.ts`, `batch-compact.ts`, and `import-summary.ts` with a single render loop driven by a plain state object.

Inspired by React's model: commands update state, rendering is a pure function of that state.

## Key Decisions

- **Approach C**: render loop with pure `renderFrame(state, opts) → string`
- **Replay is the new default** for `lcm import`; `--no-replay` is the escape hatch
- **Always pre-scan** for total count — every command must implement `count()`
- **Summary shows DAG metrics** (nodes, depth, memories) instead of "tokens freed"
- **Verbose mode**: sequential session log + full `lcm stats --verbose` at end
- **Non-verbose mode**: live 3-line ninja display + compact summary
- **Migration strategy**: add `onProgress` callback to existing functions first, strip `console.log` in a second pass (avoids breaking tests in one big bang)

## State Model

```typescript
interface ProgressState {
  // Phase tracking (multi-phase pipelines like curate)
  phases: { name: string; status: 'pending' | 'active' | 'done' }[];

  // Multi-project tracking (--all mode)
  currentProject?: string;

  // Current work
  total: number;
  completed: number;
  failed: number;
  errors: { sessionId: string; message: string }[];  // what failed and why

  // Running metrics
  tokensIn: number;
  tokensOut: number;       // 0 when no compaction (--no-replay)
  messagesIn: number;

  // Current session being processed
  current?: {
    sessionId: string;
    messages: number;
    tokens: number;
    startedAt: number;     // Date.now()
  };

  // Last completed session (drives line 3 of ninja display)
  lastResult?: {
    sessionId: string;
    messages: number;
    tokensBefore: number;
    tokensAfter?: number;  // undefined when no compaction
    provider?: string;
    elapsed: number;       // ms
  };

  // DAG metrics (updated after compact/promote phases)
  dag?: {
    nodes: number;
    newNodes: number;
    depth: number;
    memoriesPromoted: number;
  };

  // Timing
  startedAt: number;

  // Flags
  dryRun: boolean;
  aborted: boolean;        // set on SIGINT for clean partial summary
}
```

## Render Options

```typescript
interface RenderOpts {
  isTTY: boolean;
  width: number;
  color: boolean;
  verbose: boolean;
}
```

Detected at CLI startup. `width` is re-queried on `SIGWINCH`.

## Render Function

`renderFrame(state: ProgressState, opts: RenderOpts): string`

Pure function. No side effects, no IO. Returns the string to write to stdout.

### TTY Mode — 3-line ANSI overwrite

```
  ● Import  →  ○ Compact  →  ○ Promote       7/12   1 failed
  [██████████████░░░░░░░░] 58%  1,247 msgs (~284k → ~18k tokens, 15.7×)
  ● agent-a3a81dc  142 msgs  ~42.3k → ~1.2k  [Haiku]  1.3s
```

Line 1: Phase indicator + progress counter + failure count (red, appears on first failure)
Line 2: Progress bar + running totals. Compression ratio shown only when `tokensOut > 0`
Line 3: Current session detail — ID, messages, token flow, provider, elapsed

When `dryRun: true`, line 1 shows `[dry-run]` badge.

### Non-TTY Mode — one line per session

```
  [7/12] agent-a3a81dc: 142 msgs, ~42.3k → ~1.2k [Haiku] 1.3s
```

No ANSI codes, no cursor movement. Safe for CI/pipe.

### Verbose Mode

Completed sessions scroll above the live display (TTY) or print sequentially (non-TTY):

```
  ✓ agent-f82bc91  89 msgs   ~28.1k → ~1.8k  [Haiku]  0.9s
  ✓ agent-a3a81dc  142 msgs  ~42.3k → ~1.2k  [Haiku]  1.3s
  ● agent-c44de72  203 msgs  processing...
```

Summary in verbose mode: delegates to `lcm stats --verbose` output.

### Color Rules

- Compression ratio: green when >10×, yellow when 5-10×, default when <5×
- Failed count: red
- Phase dots: filled (●) for done/active, hollow (○) for pending
- Current session: default (no color noise)

### Edge Cases

- **Narrow terminal** (<40 cols): collapse progress bar, show counter only
- **SIGWINCH**: caller re-queries `process.stdout.columns` and passes updated `width`
- **SIGINT**: set `state.aborted = true`, render partial summary, exit cleanly
- **No compaction** (`--no-replay`): progress bar shows `1,247 msgs (~284k tokens)` — no ratio

## Integration Contract

```typescript
interface PipelineSession {
  sessionId: string;
  path: string;
  messages?: number;   // known upfront for compact, discovered for import
  tokens?: number;     // estimated from content length
}

interface PipelineStep {
  name: string;
  count(opts: CommandOpts): Promise<number>;
  run(
    session: PipelineSession,
    update: (patch: Partial<ProgressState>) => void,
  ): Promise<{ success: boolean; error?: string }>;
  // run() must NOT throw — errors are returned in the result.
  // The pipeline runner does NOT wrap calls in try/catch.
}
```

### Lifecycle

1. CLI parses args, detects TTY/color/width
2. Creates `ProgressState` with phases from command config
3. Calls `step.count()` for total (always-pre-scan contract)
4. Starts render loop (`setInterval` at 16fps / 62ms on TTY, no-op on non-TTY)
5. Registers `SIGINT` handler → sets `aborted`, renders partial summary
6. Registers `SIGWINCH` handler → updates `width` in render opts
7. Iterates sessions, calling `step.run()` — which calls `update()` as it progresses
8. Render loop stops
9. Prints summary (non-verbose: compact table; verbose: `lcm stats --verbose`)

### Porting Existing Commands

| Command | `count()` source | Notes |
|---------|-----------------|-------|
| `import` | `findSessionFiles().length` | Replay is now the default |
| `compact --all` | `listSessions().length` | Already knows total upfront |
| `promote` | pre-call `/promote` with `dry_run: true` | New daemon support needed — `/promote` must accept `dry_run` and return `{ total }` without writing |
| `curate` | Chains all three steps | **New command** introduced by this work. Does not exist yet. Phases: `[Import, Compact, Promote]` |

### Migration Path

**Phase 1** (non-breaking): Add `onProgress?: (patch: Partial<ProgressState>) => void` callback to `importSessions()` and `batchCompact()`. Existing `console.log` stays. New renderer consumes `onProgress` when present. `--replay` remains opt-in during this phase.

**Phase 2** (breaking): Strip `console.log` / `process.stdout.write` from import and compact. Tests migrate from mocking `console.log` to asserting on state patches. Flip `--replay` to default-on (add `--no-replay` escape hatch). Update CLI help text.

**Phase 3**: Introduce `curate` command that chains Import → Compact → Promote with the multi-phase display.

## Summary Renderer

### Non-verbose (compact)

```
  ● Import  →  ● Compact  →  ● Promote          Done ✓

  [██████████████████████] 100%  1,892 msgs (~518k → ~31k tokens, 16.7×)

  ─────────────────────────────────────────────────
  Sessions       12 processed
  Compression    16.7×
  DAG nodes      47  (+12 new)
  DAG depth      8
  Memories       3 promoted
  Provider       Haiku (12)
  Total time     14.0s
  ─────────────────────────────────────────────────
```

Single-command runs (e.g. bare `lcm compact --all`): no phase bar, only metrics relevant to what ran.

When `errors.length > 0`, failed sessions listed below the summary:

```
  Failed:
    agent-b82fe12: connection refused
    agent-c44de72: timeout after 30s
```

### Verbose

Prints full `lcm stats --verbose` output (same as running it manually). No custom rendering.

## Daemon Response Changes Required

### `/compact` response — add `provider` field (#66)

```typescript
{
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
  latestSummaryContent?: string;
  provider: string;          // NEW — sourced from resolveEffectiveProvider() in compact.ts (~line 104)
}
```

### `/compact` response — add DAG metrics

```typescript
{
  // ... existing fields ...
  dag?: {
    nodes: number;
    newNodes: number;    // delta from this compaction — client sums across sessions
    depth: number;
  };
}
```

### `lcm stats` plugin command

Default (non-verbose) output should be concise — no per-session table.
`--verbose` shows the full table. The plugin command should NOT pass `--verbose` by default.

## Related Issues

- #62 — ninja progress, token stats, provider attribution (implementation details)
- #64 — this design (reusable base interface)
- #66 — `/compact` missing provider field (prerequisite)
- #72 — inconsistent daemon error handling (related)

## File Plan

New directory `src/cli/` (does not exist yet — create it):

```
src/cli/
  progress-state.ts     — ProgressState type + initial state factory
  render-frame.ts       — pure renderFrame() function
  render-summary.ts     — summary renderer (replaces import-summary.ts)
  pipeline-runner.ts    — lifecycle orchestrator (loop, SIGINT, SIGWINCH)
  pipeline-step.ts      — PipelineStep interface + PipelineSession type
```

Existing files modified:
- `src/import.ts` — add `onProgress` callback (phase 1), then strip console.log (phase 2)
- `src/batch-compact.ts` — same migration
- `src/import-summary.ts` — deprecated, replaced by `render-summary.ts`
- `bin/lcm.ts` — dispatch through pipeline runner
- `src/daemon/routes/compact.ts` — add `provider` and `dag` to response
