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

`lcm install` sets up Claude Code, Codex, and Oh My Pi. It installs the OMP hook globally and reports one outcome per harness. `lcm install --dry-run` previews the changes without writing anything.

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

The project connector writes `.omp/hooks/post/lcm.ts`. The global connector writes `<agentDir>/hooks/post/lcm.ts`, where `<agentDir>` is `PI_CODING_AGENT_DIR` when that environment variable is set, or `~/.omp/agent` otherwise. The project connector is selected from the current working directory; the global connector is selected from the agent directory.

Review and trust the installed hooks in Oh My Pi before expecting automatic capture. `doctor` can verify the file and connector configuration, but activation and trust cannot be proven from the filesystem; report that state as unknown, as with Codex.

## Lifecycle events

The installed module is loaded in-process by Oh My Pi. It uses the session manager for the session identity and transcript file, then sends lifecycle work to the local daemon. Hook failures do not block the Oh My Pi operation.

| Oh My Pi event | lcm behavior |
| --- | --- |
| `session_start` | Ingest pending transcript content, restore memory, and run the catch-up sweep for missed compaction work. |
| `before_agent_start` | Search memory for the prompt and return bounded prompt-time context. |
| `agent_end` | Capture the completed agent turn. |
| `session_stop` | Capture the final available transcript content. |
| `tool_result` | Record a `PostToolUse` or `PostToolUseFailure` tool event. |
| `session_before_compact` | Capture pending content, then compact lcm memory before Oh My Pi compacts its context. |
| `session_shutdown` | Make a final best-effort capture. |

## Session identity and transcript layout

The hook takes the session id from OMP's `sessionManager.getSessionId()` and the transcript path from `sessionManager.getSessionFile()`. OMP stores session transcripts under `<agentDir>/sessions/<encoded-cwd>/`, using the same `<agentDir>` selection as the connector. A session's id comes from the id in its session-file header; the transcript file, rather than a reconstructed path, is the source used for live capture.

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

`lcm import --replay` discovers all supported transcript sources unless a provider is selected explicitly. Use `--provider omp` or `--omp` when the run should select only OMP sessions. See [Import past sessions](import.md) for discovery, project selection, and cursor behavior.

## Verify captured memory

Run these from the project whose OMP session you want to check:

```bash
lcm search "a distinctive phrase from the session"
lcm grep "a distinctive phrase from the session" --scope messages
```

A matching result confirms that captured OMP content is searchable in the current project's memory. `lcm search` searches episodic and promoted memory; `lcm grep --scope messages` checks the stored raw messages directly.

## Remaining gaps

1. The connector does not register an MCP server for Oh My Pi ([#541](https://github.com/lossless-claude/lcm/issues/541)).
2. There is no OMP-specific summarizer provider. Summaries use the configured default summarizer, which on an OMP-only machine means an API provider ([#542](https://github.com/lossless-claude/lcm/issues/542)).
3. Archived `.jsonl.gz` OMP sessions are not imported ([#544](https://github.com/lossless-claude/lcm/issues/544)).
4. Import discovery scans the active agent directory (`PI_CODING_AGENT_DIR`, else `~/.omp/agent`). A session started under `omp --profile <name>` still captures live — the daemon accepts its transcript under the profile's own agent directory — but `lcm import` does not discover profile sessions yet ([#543](https://github.com/lossless-claude/lcm/issues/543)).
5. Hook activation and trust cannot be proven from the filesystem; diagnostics report that state as unknown, as with Codex.
6. Memory follows the session file in order, so a turn abandoned by an OMP rewind or branch switch is still captured ([#539](https://github.com/lossless-claude/lcm/issues/539)), and a `/clear` boundary is not honoured, so one conversation spans two logically separate sessions ([#540](https://github.com/lossless-claude/lcm/issues/540)).
