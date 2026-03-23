/**
 * CLI help text for lcm.
 *
 * Consumed by bin/lcm.ts:
 *   printHelp()           — full command reference (lcm --help)
 *   printHelp(command)    — per-command detail   (lcm compact --help)
 */

type FlagHelp = readonly [flag: string, description: string];
type ExampleHelp = readonly [command: string, description: string];

interface CommandHelp {
  summary: string;
  usage: string;
  options?: FlagHelp[];
  examples?: ExampleHelp[];
  notes?: string;
}

const HELP: Record<string, CommandHelp> = {
  install: {
    summary: "Set up lcm: register Claude Code hooks, configure the daemon, and connect the MCP server.",
    usage: "lcm install [--dry-run]",
    options: [
      ["--dry-run", "Preview all changes without writing anything"],
    ],
    examples: [
      ["lcm install", "Run the full setup wizard"],
      ["lcm install --dry-run", "Preview what install would do"],
    ],
  },

  uninstall: {
    summary: "Remove lcm hooks and MCP registration.",
    usage: "lcm uninstall [--dry-run]",
    options: [
      ["--dry-run", "Preview removals without writing anything"],
    ],
    examples: [
      ["lcm uninstall", "Remove all lcm integrations"],
      ["lcm uninstall --dry-run", "Preview what uninstall would do"],
    ],
  },

  daemon: {
    summary: "Start the context daemon that stores and processes memory.",
    usage: "lcm daemon start [--detach]",
    options: [
      ["--detach", "Run in the background; saves PID to ~/.lossless-claude/daemon.pid"],
    ],
    examples: [
      ["lcm daemon start --detach", "Start daemon in background (recommended)"],
      ["lcm daemon start", "Start daemon in foreground (for debugging)"],
    ],
    notes: "The daemon runs on port 3737 by default. Configure via ~/.lossless-claude/config.json.",
  },

  status: {
    summary: "Show daemon status, version, uptime, and project memory statistics.",
    usage: "lcm status [--json]",
    options: [
      ["--json", "Output structured JSON (useful for scripting)"],
    ],
    examples: [
      ["lcm status", "Show human-readable status"],
      ["lcm status --json", "Show machine-readable status"],
    ],
  },

  doctor: {
    summary: "Run diagnostics — checks daemon health, hooks, MCP server, and summarizer.",
    usage: "lcm doctor",
    examples: [
      ["lcm doctor", "Run all diagnostic checks"],
    ],
    notes: "Exits with code 1 if any check fails. Integrate into CI or shell startup for early detection.",
  },

  compact: {
    summary: "Compact conversation context into DAG summary nodes.",
    usage: "lcm compact [--all] [--dry-run] [--replay]",
    options: [
      ["--all", "Compact all tracked projects (default: current project only)"],
      ["--dry-run", "Show what would be compacted without writing anything"],
      ["--replay", "Compact sequentially, threading each summary through the prior context"],
    ],
    examples: [
      ["lcm compact", "Compact current project"],
      ["lcm compact --all", "Compact all tracked projects"],
      ["lcm compact --dry-run", "Preview compaction for current project"],
      ["lcm compact --all --replay", "Rebuild all projects with threaded context (slow)"],
    ],
    notes: "When invoked via the PreCompact hook (piped stdin), runs automatically during Claude Code context compaction.",
  },

  import: {
    summary: "Import Claude Code session transcripts into lossless memory.",
    usage: "lcm import [--all] [--verbose] [--dry-run] [--replay]",
    options: [
      ["--all", "Import all projects (default: current project only)"],
      ["--verbose", "Show per-session import detail"],
      ["--dry-run", "Preview without importing"],
      ["--replay", "Replay compaction for each imported session"],
    ],
    examples: [
      ["lcm import", "Import current project sessions"],
      ["lcm import --all", "Import all tracked projects"],
      ["lcm import --all --replay", "Import and compact with threaded context"],
      ["lcm import --dry-run", "Preview what would be imported"],
    ],
    notes: "Reads transcripts from ~/.claude/projects/. Already-imported sessions are skipped.",
  },

  promote: {
    summary: "Scan summaries and promote durable insights to long-term memory.",
    usage: "lcm promote [--all] [--verbose] [--dry-run]",
    options: [
      ["--all", "Promote across all tracked projects (default: current project)"],
      ["--verbose", "Show per-project counts"],
      ["--dry-run", "Preview promotions without writing"],
    ],
    examples: [
      ["lcm promote", "Promote insights for current project"],
      ["lcm promote --all", "Promote across all projects"],
      ["lcm promote --all --verbose", "Show detail for each project"],
      ["lcm promote --dry-run", "Preview what would be promoted"],
    ],
  },

  stats: {
    summary: "Show memory inventory: message counts, compression ratios, and summary statistics.",
    usage: "lcm stats [-v]",
    options: [
      ["-v, --verbose", "Show per-conversation breakdown"],
    ],
    examples: [
      ["lcm stats", "Summary view across all projects"],
      ["lcm stats -v", "Per-conversation detail"],
    ],
  },

  diagnose: {
    summary: "Scan recent sessions for hook failures, MCP disconnects, and stale state.",
    usage: "lcm diagnose [--all] [--days N] [--verbose] [--json]",
    options: [
      ["--all", "Scan all tracked projects (default: current project)"],
      ["--days N", "Scan the last N days (default: 7)"],
      ["--verbose", "Include full event details in output"],
      ["--json", "Output structured JSON"],
    ],
    examples: [
      ["lcm diagnose", "Scan last 7 days for current project"],
      ["lcm diagnose --days 30", "Scan last 30 days"],
      ["lcm diagnose --all --verbose", "Full detail across all projects"],
      ["lcm diagnose --json", "Machine-readable output"],
    ],
  },

  connectors: {
    summary: "Manage connectors for coding agents (Claude Code, Codex, Gemini, etc.).",
    usage: "lcm connectors <list|install|remove|doctor> [options]",
    options: [
      ["list [--format text|json]", "List available agents and installed connectors"],
      ["install <agent> [--type rules|mcp|skill]", "Install a connector for an agent"],
      ["remove <agent> [--type rules|mcp|skill]", "Remove a connector for an agent"],
      ["doctor [agent]", "Check connector health (all agents or one by name)"],
    ],
    examples: [
      ["lcm connectors list", "Show all agents and their connector status"],
      ["lcm connectors list --format json", "Machine-readable connector list"],
      ["lcm connectors install codex", "Install default connector for Codex"],
      ["lcm connectors install codex --type rules", "Install rules-based connector for Codex"],
      ["lcm connectors remove codex", "Remove the Codex connector"],
      ["lcm connectors doctor", "Check health of all connectors"],
      ["lcm connectors doctor codex", "Check Codex connector health"],
    ],
    notes: "Connector types: 'rules' (AGENTS.md injection), 'mcp' (MCP server), 'skill' (skill file).",
  },

  sensitive: {
    summary: "Manage sensitive patterns for automatic redaction before memory storage.",
    usage: "lcm sensitive <list|add|remove|test|purge> [options]",
    options: [
      ["list", "List active redaction patterns (built-in and custom)"],
      [`add "<pattern>" [--global]`, "Add a regex pattern (project-local by default; --global applies to all projects)"],
      [`remove "<pattern>"`, "Remove a custom redaction pattern"],
      [`test "<text>"`, "Test text against active patterns, showing what would be redacted"],
      ["purge [--all] [--yes]", "IRREVERSIBLY delete the project data directory, including stored memory and custom patterns (--all: all projects; --yes: skip confirm)"],
    ],
    examples: [
      ["lcm sensitive list", "Show all active patterns"],
      ['lcm sensitive add "sk-[a-zA-Z0-9]+"', "Add a project-local pattern to redact API keys starting with 'sk-'"],
      ['lcm sensitive add --global "sk-[a-zA-Z0-9]+"', "Add a global pattern that applies across all projects"],
      ['lcm sensitive remove "sk-[a-zA-Z0-9]+"', "Remove that pattern"],
      ['lcm sensitive test "my key is sk-abc123"', "See what gets redacted"],
      ["lcm sensitive purge --yes", "IRREVERSIBLY delete all stored memory and patterns for current project"],
      ["lcm sensitive purge --all --yes", "IRREVERSIBLY delete all stored memory and patterns for ALL projects"],
    ],
    notes: "Built-in patterns cover common secrets (API keys, tokens, passwords). Project patterns are stored in ~/.lossless-claude/projects/<id>/sensitive-patterns.txt; global patterns are stored in config.json. The 'purge' subcommand deletes the entire project data directory (including stored memory) and cannot be undone.",
  },

  mcp: {
    summary: "Start the lcm MCP server (used by Claude Code to expose memory tools).",
    usage: "lcm mcp",
    examples: [
      ["lcm mcp", "Start the MCP server (stdio transport)"],
    ],
    notes: "Normally launched automatically by Claude Code via the mcpServers config. No need to run manually.",
  },

  restore: {
    summary: "Dispatch the restore hook — restores prior context at session start.",
    usage: "lcm restore",
    examples: [
      ["lcm restore", "Restore context for the current session (called by SessionStart hook)"],
    ],
    notes: "Invoked automatically by the Claude Code SessionStart hook. Not intended for direct use.",
  },

  "session-end": {
    summary: "Dispatch the session-end hook — finalizes and stores session memory.",
    usage: "lcm session-end",
    examples: [
      ["lcm session-end", "Finalize session memory (called by Stop hook)"],
    ],
    notes: "Invoked automatically by the Claude Code Stop hook. Not intended for direct use.",
  },

  "user-prompt": {
    summary: "Dispatch the user-prompt hook — records context on each user message.",
    usage: "lcm user-prompt",
    examples: [
      ["lcm user-prompt", "Record user prompt context (called by PostToolUse hook)"],
    ],
    notes: "Invoked automatically by the Claude Code PostToolUse hook. Not intended for direct use.",
  },
};

const GROUPS = [
  {
    label: "Setup",
    commands: [
      { name: "install [--dry-run]", summary: "Register hooks, configure daemon, connect MCP" },
      { name: "uninstall [--dry-run]", summary: "Remove hooks and MCP registration" },
    ],
  },
  {
    label: "Runtime",
    commands: [
      { name: "daemon start [--detach]", summary: "Start the context daemon" },
      { name: "status [--json]", summary: "Daemon status and project memory stats" },
      { name: "doctor", summary: "Diagnostics: daemon, hooks, MCP, summarizer" },
      { name: "mcp", summary: "Start the MCP server (stdio transport)" },
    ],
  },
  {
    label: "Memory",
    commands: [
      { name: "compact [--all] [--dry-run] [--replay]", summary: "Compact conversations into DAG summaries" },
      { name: "import [--all] [--verbose] [--dry-run] [--replay]", summary: "Import Claude Code session transcripts" },
      { name: "promote [--all] [--verbose] [--dry-run]", summary: "Promote insights to long-term memory" },
      { name: "stats [-v]", summary: "Memory inventory and compression ratios" },
      { name: "diagnose [--all] [--days N] [--verbose] [--json]", summary: "Scan sessions for hook failures and issues" },
    ],
  },
  {
    label: "Connectors",
    commands: [
      { name: "connectors list [--format text|json]", summary: "List available agents and installed connectors" },
      { name: "connectors install <agent> [--type ...]", summary: "Install connector for a coding agent" },
      { name: "connectors remove <agent> [--type ...]", summary: "Remove connector for a coding agent" },
      { name: "connectors doctor [agent]", summary: "Check connector health" },
    ],
  },
  {
    label: "Sensitive",
    commands: [
      { name: "sensitive list", summary: "List active redaction patterns" },
      { name: "sensitive add <pattern>", summary: "Add a redaction pattern" },
      { name: "sensitive remove <pattern>", summary: "Remove a redaction pattern" },
      { name: "sensitive test <text>", summary: "Test text against active patterns" },
      { name: "sensitive purge [--all] [--yes]", summary: "Purge all project data (stored memory and patterns)" },
    ],
  },
  {
    label: "Hooks (internal)",
    commands: [
      { name: "restore", summary: "SessionStart hook — restore prior context" },
      { name: "session-end", summary: "Stop hook — finalize and store session memory" },
      { name: "user-prompt", summary: "PostToolUse hook — record user prompt context" },
    ],
  },
];

function pad(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

export function printHelp(command?: string): void {
  if (command) {
    printCommandHelp(command);
    return;
  }

  const lines: string[] = [
    "",
    "  lcm — lossless context management for Claude Code",
    "",
    "  Usage: lcm <command> [options]",
    "",
  ];

  for (const group of GROUPS) {
    lines.push(`  ${group.label}`);
    const maxNameLen = Math.max(...group.commands.map(c => c.name.length));
    for (const cmd of group.commands) {
      lines.push(`    ${pad(cmd.name, maxNameLen + 2)}${cmd.summary}`);
    }
    lines.push("");
  }

  lines.push("  Flags");
  lines.push("    -V, --version            Show version");
  lines.push("    -h, --help               Show this help");
  lines.push("");
  lines.push("  Run 'lcm <command> --help' for options and examples.");
  lines.push("");

  process.stdout.write(lines.join("\n") + "\n");
}

function printCommandHelp(command: string): void {
  const h = HELP[command];
  if (!h) {
    process.stderr.write(`Unknown command: ${command}\n`);
    printHelp();
    return;
  }

  const lines: string[] = [
    "",
    `  lcm ${command} — ${h.summary}`,
    "",
    `  Usage: ${h.usage}`,
    "",
  ];

  if (h.options && h.options.length > 0) {
    lines.push("  Options:");
    const maxLen = Math.max(...h.options.map(([f]) => f.length));
    for (const [flag, desc] of h.options) {
      lines.push(`    ${pad(flag, maxLen + 2)}${desc}`);
    }
    lines.push("");
  }

  if (h.examples && h.examples.length > 0) {
    lines.push("  Examples:");
    const maxLen = Math.max(...h.examples.map(([cmd]) => cmd.length));
    for (const [cmd, desc] of h.examples) {
      lines.push(`    ${pad(cmd, maxLen + 2)}${desc}`);
    }
    lines.push("");
  }

  if (h.notes) {
    lines.push(`  Note: ${h.notes}`);
    lines.push("");
  }

  process.stdout.write(lines.join("\n") + "\n");
}
