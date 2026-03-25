import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CheckResult, DoctorDeps } from "./types.js";
import { mergeClaudeSettings, REQUIRED_HOOKS, resolveBinaryPath, ensureLcmMd } from "../../installer/install.js";
import { BUILT_IN_PATTERNS, ScrubEngine } from "../scrub.js";
import { projectDir } from "../daemon/project.js";

const COLORS = {
  green: "\x1b[0;32m",
  yellow: "\x1b[1;33m",
  red: "\x1b[0;31m",
  cyan: "\x1b[0;36m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  nc: "\x1b[0m",
};

function defaultDeps(): DoctorDeps {
  return {
    existsSync,
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    mkdirSync: (p, o) => mkdirSync(p, o),
    spawnSync: (cmd, args, opts) => {
      const r = spawnSync(cmd, args, { encoding: "utf-8", ...opts });
      return { status: r.status, stdout: r.stdout as string, stderr: r.stderr as string };
    },
    fetch: globalThis.fetch,
    homedir: homedir(),
    platform: platform(),
  };
}

interface DoctorConfig {
  port: number;
  summarizer: string;
}

function loadConfig(deps: DoctorDeps): DoctorConfig {
  const configPath = join(deps.homedir, ".lossless-claude", "config.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(deps.readFileSync(configPath, "utf-8"));
  } catch {}

  const llm = config.llm as Record<string, string> | undefined;
  return {
    port: (config.daemon as Record<string, number> | undefined)?.port ?? (config as Record<string, unknown>).port as number ?? 3737,
    summarizer: llm?.provider ?? "disabled",
  };
}

function checkBinary(deps: DoctorDeps, command: string): boolean {
  return deps.spawnSync("sh", ["-c", `command -v ${command}`], {}).status === 0;
}

function addClaudeProcessChecks(results: CheckResult[], deps: DoctorDeps): void {
  if (checkBinary(deps, "claude")) {
    results.push({ name: "claude-process", category: "Summarizer", status: "pass", message: "claude CLI found" });
  } else {
    results.push({ name: "claude-process", category: "Summarizer", status: "fail", message: "claude CLI not found\n     Fix: npm install -g @anthropic-ai/claude-code" });
  }
}

function addCodexProcessChecks(results: CheckResult[], deps: DoctorDeps): void {
  if (checkBinary(deps, "codex")) {
    results.push({ name: "codex-process", category: "Summarizer", status: "pass", message: "codex CLI found" });
  } else {
    results.push({ name: "codex-process", category: "Summarizer", status: "fail", message: "codex CLI not found\n     Fix: npm install -g @openai/codex" });
  }
}


function testMcpHandshake(): Promise<CheckResult> {
  return new Promise((resolve) => {
    const initMsg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "doctor", version: "0.1" } } });
    const listMsg = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    // Resolve the binary relative to this file so it works outside Claude Code's PATH
    const binPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "lcm.js");
    const child = spawn(process.execPath, [binPath, "mcp"], { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => { child.kill(); }, 6000);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.on("close", () => {
      clearTimeout(timer);
      const lines = stdout.trim().split("\n");
      const toolsLine = lines.find((l) => l.includes('"tools/list"') || (l.includes('"tools"') && l.includes('"id":2')));
      if (toolsLine) {
        try {
          const parsed = JSON.parse(toolsLine);
          const count = parsed.result?.tools?.length ?? 0;
          resolve({ name: "mcp-handshake-lcm", category: "MCP Servers", status: count === 7 ? "pass" : "warn", message: `lcm: ${count}/7 tools` });
          return;
        } catch {}
      }
      resolve({ name: "mcp-handshake-lcm", category: "MCP Servers", status: "warn", message: `lcm: 0/7 tools` });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ name: "mcp-handshake-lcm", category: "MCP Servers", status: "warn", message: "Could not spawn MCP process" });
    });

    // Send initialize, wait 300ms, then send tools/list, then close stdin after 500ms
    child.stdin.write(initMsg + "\n");
    setTimeout(() => {
      child.stdin.write(listMsg + "\n");
      setTimeout(() => { child.stdin.end(); }, 500);
    }, 300);
  });
}

export async function runDoctor(overrides?: Partial<DoctorDeps>): Promise<CheckResult[]> {
  const deps = { ...defaultDeps(), ...overrides };
  const results: CheckResult[] = [];
  const config = loadConfig(deps);

  // ── Stack info ──
  results.push({
    name: "stack",
    category: "Stack",
    status: "pass",
    message: config.summarizer === "auto"
      ? "Summarizer: auto (Claude->claude-process, Codex->codex-process)"
      : `Summarizer: ${config.summarizer}`,
  });

  // ── 1. Binary version ──
  // dist/src/doctor/doctor.js → ../../.. → project root
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json");
  let pkgVersion: string | undefined;
  try {
    const pkg = JSON.parse(deps.readFileSync(pkgPath, "utf-8"));
    pkgVersion = pkg.version;
    results.push({ name: "version", category: "Stack", status: "pass", message: `v${pkgVersion}` });
  } catch {
    results.push({ name: "version", category: "Stack", status: "warn", message: "Could not read version" });
  }

  // ── 2. config.json ──
  const configPath = join(deps.homedir, ".lossless-claude", "config.json");
  if (deps.existsSync(configPath)) {
    results.push({ name: "config", category: "Stack", status: "pass", message: configPath });
  } else {
    results.push({ name: "config", category: "Stack", status: "fail", message: `Missing — run: lcm install` });
  }

  // ── Daemon ──
  let daemonHealthy = false;
  let daemonVersion: string | undefined;
  try {
    const res = await deps.fetch(`http://localhost:${config.port}/health`);
    if (res.ok) {
      const h = (await res.json()) as { status?: string; version?: string };
      daemonHealthy = h.status === "ok";
      daemonVersion = h.version;
    }
  } catch {}

  if (daemonHealthy) {
    const pidFilePath = join(deps.homedir, ".lossless-claude", "daemon.pid");
    if (pkgVersion && daemonVersion && daemonVersion !== pkgVersion) {
      // Version mismatch — auto-restart with expectedVersion to kill stale daemon and spawn fresh
      try {
        const { ensureDaemon } = await import("../daemon/lifecycle.js");
        const { connected } = await ensureDaemon({ port: config.port, pidFilePath, spawnTimeoutMs: 10000, expectedVersion: pkgVersion });
        results.push({
          name: "daemon", category: "Daemon",
          status: connected ? "warn" : "warn",
          message: connected
            ? `localhost:${config.port} — restarted (v${daemonVersion} → v${pkgVersion})`
            : `localhost:${config.port} — version mismatch (v${daemonVersion} running, v${pkgVersion} installed); restart failed\n     Fix: lcm daemon restart`,
          fixApplied: connected,
        });
        daemonHealthy = connected;
      } catch {
        results.push({ name: "daemon", category: "Daemon", status: "warn",
          message: `localhost:${config.port} — version mismatch (v${daemonVersion} running, v${pkgVersion} installed)\n     Fix: lcm daemon restart` });
      }
    } else {
      results.push({ name: "daemon", category: "Daemon", status: "pass", message: `localhost:${config.port} (up)` });
    }
  } else {
    // Auto-fix: try ensureDaemon
    try {
      const { ensureDaemon } = await import("../daemon/lifecycle.js");
      const { connected } = await ensureDaemon({
        port: config.port,
        pidFilePath: join(deps.homedir, ".lossless-claude", "daemon.pid"),
        spawnTimeoutMs: 10000,
      });
      if (connected) {
        results.push({ name: "daemon", category: "Daemon", status: "warn", message: `localhost:${config.port} — started`, fixApplied: true });
      } else {
        results.push({ name: "daemon", category: "Daemon", status: "fail", message: `localhost:${config.port} not responding\n     Fix: lcm daemon start` });
      }
    } catch {
      results.push({ name: "daemon", category: "Daemon", status: "fail", message: `localhost:${config.port} not responding\n     Fix: lcm daemon start` });
    }
  }

  // ── Settings ──
  const settingsPath = join(deps.homedir, ".claude", "settings.json");
  let settingsData: Record<string, unknown> = {};
  try {
    settingsData = JSON.parse(deps.readFileSync(settingsPath, "utf-8"));
  } catch {}

  // Hooks are owned by plugin.json, not settings.json.
  // If hooks leaked into settings.json (old installer), clean them up.
  const hooks = settingsData.hooks as Record<string, unknown[]> | undefined;
  const duplicateHooks: string[] = [];

  for (const { event, command } of REQUIRED_HOOKS) {
    const entries = hooks?.[event];
    const found = Array.isArray(entries) && entries.some((e: any) =>
      Array.isArray(e?.hooks) && e.hooks.some((h: any) => h.command === command)
    );
    if (found) duplicateHooks.push(event);
  }

  if (duplicateHooks.length > 0) {
    try {
      settingsData = mergeClaudeSettings(settingsData);
      deps.writeFileSync(settingsPath, JSON.stringify(settingsData, null, 2));
      results.push({
        name: "hooks",
        category: "Settings",
        status: "warn",
        message: `Removed duplicate ${duplicateHooks.join(", ")} from settings.json (plugin.json owns hooks)`,
        fixApplied: true,
      });
    } catch {
      results.push({
        name: "hooks",
        category: "Settings",
        status: "warn",
        message: `Duplicate ${duplicateHooks.join(", ")} hook ${duplicateHooks.length === 1 ? "entry" : "entries"} in ${settingsPath} — remove the \`hooks.${duplicateHooks[0]}\` block(s) from that file, then run: lcm install`,
      });
    }
  } else {
    results.push({
      name: "hooks",
      category: "Settings",
      status: "pass",
      message: REQUIRED_HOOKS.map(h => `${h.event} \u2713`).join("  "),
    });
  }

  // Re-read settings in case the hooks cleanup branch already modified the file
  let currentSettings: Record<string, unknown> = {};
  try { currentSettings = JSON.parse(deps.readFileSync(settingsPath, "utf-8")); } catch {}
  const mcpServers = currentSettings.mcpServers as Record<string, unknown> | undefined;
  // For local installs, settings.json is the canonical source for MCP servers (written by lcm install / doctor);
  // plugin.json may also declare mcpServers.lcm but is a secondary/optional registration path.
  if (mcpServers?.["lcm"]) {
    results.push({ name: "mcp-lcm", category: "Settings", status: "pass", message: "mcpServers.lcm registered in settings.json" });
  } else {
    try {
      const merged = mergeClaudeSettings(currentSettings);
      if (typeof merged.mcpServers !== "object" || merged.mcpServers === null) merged.mcpServers = {};
      // Use resolveBinaryPath for consistent binary resolution with installer
      const lcmBinary = resolveBinaryPath(deps);
      (merged.mcpServers as Record<string, unknown>)["lcm"] = { command: lcmBinary, args: ["mcp"] };
      deps.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
      results.push({ name: "mcp-lcm", category: "Settings", status: "warn", message: "mcpServers.lcm missing from settings.json — re-added automatically", fixApplied: true });
    } catch {
      results.push({ name: "mcp-lcm", category: "Settings", status: "fail", message: "mcpServers.lcm missing from settings.json — run: lcm install" });
    }
  }

  // ── lcm.md (Claude Code memory guidance file) ──
  const lcmMdPath = join(deps.homedir, ".claude", "lcm.md");
  const claudeMdPath = join(deps.homedir, ".claude", "CLAUDE.md");
  const lcmMdExists = deps.existsSync(lcmMdPath);
  const claudeMdHasRef = (() => {
    if (!deps.existsSync(claudeMdPath)) return false;
    try {
      const claudeContent = deps.readFileSync(claudeMdPath, "utf-8");
      const lcmBlockMatch = claudeContent.match(/<!--\s*lcm:start\s*-->[\s\S]*?<!--\s*lcm:end\s*-->/);
      if (!lcmBlockMatch) return false;
      return /@lcm\.md/.test(lcmBlockMatch[0]);
    } catch {
      return false;
    }
  })();

  const { LCM_MD_CONTENT } = await import("../daemon/orientation.js");
  const lcmMdStale = lcmMdExists
    ? (() => { try { return deps.readFileSync(lcmMdPath, "utf-8") !== LCM_MD_CONTENT; } catch { return true; } })()
    : false;

  if (lcmMdExists && claudeMdHasRef && !lcmMdStale) {
    results.push({ name: "lcm-md", category: "Settings", status: "pass", message: "~/.claude/lcm.md installed and referenced in CLAUDE.md" });
  } else {
    try {
      const { lcmMdWritten, claudeMdPatched } = ensureLcmMd(deps, LCM_MD_CONTENT, deps.homedir);
      const detail = [
        !lcmMdExists ? "wrote ~/.claude/lcm.md" : lcmMdWritten ? "updated stale ~/.claude/lcm.md" : null,
        claudeMdPatched ? "added @lcm.md to CLAUDE.md" : null,
      ].filter(Boolean).join(", ");
      results.push({ name: "lcm-md", category: "Settings", status: "warn", message: `lcm.md restored (${detail})`, fixApplied: true });
    } catch (err) {
      results.push({ name: "lcm-md", category: "Settings", status: "fail", message: `lcm.md repair failed: ${err instanceof Error ? err.message : String(err)} — run: lcm install` });
    }
  }

  // ── Summarizer (conditional) ──
  if (config.summarizer === "auto") {
    addClaudeProcessChecks(results, deps);
    addCodexProcessChecks(results, deps);
  } else if (config.summarizer === "claude-process") {
    addClaudeProcessChecks(results, deps);
  } else if (config.summarizer === "codex-process") {
    addCodexProcessChecks(results, deps);
  } else if (config.summarizer === "anthropic") {
    if (process.env.ANTHROPIC_API_KEY) {
      results.push({ name: "anthropic-key", category: "Summarizer", status: "pass", message: "ANTHROPIC_API_KEY set" });
    } else {
      results.push({ name: "anthropic-key", category: "Summarizer", status: "warn", message: "ANTHROPIC_API_KEY not set in environment" });
    }
  }

  // ── MCP handshake ──
  if (daemonHealthy) {
    try {
      const mcpResult = await testMcpHandshake();
      results.push(mcpResult);
    } catch {
      results.push({ name: "mcp-handshake-lcm", category: "MCP Servers", status: "warn", message: "Could not test MCP handshake" });
    }
  }

  // ── Security ──
  results.push({
    name: "built-in-patterns",
    category: "Security",
    status: "pass",
    message: `built-in patterns   ${BUILT_IN_PATTERNS.length} active`,
  });

  const cwd = deps.cwd ?? process.cwd();
  const patternsFile = join(projectDir(cwd), "sensitive-patterns.txt");
  const projectPatterns = await ScrubEngine.loadProjectPatterns(patternsFile);

  if (projectPatterns.length === 0) {
    results.push({
      name: "project-patterns",
      category: "Security",
      status: "warn",
      message: 'project patterns   none configured\n     Run: lcm sensitive add "<pattern>" to protect project-specific secrets',
    });
  } else {
    // Check for invalid patterns
    const invalidPatterns: string[] = [];
    for (const pat of projectPatterns) {
      try { new RegExp(pat); } catch { invalidPatterns.push(pat); }
    }
    if (invalidPatterns.length > 0) {
      results.push({
        name: "project-patterns",
        category: "Security",
        status: "warn",
        message: `project patterns   ${projectPatterns.length} configured (${invalidPatterns.length} invalid regex — will be skipped)`,
      });
    } else {
      results.push({
        name: "project-patterns",
        category: "Security",
        status: "pass",
        message: `project patterns   ${projectPatterns.length} configured`,
      });
    }
  }

  return results;
}

export function printResults(results: CheckResult[]): void {
  console.log(`\n${COLORS.bold}🧠 lcm${COLORS.nc}`);

  let currentCategory = "";

  for (const r of results) {
    if (r.category !== currentCategory) {
      currentCategory = r.category;
      const label = ` ${currentCategory} `;
      const dashes = "─".repeat(42 - 3 - label.length);
      console.log(`\n${COLORS.cyan}──${label}${dashes}${COLORS.nc}`);
    }
    if (r.name === "stack") {
      console.log(`    ${COLORS.dim}${r.message}${COLORS.nc}`);
      continue;
    }

    const icon =
      r.status === "pass" ? `${COLORS.green}✅${COLORS.nc}` :
      r.status === "warn" ? `${COLORS.yellow}⚠️ ${COLORS.nc}` :
                            `${COLORS.red}❌${COLORS.nc}`;
    const suffix = r.fixApplied ? ` ${COLORS.dim}(auto-fixed)${COLORS.nc}` : "";
    console.log(`    ${icon} ${COLORS.dim}${r.name}${COLORS.nc}  ${r.message}${suffix}`);
  }

  const pass = results.filter(r => r.status === "pass" && r.name !== "stack").length;
  const fail = results.filter(r => r.status === "fail").length;
  const warn = results.filter(r => r.status === "warn").length;

  console.log(`\n  ${pass} passed · ${fail} failed · ${warn} warnings\n`);
}

export function formatResultsPlain(results: CheckResult[]): string {
  const lines: string[] = [];

  // Group results by category
  const categories: Map<string, CheckResult[]> = new Map();
  for (const r of results) {
    if (!categories.has(r.category)) categories.set(r.category, []);
    categories.get(r.category)!.push(r);
  }

  for (const [category, items] of categories) {
    lines.push(`## ${category}`);

    // Stack entries (name === "stack") go as plain text before the table
    for (const r of items) {
      if (r.name === "stack") {
        lines.push(r.message);
      }
    }

    const tableItems = items.filter(r => r.name !== "stack");
    if (tableItems.length > 0) {
      lines.push("");
      lines.push("| Check | Status |");
      lines.push("|---|---|");
      for (const r of tableItems) {
        const icon = r.status === "pass" ? "✅" : r.status === "warn" ? "⚠️" : "❌";
        const suffix = r.fixApplied ? " (auto-fixed)" : "";
        lines.push(`| ${r.name} | ${icon} ${r.message}${suffix} |`);
      }
    }

    lines.push("");
  }

  const pass = results.filter(r => r.status === "pass" && r.name !== "stack").length;
  const fail = results.filter(r => r.status === "fail").length;
  const warn = results.filter(r => r.status === "warn").length;
  lines.push(`${pass} passed · ${fail} failed · ${warn} warnings`);
  return lines.join("\n");
}
