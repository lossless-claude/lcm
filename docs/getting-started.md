# Getting Started

## Prerequisites

- Node.js 22+
- Claude Code installed and working

## Install

```bash
npm install -g @lossless-claude/lcm
```

Then register the plugin and run the setup wizard:

```bash
claude plugin add github:lossless-claude/lcm
lcm install
```

`lcm install` does four things:
1. Creates `~/.lossless-claude/config.json` with default settings
2. Registers 6 lifecycle hooks in `~/.claude/settings.json`
3. Configures the MCP server for in-session memory tools
4. Starts the background daemon

## Verify the installation

Run `/lcm-doctor` inside a Claude Code session (or `lcm doctor` from the terminal):

```
lcm doctor
```

All checks should show a pass icon. If any fail, see [Troubleshooting](troubleshooting.md).

## Your first session

Once installed, lossless-claude works automatically:

1. **Start a Claude Code session.** The `SessionStart` hook fires and restores context from any prior sessions in this project.

2. **Work normally.** Every message is stored in the background. The `UserPromptSubmit` hook searches memory and injects relevant context as hints before each response.

3. **Context fills up? No problem.** When the context window fills, the `PreCompact` hook intercepts Claude's native compaction and produces a lossless DAG summary instead.

4. **End the session.** The `SessionEnd` hook ingests the full transcript for future recall.

You don't need to do anything — memory capture, compaction, and restoration are all automatic.

## Manual memory operations

For deeper control, use slash commands from within Claude Code:

| Command | What it does |
|---------|-------------|
| `/lcm-stats` | See how much memory is stored and compression ratios |
| `/lcm-doctor` | Check system health |
| `/lcm-compact` | Manually trigger compaction |
| `/lcm-import` | Import transcripts from sessions that ran before lcm was installed |
| `/lcm-curate` | Run the full pipeline: import + compact + promote |

## Using memory tools

Claude can search and store memories during a session using [MCP tools](mcp.md):

- **`lcm_search`** — Find past decisions, discussions, or context across sessions
- **`lcm_store`** — Persist an important finding or decision for future sessions
- **`lcm_grep`** — Search for exact keywords or patterns in conversation history

These tools are available to Claude automatically. You can also ask Claude directly: "search memory for how we set up the auth system" and it will use the appropriate tool.

## What next?

- [Configuration](configuration.md) — Tune compaction thresholds, configure the summarizer, manage sensitive patterns
- [MCP Tools](mcp.md) — Full reference for all 7 memory tools
- [Commands](commands.md) — All 10 slash commands
- [Architecture](architecture.md) — How the DAG compaction and two-layer memory model work
