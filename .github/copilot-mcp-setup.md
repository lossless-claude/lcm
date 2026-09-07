# Copilot code review — MCP setup

This file is **documentation, not configuration**. GitHub does not read it.

Copilot's MCP configuration lives in repository settings, not in the repo, so it cannot be version-controlled, reviewed in a pull request, or tested on a branch. This file exists so the configuration that *is* live has something in the repo to be checked against.

## One-time setup

**Settings → Copilot → MCP servers** (sidebar, under "Code, planning, and automation"), paste into the "MCP configuration" section and click **Save MCP configuration** — the JSON is validated on save:

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

Then confirm **Settings → Copilot → Code review → Allow Copilot to use MCP tools when reviewing pull requests** is enabled. It is on by default, and it lives on a different page from the MCP configuration above.

The GitHub and Playwright MCP servers are enabled by default; the block above is added alongside them, not instead of them.

> **Copilot uses these tools autonomously and will not ask for approval first.** That is why the `tools` list below is read-only — GitHub's own guidance is to allowlist specific read-only tools rather than `"*"`.

## How the pieces fit

| Piece | Where it lives | What it does |
|---|---|---|
| `.github/workflows/copilot-code-review.yml` | this repo | installs the pinned binary at `/home/runner/.local/bin/` and indexes the checkout, so the graph exists before Copilot starts |
| the JSON above | repo settings | registers the binary as a local stdio MCP server and declares which tools Copilot may call |
| `.github/skills/code-review/SKILL.md` | this repo | tells Copilot to actually use it — per GitHub's docs, the reviewer is *more likely* to use MCP context when a skill says so explicitly |

The tool list is read-only on purpose: `index_repository`, `manage_adr`, `ingest_traces` and `delete_project` are omitted so a review cannot mutate the graph. Indexing is the workflow's job.

## Why MCP and not the CLI

The CLI would be preferable — it would live entirely in the repo, be reviewable in a PR, and testable on a branch. But GitHub documents the reviewer's agentic surface as *full project context gathering* and *passing suggestions to the cloud agent*, with tool use defined as MCP servers plus agent skills. There is no documented way for a review to run a shell command, so there is nowhere for a CLI call to execute.

## The cloud agent does not get this

The MCP *registration* is shared by Copilot code review and Copilot cloud agent, but the *environment* is not: code review uses `copilot-code-review.yml` when it exists, and the cloud agent uses `copilot-setup-steps.yml`. This repo only has the former, so the binary is installed for reviews and **not** for the agent that writes fixes.

That is worth revisiting. On #302 the cloud agent claimed to have closed four findings it had not actually closed — the kind of mistake `trace_path` exists to prevent. Giving the fixer the graph may matter more than giving the reviewer it. The change is to add a `copilot-setup-steps.yml` with the same install and index steps, or to move those steps there and let code review inherit them (it falls back to `copilot-setup-steps.yml` when `copilot-code-review.yml` is absent).

Left undone deliberately: reviews are the cheaper place to find out whether this works at all.

## Verifying it works

After a review runs, in order of directness:

1. **Session logs** — open the review session from the pull request timeline (**View session**) and read the "Setting up environment" section. It lists which MCP servers and tools were started and called. This is the authoritative signal.
2. **Attributions** at the bottom of individual review comments name the MCP server or skill that produced them. Absence here only means that *comment* did not use it.

If `codebase-memory` never appears, check in this order: the setup workflow succeeded, the `command` path in the JSON matches where the workflow installed the binary (`/home/runner/.local/bin/`), and MCP tools are enabled for code review.

## Keeping the version honest

`CBM_VERSION` in the workflow is pinned. Bumping it is a normal PR. An unpinned `latest` would change the review environment with no commit to point at, which is exactly the kind of silent drift the review rules elsewhere in this repo exist to prevent.
