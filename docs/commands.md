# Commands

lossless-claude provides 10 slash commands available inside Claude Code sessions. All commands are prefixed with `/lcm-`.

## Command reference

### /lcm-compact

Compact unprocessed conversation messages into DAG summary nodes.

```
/lcm-compact [--all] [--dry-run] [--replay]
```

| Flag | Description |
|------|-------------|
| `--all` | Compact all projects (default: current project only) |
| `--dry-run` | Preview without writing |
| `--replay` | Re-compact sessions that already have summaries |

---

### /lcm-curate

Run the full memory curation pipeline: import, compact, and promote in sequence.

```
/lcm-curate [--all] [--dry-run] [--no-verbose]
```

Runs: `lcm import --verbose && lcm compact && lcm promote --verbose`

The pipeline stops on the first failure.

---

### /lcm-import

Import Claude Code session transcripts into lcm memory.

```
/lcm-import [--all] [--verbose] [--dry-run] [--replay]
```

| Flag | Description |
|------|-------------|
| `--all` | Import all projects |
| `--verbose` | Show per-session details |
| `--dry-run` | Preview without writing |
| `--replay` | Re-import all sessions chronologically, compacting each one inline to build a temporal DAG |

**When to use:**
- After installing lcm (backfill existing sessions)
- After a session with hook failures (recovery)
- After upgrading lcm

---

### /lcm-promote

Promote durable insights from summaries into cross-session memory.

```
/lcm-promote [--all] [--verbose] [--dry-run]
```

Extracts architectural decisions, bug root causes, and user preferences from summaries and promotes them to the semantic memory layer.

---

### /lcm-stats

Show memory inventory, compression ratios, and DAG statistics.

```
/lcm-stats
```

Uses the `lcm_stats` MCP tool with verbose output. Shows conversations, messages, summaries, promoted entries, and compression ratios.

---

### /lcm-status

Show daemon state and project memory statistics.

```
/lcm-status [--json]
```

Reports whether the daemon is running, its PID, uptime, and per-project memory counts.

---

### /lcm-doctor

Run diagnostics on the lossless-claude installation.

```
/lcm-doctor
```

Uses the `lcm_doctor` MCP tool. Checks daemon health, hook registration, MCP server connectivity, and summarizer status. Each check shows a pass/fail icon.

---

### /lcm-diagnose

Scan recent session transcripts for historical lcm issues.

```
/lcm-diagnose [--all] [--days N] [--verbose] [--json]
```

Looks for hook failures, MCP disconnects, and stale hook setups in past sessions. Complements `/lcm-doctor` (current state) with historical analysis.

---

### /lcm-sensitive

Manage sensitive patterns for secret redaction.

```
/lcm-sensitive list
/lcm-sensitive add <pattern>
/lcm-sensitive add --global <pattern>
/lcm-sensitive remove <pattern>
/lcm-sensitive test <text>
/lcm-sensitive purge [--all] --yes
```

See [Configuration > Sensitive Patterns](configuration.md#sensitive-patterns) for details on built-in and custom patterns.

---

### /lcm-dogfood

Run the lcm self-test suite — 39 checks across 10 phases.

```
/lcm-dogfood [phase]
```

**Phases:** `all` (default), `health`, `import`, `compact`, `promote`, `sensitive`, `pipeline`, `hooks`, `mcp`, `resilience`, `debug`

Tests all CLI commands, hooks, MCP tools, and resilience scenarios. Produces a scorecard with pass/fail/skip results.
