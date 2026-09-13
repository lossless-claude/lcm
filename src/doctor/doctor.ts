import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { lcmHome } from "../lcm-home.js";
import { join, dirname } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CheckResult, DoctorDeps } from "./types.js";
import { mergeClaudeSettings, REQUIRED_HOOKS, ensureLcmMd } from "../../installer/install.js";
import { mcpServerEntry } from "../installer/mcp-server-entry.js";
import { NATIVE_PATTERNS, ScrubEngine, readGitleaksSyncDate } from "../scrub.js";
import { GITLEAKS_PATTERNS } from "../generated-patterns.js";
import { projectDir } from "../daemon/project.js";
import { collectEventStats, collectDetailedEventStats } from "../db/events-stats.js";
import { BUILD_ID, PKG_VERSION } from "../daemon/version.js";
import { cliEntrypoint } from "../cli-entrypoint.js";
import { daemonOwnership } from "../daemon/lifecycle.js";
import { repairCommand } from "../hooks/fail-open.js";

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
    lcmHome: lcmHome(),
    platform: platform(),
  };
}

interface DoctorConfig {
  port: number;
  summarizer: string;
}

function loadConfig(deps: DoctorDeps): DoctorConfig {
  const configPath = join(deps.lcmHome, "config.json");
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

type PluginRegistration = { installed: boolean; enabled: boolean; key?: string; installPath?: string };

/** Look up the lcm plugin in Claude Code's plugin registry and enabledPlugins. */
function readLcmPluginRegistration(deps: DoctorDeps, settings: Record<string, unknown>): PluginRegistration {
  const registryPath = join(deps.homedir, ".claude", "plugins", "installed_plugins.json");
  let key: string | undefined;
  let installPath: string | undefined;
  try {
    const registry = JSON.parse(deps.readFileSync(registryPath, "utf-8")) as { plugins?: Record<string, unknown> };
    const plugins = registry?.plugins && typeof registry.plugins === "object" ? registry.plugins : {};
    key = Object.keys(plugins).find(k => k === "lcm" || k.startsWith("lcm@"));
    const entries = key ? plugins[key] : undefined;
    const entry = (Array.isArray(entries) ? entries[0] : entries) as { installPath?: unknown } | undefined;
    if (typeof entry?.installPath === "string") installPath = entry.installPath;
  } catch { /* no registry — plugin not installed */ }
  if (!key) return { installed: false, enabled: false };
  const enabledPlugins = settings.enabledPlugins as Record<string, unknown> | undefined;
  return { installed: true, enabled: enabledPlugins?.[key] !== false, key, installPath };
}

/**
 * The installed plugin must carry its prebuilt bundle: plugin.json calls
 * `bundle/lcm.js` directly, so without it no hook can run at all (node exits 1
 * before lcm gets a chance to fail open). Only a plugin whose own manifest
 * references the bundle is held to this; releases before it ran a launcher.
 */
function addPluginBundleCheck(results: CheckResult[], deps: DoctorDeps, plugin: PluginRegistration): void {
  if (!plugin.installed || !plugin.installPath) return;
  const manifestPath = join(plugin.installPath, ".claude-plugin", "plugin.json");
  let manifest = "";
  try {
    manifest = deps.readFileSync(manifestPath, "utf-8");
  } catch {
    // A registered plugin whose directory lost its manifest is the corrupted install this check exists for.
    results.push({
      name: "plugin-bundle", category: "Settings", status: "fail",
      message: `${manifestPath} unreadable — plugin install is incomplete\n     Fix: claude plugin update lcm@lossless-claude`,
    });
    return;
  }
  if (!manifest.includes("bundle/lcm.js")) return;
  const bundlePath = join(plugin.installPath, "bundle", "lcm.js");
  if (deps.existsSync(bundlePath)) {
    results.push({ name: "plugin-bundle", category: "Settings", status: "pass", message: bundlePath });
  } else {
    results.push({
      name: "plugin-bundle", category: "Settings", status: "fail",
      message: `${bundlePath} missing — no plugin hook can run\n     Fix: claude plugin update lcm@lossless-claude`,
    });
  }
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


function addCopilotProcessChecks(results: CheckResult[], deps: DoctorDeps): void {
  if (checkBinary(deps, "copilot")) {
    results.push({ name: "copilot-process", category: "Summarizer", status: "pass", message: "copilot CLI found" });
  } else {
    results.push({ name: "copilot-process", category: "Summarizer", status: "fail", message: "copilot CLI not found\n     Fix: npm install -g @github/copilot" });
  }
}


export function testMcpHandshake(spawnMcp: typeof spawn = spawn): Promise<CheckResult> {
  return new Promise((resolve) => {
    const request = {
      jsonrpc: "2.0", id: 1, method: "tools/list",
      params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "doctor", version: "0.1" },
      } },
    };
    const child = spawnMcp(process.execPath, [cliEntrypoint(), "mcp"], { stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const finish = (count = 0, message = `lcm: ${count}/7 tools`) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve({ name: "mcp-handshake-lcm", category: "MCP Servers", status: count === 7 ? "pass" : "warn", message });
    };
    const timer = setTimeout(() => finish(), 6000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        let response;
        try { response = JSON.parse(line); } catch { continue; }
        if (response?.id !== 1) continue;
        const tools = response.result?.tools;
        finish(response.result?.resultType === "complete" && Array.isArray(tools) ? tools.length : 0);
      }
    });
    child.on("close", () => finish());
    child.on("error", () => finish(0, "Could not spawn MCP process"));
    child.stdin.on("error", () => finish(0, "Could not write to MCP process"));
    // Keep stdin open until the response arrives; closing it can cancel SDK dispatch.
    child.stdin.write(JSON.stringify(request) + "\n");
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
  const sampled = stats.total > stats.scanned ? ` [sampled ${stats.scanned} of ${stats.total} project DBs, newest first]` : "";

  // Capture check
  if (stats.captured === 0) {
    results.push({ name: "events-capture", category: "Passive Learning", status: "warn", message: "No events captured — passive learning may not be active\n     Fix: run 'lcm install' to re-register hooks, then use a Bash or Edit tool to trigger the first event capture; re-run 'lcm doctor' to verify" });
  } else if (stats.unprocessed > 1000) {
    results.push({ name: "events-capture", category: "Passive Learning", status: "warn", message: `${stats.captured} events (${stats.unprocessed} unprocessed)${sampled} — events are promoted per project at session end, so inactive projects keep a backlog\n     Fix: lcm doctor -v  (per-project counts; backlogs drain when that project's next session ends)` });
  } else {
    results.push({ name: "events-capture", category: "Passive Learning", status: "pass", message: `${stats.captured} events captured (${stats.unprocessed} unprocessed)${sampled}` });
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
      ? "Summarizer: auto (Claude->claude-process, Codex->codex-process, Copilot->copilot-process)"
      : `Summarizer: ${config.summarizer}`,
  });

  // ── 1. Binary version ──
  const pkgVersion = PKG_VERSION;
  results.push({ name: "version", category: "Stack", status: pkgVersion ? "pass" : "warn", message: pkgVersion ? `v${pkgVersion}` : "Could not read version" });

  // ── 2. config.json ──
  const configPath = join(deps.lcmHome, "config.json");
  if (deps.existsSync(configPath)) {
    results.push({ name: "config", category: "Stack", status: "pass", message: configPath });
  } else {
    results.push({ name: "config", category: "Stack", status: "fail", message: `Missing — run: lcm install` });
  }

  // ── Daemon ──
  let daemonHealthy = false;
  let daemonVersion: string | undefined;
  let daemonBuild: string | undefined;
  try {
    const res = await deps.fetch(`http://127.0.0.1:${config.port}/health`);
    if (res.ok) {
      const h = (await res.json()) as { status?: string; version?: string; build?: string };
      daemonHealthy = h.status === "ok";
      daemonVersion = h.version;
      daemonBuild = h.build;
    }
  } catch {}

  if (daemonHealthy) {
    const pidFilePath = join(deps.lcmHome, "daemon.pid");
    const ownership = daemonOwnership({ status: "ok", version: daemonVersion, build: daemonBuild }, { version: pkgVersion, build: BUILD_ID });
    const versionMismatch = Boolean(pkgVersion && daemonVersion && daemonVersion !== pkgVersion);
    if (ownership === "incompatible") {
      // Newest wins: a newer, incompatible daemon is never restarted; this install must be updated.
      results.push({
        name: "daemon", category: "Daemon", status: "fail",
        message: `localhost:${config.port} — daemon v${daemonVersion} is newer than the installed v${pkgVersion} and incompatible; hooks and MCP fail open\n     Fix: ${repairCommand()}`,
      });
      daemonHealthy = false;
    } else if (ownership === "older-caller") {
      results.push({
        name: "daemon", category: "Daemon", status: "warn",
        message: `localhost:${config.port} (up) — daemon v${daemonVersion} is newer than the installed v${pkgVersion}; compatible\n     Fix: ${repairCommand()}`,
      });
    } else if (ownership === "restart") {
      // Stale daemon (older version, or same version from an older build) — restart it
      const runningLabel = versionMismatch ? `v${daemonVersion}` : `build ${daemonBuild}`;
      const installedLabel = versionMismatch ? `v${pkgVersion}` : `build ${BUILD_ID}`;
      try {
        const { ensureDaemon } = await import("../daemon/lifecycle.js");
        const { connected } = await ensureDaemon({ port: config.port, pidFilePath, spawnTimeoutMs: 10000, expectedVersion: pkgVersion, expectedBuild: BUILD_ID });

        // Re-fetch health to verify restart actually fixed the version
        let postRestartVersion: string | undefined;
        let postRestartBuild: string | undefined;
        let postRestartOk = false;
        if (connected) {
          try {
            const res = await deps.fetch(`http://127.0.0.1:${config.port}/health`);
            if (res.ok) {
              const h = (await res.json()) as { status?: string; version?: string; build?: string };
              postRestartOk = h.status === "ok";
              postRestartVersion = h.version;
              postRestartBuild = h.build;
            }
          } catch { /* non-fatal */ }
        }

        const versionFixed = !pkgVersion || postRestartVersion === pkgVersion;
        const buildFixed = !BUILD_ID || !postRestartBuild || postRestartBuild === BUILD_ID;
        const fixApplied = connected && postRestartOk && versionFixed && buildFixed;
        if (fixApplied) {
          results.push({
            name: "daemon", category: "Daemon", status: "warn",
            message: `localhost:${config.port} — restarted (${runningLabel} → ${installedLabel})`,
            fixApplied: true,
          });
          daemonHealthy = true;
        } else if (connected) {
          results.push({
            name: "daemon", category: "Daemon", status: "warn",
            message: `localhost:${config.port} — stale daemon (${runningLabel} running, ${installedLabel} installed); restart did not fix it\n     Fix: lcm daemon restart`,
            fixApplied: false,
          });
          daemonHealthy = false;
        } else {
          results.push({
            name: "daemon", category: "Daemon", status: "fail",
            message: `localhost:${config.port} — stale daemon (${runningLabel} running, ${installedLabel} installed); restart failed\n     Fix: lcm daemon restart`,
            fixApplied: false,
          });
          daemonHealthy = false;
        }
      } catch {
        results.push({ name: "daemon", category: "Daemon", status: "warn",
          message: `localhost:${config.port} — stale daemon (${runningLabel} running, ${installedLabel} installed)\n     Fix: lcm daemon restart` });
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
        pidFilePath: join(deps.lcmHome, "daemon.pid"),
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

  // Hooks are owned by the lcm Claude Code plugin, not settings.json.
  // Verify the plugin is actually registered and enabled; otherwise no hook fires at all.
  const plugin = readLcmPluginRegistration(deps, settingsData);
  addPluginBundleCheck(results, deps, plugin);
  const hooks = settingsData.hooks as Record<string, unknown[]> | undefined;
  const settingsHookEvents: string[] = [];
  for (const { event, command } of REQUIRED_HOOKS) {
    const entries = hooks?.[event];
    const found = Array.isArray(entries) && entries.some((e: any) =>
      Array.isArray(e?.hooks) && e.hooks.some((h: any) => h.command === command)
    );
    if (found) settingsHookEvents.push(event);
  }
  const legacyHooksComplete = settingsHookEvents.length === REQUIRED_HOOKS.length;
  const hookEventList = REQUIRED_HOOKS.map(h => h.event).join(", ");
  const installFix = "Fix: claude plugin marketplace add lossless-claude/lcm && claude plugin install lcm@lossless-claude  (then start a new Claude Code session)";

  if (!plugin.installed && legacyHooksComplete) {
    results.push({
      name: "hooks",
      category: "Settings",
      status: "pass",
      message: `${REQUIRED_HOOKS.map(h => `${h.event} \u2713`).join("  ")}  (via settings.json — plugin not installed)`,
    });
  } else if (!plugin.installed) {
    results.push({
      name: "hooks",
      category: "Settings",
      status: "fail",
      message: `lcm plugin not installed in Claude Code — no lcm hook fires (${hookEventList})\n     ${installFix}`,
    });
  } else if (!plugin.enabled) {
    results.push({
      name: "hooks",
      category: "Settings",
      status: "fail",
      message: `lcm plugin (${plugin.key}) is disabled in settings.json enabledPlugins — no lcm hook fires (${hookEventList})\n     Fix: enable it via /plugin in Claude Code, then start a new session`,
    });
  } else if (settingsHookEvents.length > 0) {
    // Plugin owns the hooks; copies left in settings.json (old installer) fire twice.
    try {
      settingsData = mergeClaudeSettings(settingsData);
      deps.writeFileSync(settingsPath, JSON.stringify(settingsData, null, 2));
      results.push({
        name: "hooks",
        category: "Settings",
        status: "warn",
        message: `Removed duplicate ${settingsHookEvents.join(", ")} from settings.json (plugin.json owns hooks)`,
        fixApplied: true,
      });
    } catch {
      results.push({
        name: "hooks",
        category: "Settings",
        status: "warn",
        message: `Duplicate ${settingsHookEvents.join(", ")} hook ${settingsHookEvents.length === 1 ? "entry" : "entries"} in ${settingsPath} — remove the \`hooks.${settingsHookEvents[0]}\` block(s) from that file, then run: lcm install`,
      });
    }
  } else {
    results.push({
      name: "hooks",
      category: "Settings",
      status: "pass",
      message: `${REQUIRED_HOOKS.map(h => `${h.event} \u2713`).join("  ")}  (plugin ${plugin.key})`,
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
      // mergeClaudeSettings strips lcm hooks from settings.json; only safe when the plugin actually fires them.
      const merged = plugin.installed && plugin.enabled ? mergeClaudeSettings(currentSettings) : { ...currentSettings };
      if (typeof merged.mcpServers !== "object" || merged.mcpServers === null) merged.mcpServers = {};
      (merged.mcpServers as Record<string, unknown>)["lcm"] = mcpServerEntry();
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
    addCopilotProcessChecks(results, deps);
  } else if (config.summarizer === "claude-process") {
    addClaudeProcessChecks(results, deps);
  } else if (config.summarizer === "codex-process") {
    addCodexProcessChecks(results, deps);
  } else if (config.summarizer === "copilot-process") {
    addCopilotProcessChecks(results, deps);
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
    const globalConfigPath = join(deps.lcmHome, "config.json");
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
