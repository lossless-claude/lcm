## Available Commands

- `lcm search "query"` — Search episodic and promoted memory for the current project
- `lcm grep "pattern" --mode regex` — Regex search across messages and summaries
- `lcm describe <nodeId>` — Inspect metadata for a specific memory node
- `lcm expand <nodeId> --depth N` — Expand a summary node into lower-level detail
- `lcm store "content"` — Persist knowledge to promoted memory
- `lcm stats` — Show compression ratios and token savings
- `lcm doctor` — Run diagnostics
- `lcm diagnose` — Scan recent Claude Code transcripts for hook and MCP issues
- `lcm import` — Import Claude Code session transcripts into memory
- `lcm import --all` — Import from all projects
- `lcm compact --all` — Summarize all uncompacted sessions

Run `lcm --help` for all options.
