import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CheckResult, DoctorDeps } from "./types.js";
import { mergeClaudeSettings, REQUIRED_HOOKS, resolveBinaryPath, ensureLcmMd } from "../../installer/install.js";
import { NATIVE_PATTERNS, ScrubEngine, readGitleaksSyncDate } from "../scrub.js";
import { GITLEAKS_PATTERNS } from "../generated-patterns.js";
import { projectDir } from "../daemon/project.js";
import { collectEventStats, collectDetailedEventStats } from "../db/events-stats.js";

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

function formatTimeAgo(date: Date): string {
  const ms = Math.max(0, Date.now() - date.getTime());
  if (ms === 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function checkPassiveLearning(results: CheckResult[], hooksInstalled: boolean, verbose: boolean): void {
  if (!hooksInstalled) return;

  const stats = verbose ? collectDetailedEventStats(2000) : collectEventStats(2000);

  // Capture check
  if (stats.captured === 0) {
    results.push({ name: "events-capture", category: "Passive Learning", status: "warn", message: "No events captured — passive learning may not be active" });
  } else if (stats.unprocessed > 1000) {
    results.push({ name: "events-capture", category: "Passive Learning", status: "warn", message: `${stats.captured} events (${stats.unprocessed} unprocessed) — daemon may be offline — run: lcm daemon start` });
  } else {
    results.push({ name: "events-capture", category: "Passive Learning", status: "pass", message: `${stats.captured} events captured (${stats.unprocessed} unprocessed)` });
  }

  // Error check
  if (stats.errors >= 50) {
    results.push({ name: "events-errors", category: "Passive Learning", status: "fail", message: `${stats.errors} hook errors (30d) — check ~/.lossless-claude/logs/events.log` });
  } else if (stats.errors > 0) {
    results.push({ name: "events-errors", category: "Passive Learning", status: "warn", message: `${stats.errors} hook errors (30d) — check ~/.lossless-claude/logs/events.log` });
  } else {
    results.push({ name: "events-errors", category: "Passive Learning", status: "pass", message: "0 hook errors" });
  }

  // Staleness check
  if (stats.lastCapture) {
    const isoLastCapture = `${stats.lastCapture.replace(" ", "T")}Z`;
    const lastCaptureDate = new Date(isoLastCapture);
    const lastCaptureTime = lastCaptureDate.getTime();
    if (Number.isNaN(lastCaptureTime)) return;
    const daysSince = (Date.now() - lastCaptureTime) / (1000 * 60 * 60 * 24);
    if (daysSince >= 7) {
      results.push({ name: "events-staleness", category: "Passive Learning", status: "warn", message: `last capture ${Math.floor(daysSince)}d ago — hooks may not be firing if project is active` });
    } else {
      const ago = daysSince < 1 ? `${Math.floor(daysSince * 24)}h ago` : `${Math.floor(daysSince)}d ago`;
      results.push({ name: "events-staleness", category: "Passive Learning", status: "pass", message: `last capture ${ago}` });
    }
  }

  // Verbose: per-project breakdown
  if (verbose && "projects" in stats) {
    const detailed = stats as import("../db/events-stats.js").DetailedEventStats;
    for (const p of detailed.projects) {
      const ago = p.lastCapture ? formatTimeAgo(new Date(`${p.lastCapture.replace(" ", "T")}Z`)) : "never";
      results.push({ name: `events-project-${p.file}`, category: "Passive Learning", status: "pass", message: `${p.file.slice(0, 8)}… ${p.captured} events (${p.unprocessed} unprocessed) last: ${ago}` });
    }
    if (detailed.recentErrors.length > 0) {
      const errorLines = detailed.recentErrors.map(e => `  ${e.created_at} ${e.hook}: ${e.error}`).join("\n");
      results.push({ name: "events-recent-errors", category: "Passive Learning", status: "warn", message: `Recent errors:\n${errorLines}` });
    }
  }
}

export async function runDoctor(overrides?: Partial<DoctorDeps>, verbose = false): Promise<CheckResult[]> {
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
    const pkg = JSON.parse(deps.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    pkgVersion = typeof pkg.version === "string" ? pkg.version : undefined;
    results.push({ name: "version", category: "Stack", status: pkgVersion ? "pass" : "warn", message: pkgVersion ? `v${pkgVersion}` : "Could not read version" });
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
    const res = await deps.fetch(`http://127.0.0.1:${config.port}/health`);
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

        // Re-fetch health to verify restart actually fixed the version
        let postRestartVersion: string | undefined;
        let postRestartOk = false;
        if (connected) {
          try {
            const res = await deps.fetch(`http://127.0.0.1:${config.port}/health`);
            if (res.ok) {
              const h = (await res.json()) as { status?: string; version?: string };
              postRestartOk = h.status === "ok";
              postRestartVersion = h.version;
            }
          } catch { /* non-fatal */ }
        }

        const fixApplied = connected && postRestartOk && postRestartVersion === pkgVersion;
        if (fixApplied) {
          results.push({
            name: "daemon", category: "Daemon", status: "warn",
            message: `localhost:${config.port} — restarted (v${daemonVersion} → v${pkgVersion})`,
            fixApplied: true,
          });
          daemonHealthy = true;
        } else if (connected) {
          const runningVersion = postRestartVersion ?? daemonVersion;
          results.push({
            name: "daemon", category: "Daemon", status: "warn",
            message: `localhost:${config.port} — version mismatch (v${runningVersion} running, v${pkgVersion} installed); restart did not fix mismatch\n     Fix: lcm daemon restart`,
            fixApplied: false,
          });
          daemonHealthy = false;
        } else {
          results.push({
            name: "daemon", category: "Daemon", status: "fail",
            message: `localhost:${config.port} — version mismatch (v${daemonVersion} running, v${pkgVersion} installed); restart failed\n     Fix: lcm daemon restart`,
            fixApplied: false,
          });
          daemonHealthy = false;
        }
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

  // Gitleaks health check: verify generated-patterns.js exists and exports non-empty array
  const syncDate = readGitleaksSyncDate();
  const gitleaksCount = GITLEAKS_PATTERNS.length;
  if (gitleaksCount === 0) {
    results.push({
      name: "secret-detection",
      category: "Security",
      status: "fail",
      message: "No gitleaks patterns were loaded (GITLEAKS_PATTERNS is empty) — run: npx tsx scripts/update-gitleaks-patterns.ts",
    });
  } else {
    const syncNote = syncDate ? ` (synced ${syncDate})` : "";
    results.push({
      name: "secret-detection",
      category: "Security",
      status: "pass",
      message: `Secret detection\n     Built-in patterns:  ${gitleaksCount} (gitleaks${syncNote}) + ${NATIVE_PATTERNS.length} (native)\n     Manage patterns:    lcm sensitive add/remove`,
    });
  }

  const cwd = deps.cwd ?? process.cwd();
  const patternsFile = join(projectDir(cwd), "sensitive-patterns.txt");
  const projectPatterns = await ScrubEngine.loadProjectPatterns(patternsFile);

  // Load global user patterns count for informational display
  let globalUserPatternCount = 0;
  try {
    const { loadDaemonConfig } = await import("../daemon/config.js");
    const globalConfigPath = join(deps.homedir, ".lossless-claude", "config.json");
    const config = loadDaemonConfig(globalConfigPath);
    globalUserPatternCount = config.security?.sensitivePatterns?.length ?? 0;
  } catch {
    // config may not exist
  }

  // User patterns: informational only (no warning for zero patterns)
  if (projectPatterns.length > 0) {
    const invalidPatterns: string[] = [];
    for (const pat of projectPatterns) {
      try { new RegExp(pat); } catch { invalidPatterns.push(pat); }
    }
    if (invalidPatterns.length > 0) {
      results.push({
        name: "user-patterns",
        category: "Security",
        status: "warn",
        message: `User patterns:  ${globalUserPatternCount} global, ${projectPatterns.length} project (${invalidPatterns.length} invalid regex — will be skipped)`,
      });
    } else {
      results.push({
        name: "user-patterns",
        category: "Security",
        status: "pass",
        message: `User patterns:  ${globalUserPatternCount} global, ${projectPatterns.length} project`,
      });
    }
  } else {
    results.push({
      name: "user-patterns",
      category: "Security",
      status: "pass",
      message: `User patterns:  ${globalUserPatternCount} global, 0 project`,
    });
  }

  // ── Passive Learning ──
  const hooksInstalled = results.some(
    r => r.category === "Settings" && r.name === "hooks" && r.status !== "fail"
  );
  checkPassiveLearning(results, hooksInstalled, verbose);

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
