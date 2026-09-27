# Oh My Pi setup

Oh My Pi uses native lifecycle hooks for automatic memory capture, recall, and compaction continuity. The connector uses the same lcm daemon and memory backend as Claude Code and Codex.

## Install from a repo checkout

If you are working from this repository directly instead of the published npm package:

```bash
npm install
npm run build
chmod +x dist/bin/lcm.js
npm link
```

If you do not want a global link, run `node dist/bin/lcm.js ...` instead of `lcm ...` in the commands below.

## Install the Oh My Pi connector

`lcm install` sets up Claude Code, Codex, and Oh My Pi. It installs the OMP hook globally, registers the lcm MCP server in OMP's global MCP config, and reports one outcome per harness. The MCP entry names the absolute path of the CLI that ran the install, so `lcm install` from the Claude Code plugin installs the hook only; run it from the npm CLI to register the MCP server. `lcm install --dry-run` previews the changes without writing anything.

For Oh My Pi in the current repository only:

```bash
lcm connectors install omp
lcm connectors doctor omp
```

For the global Oh My Pi agent configuration:

```bash
lcm connectors install omp --global
lcm connectors doctor omp --global
```

Remove the project or global connector with the matching command:

```bash
lcm connectors remove omp
lcm connectors remove omp --global
```

The project connector writes `.omp/hooks/post/lcm.ts`. The global connector writes `<agentDir>/hooks/post/lcm.ts`, where `<agentDir>` is `PI_CODING_AGENT_DIR` when that environment variable is set, or `~/.omp/agent` otherwise. Only `--global` selects the global connector: without it, the project connector lives in the current working directory, even when that directory is your home.

## Register the MCP server

The MCP server gives the OMP agent lcm's tools (`lcm_search`, `lcm_store`, and the rest) without a shell command. `lcm install` registers it globally; to register or remove it by hand:

```bash
lcm connectors install omp --type mcp
lcm connectors install omp --type mcp --global
lcm connectors remove omp --type mcp
lcm connectors remove omp --type mcp --global
```

The project connector adds `mcpServers.lcm` to `.omp/mcp.json`; the global connector adds it to `<agentDir>/mcp.json`. These are the files OMP's own `/mcp` command edits, and other servers in them are kept. Restart OMP to load the server. The learning instruction keeps its CLI wording, which holds whether or not the MCP server is registered.

Review and trust the installed hooks in Oh My Pi before expecting automatic capture. `doctor` can verify the file and connector configuration, but activation and trust cannot be proven from the filesystem; report that state as unknown, as with Codex.

The installed hook is a copy of the one lcm ships, so an upgrade does not change it. `lcm connectors doctor omp` and `lcm doctor` report a hook that differs from the shipped one; reinstall it with the same `lcm connectors install omp` command, or `lcm install`. When `omp` is on PATH, `lcm doctor` also warns when the global or project hook or MCP server is missing.

## Lifecycle events

The installed module is loaded in-process by Oh My Pi. It uses the session manager for the session identity and transcript file, then sends lifecycle work to the local daemon. Hook failures do not block the Oh My Pi operation.
It keeps bounded operation counts and failure codes in two alternating snapshots under lcm's `logs/` directory. `lcm doctor -v` reads recent snapshots for the current project. Fire-and-forget capture calls are recorded as submitted, not accepted; a lost response cannot establish completion. Awaited calls distinguish an observed HTTP rejection from an unconfirmed transport failure.

| Oh My Pi event | lcm behavior |
| --- | --- |
| `session_start` | Ingest pending transcript content, restore memory, and run the catch-up sweep for missed compaction work. |
| `before_agent_start` | Search memory for the prompt and return bounded prompt-time context, and append the learning instruction (CLI wording, `src/guidance.ts`) to the system prompt OMP passes, so it reaches every turn without showing in the conversation. The hint budget still holds back `restoration.reservedForLearningInstruction`, as it does for every caller; the instruction adds nothing beyond that. A host that passes no system prompt gets the instruction in the memory message instead, and the hint budget reserves the larger of that setting and the instruction's bytes. |
| `agent_end` | Capture the completed agent turn. |
| `session_stop` | Capture the final available transcript content. |
| `tool_result` | Record a `PostToolUse` or `PostToolUseFailure` tool event. |
| `session_before_compact` | Await a bounded `/ingest` Capture only when OMP supplies a transcript path, then submit lcm summarization after confirmed Capture. A missing source, unconfirmed delivery, or rejected Capture skips that lcm summary; Oh My Pi's own compaction continues. |
| `session_shutdown` | Make a final best-effort capture. |

## Session identity and transcript layout

The hook takes the session id from OMP's `sessionManager.getSessionId()` and the transcript path from `sessionManager.getSessionFile()`. OMP stores session transcripts under `<agentDir>/sessions/<encoded-cwd>/`, using the same `<agentDir>` selection as the connector. A session's id comes from the id in its session-file header; the transcript file, rather than a reconstructed path, is the source used for live capture.

A session file is an append-only tree: every entry names its parent, and a rewind or branch switch moves the leaf while the abandoned continuation stays in the file. Capture and import keep only the path the user kept — the `parentId` chain from the file's last entry, which is the leaf OMP itself resumes from. Each capture applies this to the entries appended since the previous one, so a turn abandoned before it was captured is never stored. A turn captured before a later rewind abandoned it stays in memory. A file written before OMP's tree format, whose entries carry no id, is read in file order.

`/clear` keeps the session id and file and appends a `reset_boundary` entry. Capture and import store each side of a clear on the live path as its own conversation under the same session id: the turns before it stay stored and searchable, and restore reads only what followed it. With nothing said since the clear, restore answers as for a fresh session start. A clear a rewind abandoned opens nothing. After a rewind to before a stored clear, the later turns go to the conversation that clear opened. A conversation stored before clears were honoured keeps both sides.

## Import existing sessions

Import OMP sessions for the current project with either spelling:

```bash
lcm import --provider omp --dry-run
lcm import --omp --dry-run
lcm import --provider omp
lcm import --omp
```

Add `--replay` to compact each selected session with threaded context, resuming recorded replay progress:

```bash
lcm import --provider omp --replay
lcm import --omp --replay
```

`lcm import` discovers all supported transcript sources unless a provider is selected explicitly. Use `--provider omp` or `--omp` when the run should select only OMP sessions. See [Import past sessions](import.md) for discovery, project selection, and cursor behavior.

OMP discovery scans every agent directory a profile session could live under: the active one (`PI_CODING_AGENT_DIR`, else `~/.omp/agent`) plus `~/.omp/profiles/<name>/agent` for every named profile — the same roots live capture accepts a transcript from, except a profile reached through a symlinked `profiles`, `<name>` or `agent` directory, which is not scanned. A session id found in several roots is imported once, from the live copy over an archived one, else the newest, else the active root's; each skipped copy is listed in the result. Running `--provider omp` or `--omp` reports every root scanned alongside the result (both `--dry-run` output and a non-interactive or `--verbose` run), so a "0 sessions" result names where discovery looked.

## Verify captured memory

Run these from the project whose OMP session you want to check:

```bash
lcm search "a distinctive phrase from the session"
lcm grep "a distinctive phrase from the session" --scope messages
```

A matching result confirms that captured OMP content is searchable in the current project's memory. `lcm search` searches episodic and promoted memory; `lcm grep --scope messages` checks the stored raw messages directly.

## Archived sessions

`omp gc --apply` archives a cold session by gzipping it in place, alongside the live files: `<agentDir>/sessions/<encoded-cwd>/<name>.jsonl.gz`. `lcm import` discovers these the same way as live `.jsonl` files. An archive is a single gzip member, not an append-only file, so it is import-only: it is read in full on every import and takes no resume checkpoint, and a repeated import stays idempotent because capture writes only the messages past what is already stored. If a live `.jsonl` and an archived `.jsonl.gz` both exist for the same session id, the live file always wins — `omp gc --apply` normally removes the original once it archives it, so a surviving live file means OMP is still writing to that session.

## Summarizer

In an OMP session, `LCM_SUMMARY_PROVIDER=auto` (the default) resolves to `omp-process`,
which spawns `omp --print --mode json` with tools, LSP, extensions, skills and rules
disabled and the run made ephemeral (`--no-session`). It reports usage the same way as
`codex-process` (input, cached, output tokens); which model runs is whatever `omp` is
configured with, unless `llm.model` names one. See
[Model selection](configuration.md#model-selection) for pinning a different provider.

## Remaining gaps

1. Hook activation and trust cannot be proven from the filesystem; diagnostics report that state as unknown, as with Codex.
2. The conversation a `/clear` closes is not compacted afterwards: `/compact` and the catch-up sweep reach only the session's newest conversation. Its raw messages stay searchable ([#540](https://github.com/lossless-claude/lcm/issues/540)).
3. A turn captured before a rewind or branch switch abandoned it stays in memory and still matches `lcm search` and `lcm grep`; only turns abandoned before their capture are left out ([#539](https://github.com/lossless-claude/lcm/issues/539)). When a branch abandoned before its capture is later reopened with `/tree`, the session's continuation from it is captured but the branch's earlier turns are not.
4. Passive learning records the OMP tools translated to extractor shapes; the harness's own memory tools and other non-durable plumbing remain intentionally silent.
5. `*.jsonl.*.bak` recovery files (OMP falls back to these when a primary session file is missing) are not discovered.
