# Codex integration parity

Status: implemented native hook adapter and connector, with CLI/daemon integration tests. Installation and activation in a Codex host are distinct.

## Outcome

LCM captures Codex sessions automatically through native hooks, restores relevant memory at session start and resume, recalls related history before prompts, and preserves continuity across native compaction. `lcm import --replay` discovers both Claude and Codex sessions unless the caller explicitly chooses a provider.

## Implementation

- `src/connectors/codex-hooks.ts`: native hook registration, preservation of unrelated configuration, and installation diagnostics.
- `src/hooks/codex.ts`: Codex lifecycle input normalization, request deadlines, bounded developer context, and fail-open behavior.
- `src/connectors/installer.ts`: Codex TOML MCP registration remains manual.
- `src/codex-transcript-reader.ts` and `src/daemon/routes/ingest.ts`: asynchronous suffix reading and shared incremental ingestion for live hooks and historical imports.
- `src/db/codex-cursor.ts`: byte checkpoints committed atomically with their messages.
- `src/daemon/routes/restore.ts` and `src/daemon/routes/prompt-search.ts`: restoration from session context and recall from promoted and episodic memory.
- `src/import.ts` and `bin/lcm.ts`: replay discovery across both providers, with explicit provider selection preserved.
- `src/llm/codex-process.ts`: internal summaries disable hooks and use ephemeral sessions to prevent self-capture.

The Claude integration retains its existing handlers and instruction lifecycle.

## Native integration contract

The official [Codex hooks reference](https://developers.openai.com/codex/hooks) documents the following integration points:

| Behavior | Codex event | Adapter responsibility |
| --- | --- | --- |
| Restore memory | `SessionStart` | Handle startup, resume, clear, and compact sources; return bounded developer context. |
| Recall before a prompt | `UserPromptSubmit` | Search using the prompt and return bounded `additionalContext`. |
| Capture completed turns | `Stop` | Incrementally ingest the Codex transcript without blocking or restarting the agent. |
| Capture interruptions | `Interrupt` | Attempt a short write to an already running daemon within Codex's three-second cap. |
| Capture remaining content | `SessionEnd` | Flush pending ingestion; do not rely on shutdown as the only capture event. |
| Preserve compaction continuity | `PreCompact`, `SessionStart` with source `compact` | Capture before native compaction and restore memory for continuation; prevent duplicate work across lifecycle events. |

`PostCompact` is also available, but LCM registers only `SessionStart(source=compact)` for restoration. LCM does not block native prompts, stops, or compaction on daemon failure.

Hooks can be registered in user or repository `.codex/hooks.json`, or inline in `config.toml`. Preserve unrelated hooks and make installation/removal idempotent. Non-managed hooks require Codex trust review; installation alone does not prove activation. The installer must report pending trust accurately, and must not bypass it.

The hooks reference does not establish a minimum supported version or a complete desktop/web App support matrix. Verify local CLI and desktop App separately. Do not advertise hosted App parity based solely on local CLI results. [App Server](https://developers.openai.com/codex/app-server) offers lifecycle events for host integrations, but its existence does not establish behavior in the Codex App UI.

## Data and lifecycle boundaries

- Raw Codex session UUIDs are shared by hooks, import, replay, and restore. Transcript metadata must match the target project. Legacy historical imports may use the discovery filename identity when metadata has no UUID.
- Ingestion resumes from a persisted byte offset and canonical source-message count. It reads the appended suffix asynchronously, plus a bounded metadata header and fingerprints of the first and last 4 KiB of the checkpointed prefix. Missing or invalid cursors require a full scan; replacement, truncation, sampled-prefix changes, and growth after an imported non-newline EOF invalidate the cursor. The transcript must retain a stable parsed prefix: bounded fingerprints cannot detect rewrites confined to the unsampled middle.
- Cursor advancement and message insertion share one SQLite transaction. Failed parsing or database writes do not advance the checkpoint. A recovery scan must contain the complete stored prefix, with roles and text matching after current redaction rules are applied to both sides; shorter or different history is rejected without moving the cursor. Removing historical redaction rules can prevent verification until the rules are restored. Overlapping imports skip only that verified prefix.
- Live capture defers non-newline trailing records. Historical import accepts a complete final JSON record without a newline. Repeated lifecycle events and import do not duplicate captured messages.
- Codex restore uses bounded summaries and unsummarized user/assistant context. A new startup can fall back to the latest nonempty project conversation; resume and compaction use the current session.
- Codex owns its instruction lifecycle. LCM never replays the Claude instruction snapshot into Codex.

MCP setup improves tool access, but does not itself provide automatic lifecycle integration. Treat it as a separate connector improvement.

## Verification contract

`test/e2e/flows/codex-lifecycle.test.ts` runs the built LCM CLI with real HTTP and SQLite, using a deterministic summarizer. `test/e2e/flows/codex-replay-cli.test.ts` runs discovery and replay through that CLI. Focused hook, parser, ingestion, restore, and connector tests cover failure and configuration cases.

The opt-in `test/e2e/flows/codex-native-runtime.test.ts` verifies the installed native host against a local mock provider:

```sh
LCM_CODEX_NATIVE_RUNTIME=1 npx vitest run test/e2e/flows/codex-native-runtime.test.ts
```

Verified with Codex CLI 0.153.4: untrusted hooks are skipped; vetted fixture hooks run at startup, resume, prompt, stop, and automatic compaction; hook context reaches the provider as developer messages; the current prompt is absent from the transcript at prompt-hook time; both current messages are present at stop-hook time. Automatic compaction followed by resume emits both `SessionStart(resume)` and `SessionStart(compact)`, and the host retains both outputs. LCM suppresses an identical compact restoration only when the raw transcript proves it was already emitted as developer context after the latest `compacted` record. A new compaction invalidates that evidence.

The native probe also invokes the production hook adapter with deterministic daemon responses across two automatic compaction generations. It verifies that each fresh compaction marker is fully written before the compact-start callback and that each continuation contains exactly one restored context. The deduplication check reads at most a 256 KiB tail asynchronously; incomplete, malformed, unreadable, or missing compaction-boundary evidence cannot suppress restoration.

The test uses Codex's automation-only trust bypass solely for its own disposable fixture and never changes user trust records. Desktop App activation is not covered by this probe. A direct App Server manual-compaction probe completed but did not execute fixture hooks, so it is not evidence of hook activation in the App.

- A unique fact from a Codex turn becomes searchable without manual import.
- Repeated capture and subsequent import do not duplicate messages.
- A new or resumed session receives bounded, project-scoped memory.
- A relevant prompt receives recall context; an unrelated prompt does not receive unrelated history.
- Manual and automatic compaction preserve a seeded fact through continuation without duplicate restore output.
- A missing or slow daemon does not stop the user's turn or native compaction.
- Installation preserves existing hooks and survives reinstall. Diagnostics report installed configuration separately from activation/trust, which cannot be inferred from `hooks.json` alone.
- Hook commands resolve the installed LCM executable independently of the session working directory.
- Claude integration tests remain green; native Codex CLI and App activation claims require their own runtime evidence.

## Open validation questions

- Which installed CLI and desktop App versions execute the documented events?
- Does desktop App trust review use the same activation path as CLI?
- Which terminal events fire for cancellation, crashes, and abrupt shutdown, and what recovery scan is necessary?
- What event ordering occurs around compaction, and which event reliably accepts restoration context?

See [setup and runtime limits](vscode-codex.md) for activation requirements.
