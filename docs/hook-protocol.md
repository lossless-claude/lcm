# Claude Code Hook Protocol

This document describes the stdin payload fields that Claude Code delivers to each lcm hook command.

All hooks receive a JSON object via stdin. lcm hooks are invoked as shell commands:

```
lcm <hook-command> < <stdin-json>
```

## Plugin installations

When installed as a Claude Code plugin, hooks run through the plugin's `lcm.mjs` launcher. The launcher starts the same CLI commands described below and forwards their arguments and stdin payloads.

The launcher now correctly starts the CLI. Previously, plugin hooks could exit silently without restoring context or recording session activity. Update the installed plugin to receive this fix; no hook configuration changes are required.

## PreCompact Hook

**Command:** `lcm compact --hook`

Invoked by Claude Code before it runs its built-in compaction. lcm writes a DAG summary of the session and prints it on stdout. The hook always exits `0`; it never blocks or replaces the built-in compaction. Empty stdout means lcm deferred (daemon unavailable or nothing to compact).

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory of the Claude Code session |
| `hook_event_name` | string | `"PreCompact"` |

**Response:** Exit code `0`. Summary text on stdout when the daemon compacted; empty stdout to defer.

## SessionStart Hook

**Command:** `lcm restore`

Invoked at the start of a Claude Code session. lcm restores recent summaries and promoted memory, injects them as a user message prefix, and prints a `<context>` block on stdout.

On startup, resume, and clear, lcm saves a snapshot of the applicable `CLAUDE.md` files without adding another copy to the restored context. Claude Code supplies those instructions itself. After compaction, lcm replays the saved snapshot so the instructions remain available.

The snapshot reads `~/.claude/CLAUDE.md`, `CLAUDE.md` in the working directory, and `.claude/CLAUDE.md` in the working directory. If multiple paths resolve to the same file, lcm includes it only once, including when you start Claude Code in your home directory. This behavior is automatic and needs no configuration.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `hook_event_name` | string | `"SessionStart"` |
| `source` | string (optional) | `"startup"`, `"resume"`, `"clear"`, or `"compact"`; compaction replays the saved instructions |

If `source` is missing or unrecognized, lcm uses a recent compaction marker for the same session to decide whether to replay the saved instructions. Explicit `"startup"`, `"resume"`, and `"clear"` values override that fallback; `"compact"` always requests replay.

**Response:** Exit code `0`. Context is injected via stdout (printed as a `<context>` block that Claude Code prepends to the session).

## SessionEnd Hook

**Command:** `lcm session-end`

Invoked when the Claude Code session ends. lcm ingests the completed session transcript and triggers passive-learning event promotion.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `hook_event_name` | string | `"SessionEnd"` |

**Response:** Exit code `0`. Runs best-effort; failures do not block session exit.

## UserPromptSubmit Hook

**Command:** `lcm user-prompt`

Invoked on each user prompt. lcm searches memory for relevant hints and injects a `<memory-hints>` block into the prompt.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `prompt` | string | The user's prompt text |
| `hook_event_name` | string | `"UserPromptSubmit"` |

**Response:** Exit code `0`. Hints are injected via stdout when relevant matches are found.

## PostToolUseFailure Hook

**Command:** `lcm post-tool` (same handler as PostToolUse)

Invoked when a tool that started running fails. Claude Code never routes failures through `PostToolUse`, so error events only exist because this hook is registered. The handler records an `error_tool` event (priority 1) in the local sidecar database. The payload carries `tool_name`, `tool_input`, a top-level `error` string (for Bash the first line is `Exit code N`), and optional `is_interrupt`; interrupts are ignored.

**Response:** Always exit code `0`, no stdout.

## PostToolUse Hook

**Command:** `lcm post-tool`

Invoked after a tool call **succeeds**, and only for the tools the `PostToolUse` matcher in `.claude-plugin/plugin.json` enumerates — the ones lcm has an extractor for. Failures arrive on [PostToolUseFailure](#posttoolusefailure-hook) instead. lcm extracts structured events (decisions, errors, git ops, etc.) and writes them to the passive-learning sidecar database.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `tool_name` | string | Name of the tool that was called |
| `tool_input` | object | The tool's input arguments |
| `tool_response` | any | The tool's response object |
| `tool_output` | string | Plaintext output (if available) |
| `hook_event_name` | string | `"PostToolUse"` |

**Response:** Always exit code `0`. This hook runs on every tool call and must be fast; it does no network I/O and only writes to a local sidecar SQLite database.

## Function hooks module (early access)

**Module:** `hooks/lcm-hooks.ts`, named by `hooks/hooks.json` under `modules`. Loaded only when Claude Code runs with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`; the command hooks above keep working without it.

One `tool.call` hook replaces both PostToolUse and PostToolUseFailure: it awaits the tool, reads `isError` on the result, and POSTs the same payload the command hook reads on stdin to the daemon's `POST /tool-event` route, which runs the same extractors and writes the same rows (`source_hook` is `PostToolUse` or `PostToolUseFailure` as before). The module runs in Claude Code's hooks worker with no Node and no SQLite, which is why the daemon writes. It reads the daemon port and bearer token once per load through a host command, because `$.fs` cannot leave the project directory.

`prompt.submit` replaces UserPromptSubmit: it POSTs `/prompt-search` with `recordEvents: true` (the daemon extracts the prompt's events) and `format: "context"` (the daemon returns the rendered `<memory-context>` block), and attaches that block as hidden `context` on the prompt, which the model reads and the user never sees. The learning instruction no longer rides on every prompt: a `prompt.section` hook on the system prompt's `memory` section appends it once, cached for the session. This assumes the engine raises `prompt.section` for `memory` even when core omits the section (sections with null core text were observed firing in Claude Code 2.1.263). The module reports `learningInstructionBytes: 0` to `/prompt-search`, but the daemon's reserve is `max(reservedForLearningInstruction, learningInstructionBytes)`, so the hint budget stays what it was; the freed bytes are not spent on more hints. The module keeps a verbatim copy of `src/hooks/learning-instruction.ts`; a test fails when the two drift.

`turn.complete` replaces the Stop hook's `session-snapshot`: at most once a minute it POSTs `/ingest` with `session_id` and `cwd` only, and `/ingest` derives the transcript file from them (`~/.claude/projects/<cwd slug>/<session_id>.jsonl`, still checked by `isSafeTranscriptPath`), then POSTs `/promote-events`. A caller that has `transcript_path` keeps sending it; the derivation is only the fallback.

A daemon that answers 404 (an older lcm build without these routes) is logged once per route per session, not per call.

**Summarize jobs:** with `llm.provider: "session"` (see `docs/configuration.md`), the module also serves the daemon's summarization jobs for its own session. From `session.start` it holds one `GET /summarize-jobs/next?session_id=…` open (the daemon answers a job or `204` after 25 s) and answers each job on `POST /summarize-jobs/:id` with `{ text, providerId, usage }` or `{ error }`. Leaf jobs run `$.model.complete` with `haiku`; condensed jobs run `$.model.fork`, then `complete` when the fork has no warm cache. The poller stops for the session once the plugin's `sessionSummarizerMaxOutputTokens` cap is reached. A daemon that answers 404 (an older build, or a daemon swapped mid-session) does not stop it: the module logs that once and keeps polling every minute, so a later respawn with the route is picked up. Design: `docs/design/session-summarizer.md`.

**Daemon lifecycle:** the daemon exits when idle, and the command hooks brought it back through `ensureDaemon`. The module does the same: on a connection failure it runs `lcm daemon start --detach` through the host (at most once per minute) and retries the request once, and `session.start` checks `/health` before the first prompt. This needs an `lcm` binary on PATH; without one the module logs it once and events are lost until a command hook (SessionStart, Stop, SessionEnd) restarts the daemon.

**Dedup rule:** while `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is set, `lcm post-tool`, `lcm user-prompt` and `lcm session-snapshot` exit without recording or printing anything; otherwise every event would land twice and the model would read the memory context twice. The variable is one of two switches that load the module; the other is Claude Code's remote gate (`tengu_plugin_hooks_modules`), which the command hook cannot see. Known limits of this rule: a module that fails to load loses passive capture for the session (the failure is named in Claude Code's debug log), and a session where the remote gate loads the module without the variable records every event twice. The durable fix is dedup on `(session_id, tool_use_id)` in the events DB, which both paths receive.

**Types:** run `/plugin-types` in a session with the flag on; it writes `claude-code.d.ts` for the running build. Regenerate after a Claude Code update rather than editing. `claude plugin validate` reads the module statically: `$` may only be passed to a top-level function, and calls must be spelled `$.noun.method(...)`.

## SessionSnapshot Hook

**Command:** `lcm session-snapshot`

An optional periodic hook that incrementally ingests the live session transcript between `SessionEnd` events. This is used for long-running sessions where you want memory to be updated without waiting for the session to end.

**Stdin fields:**

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Session identifier |
| `cwd` | string | Working directory |
| `transcript_path` | string | Path to the live JSONL session transcript |
| `hook_event_name` | string | `"SessionSnapshot"` (if provided) |

**Response:** Exit code `0`.

## Deadlines

Every hook bounds its daemon call so a wedged daemon can never hold the session open. The deadline is client-side; the host applies its own per-hook timeout on top, and the shorter of the two wins.

| Hook | Route | Client deadline | Host timeout |
|------|-------|-----------------|--------------|
| PreCompact | `/compact` | 120s — summarization calls an LLM | `timeout: 120` on the PreCompact entry in `.claude-plugin/plugin.json` |
| SessionStart | `/restore` | 10s | host default |
| SessionEnd | `/ingest` | 10s | host default (SessionEnd hooks share a short budget) |
| UserPromptSubmit | `/prompt-search` | 5s | host default |

A client deadline longer than the host timeout is dead code — the host kills the hook first. PreCompact is the only hook that declares a matching host `timeout`, and the two must stay in sync.

SessionEnd additionally passes `noSpawn: true`, so it never starts a daemon just to ingest: if none is running the hook exits 0 and the `SessionSnapshot` hook's incremental ingest is the fallback.

## Auto-heal

All lcm hooks self-repair on each invocation: before dispatching, `validateAndFixHooks()` checks that all required hook entries remain registered in `~/.claude/settings.json` and re-adds any missing entries. This means lcm hooks survive `claude settings reset` or manual edits to the settings file.
