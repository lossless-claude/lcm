# Copilot code review — MCP setup

This file is **documentation, not configuration**. GitHub does not read it.

Copilot's MCP configuration lives in repository settings, not in the repo, so it cannot be version-controlled, reviewed in a pull request, or tested on a branch. This file exists so the configuration that *is* live has something in the repo to be checked against.

## One-time setup

**Settings → Copilot → coding agent → MCP configuration**, paste:

```json
{
  "mcpServers": {
    "codebase-memory": {
      "type": "local",
      "command": "/home/runner/.local/bin/codebase-memory-mcp",
      "args": [],
      "tools": [
        "list_projects",
        "index_status",
        "check_index_coverage",
        "get_architecture",
        "search_graph",
        "trace_path",
        "get_code_snippet",
        "query_graph",
        "get_graph_schema",
        "search_code",
        "detect_changes"
      ]
    }
  }
}
```

Also confirm **Allow Copilot to use MCP tools when reviewing pull requests** is enabled. It is on by default.

## How the pieces fit

| Piece | Where it lives | What it does |
|---|---|---|
| `.github/workflows/copilot-code-review.yml` | this repo | installs the pinned binary at `/home/runner/.local/bin/` and indexes the checkout, so the graph exists before Copilot starts |
| the JSON above | repo settings | registers the binary as a local stdio MCP server and declares which tools Copilot may call |
| `.github/skills/code-review/SKILL.md` | this repo | tells Copilot to actually use it — per GitHub's docs, the reviewer is *more likely* to use MCP context when a skill says so explicitly |

The tool list is read-only on purpose: `index_repository`, `manage_adr`, `ingest_traces` and `delete_project` are omitted so a review cannot mutate the graph. Indexing is the workflow's job.

## Why MCP and not the CLI

The CLI would be preferable — it would live entirely in the repo, be reviewable in a PR, and testable on a branch. But GitHub documents the reviewer's agentic surface as *full project context gathering* and *passing suggestions to the cloud agent*, with tool use defined as MCP servers plus agent skills. There is no documented way for a review to run a shell command, so there is nowhere for a CLI call to execute.

## Verifying it works

Two signals, both after a review runs:

1. **Attributions** at the bottom of review comments name the MCP server or skill that produced them.
2. **Session logs** — open the review session from the pull request timeline and check which MCP servers and tools were called.

If neither shows `codebase-memory`, check in order: the setup workflow succeeded, the binary path in the JSON matches where the workflow installed it, and MCP tools are enabled for code review.

## Keeping the version honest

`CBM_VERSION` in the workflow is pinned. Bumping it is a normal PR. An unpinned `latest` would change the review environment with no commit to point at, which is exactly the kind of silent drift the review rules elsewhere in this repo exist to prevent.
