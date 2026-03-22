import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export const REQUIRED_HOOKS: { event: string; command: string }[] = [
  { event: "PreCompact", command: "lcm compact" },
  { event: "SessionStart", command: "lcm restore" },
  { event: "SessionEnd", command: "lcm session-end" },
  { event: "UserPromptSubmit", command: "lcm user-prompt" },
];

export function mergeClaudeSettings(existing: any): any {
  const settings = JSON.parse(JSON.stringify(existing));
  settings.hooks = (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)) ? settings.hooks : {};
  settings.mcpServers = (settings.mcpServers && typeof settings.mcpServers === "object" && !Array.isArray(settings.mcpServers)) ? settings.mcpServers : {};

  // Migrate old lossless-claude hook commands to lcm
  const OLD_TO_NEW: Record<string, string> = {
    "lossless-claude compact": "lcm compact",
    "lossless-claude restore": "lcm restore",
    "lossless-claude session-end": "lcm session-end",
    "lossless-claude user-prompt": "lcm user-prompt",
  };
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    for (const entry of settings.hooks[event]) {
      if (!Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (h.command && OLD_TO_NEW[h.command]) {
          h.command = OLD_TO_NEW[h.command];
        }
      }
      // Deduplicate commands within each hook entry after migration
      const seen = new Set<string>();
      entry.hooks = entry.hooks.filter((h: any) => {
        const key = h.command ?? '';
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }
  // Remove legacy MCP server entries
  delete settings.mcpServers["lossless-claude"];

  // Remove lcm hooks from settings.json — plugin.json owns them.
  // Having hooks in both causes double-firing.
  for (const { event, command } of REQUIRED_HOOKS) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event]
      .map((entry: any) => {
        if (!Array.isArray(entry.hooks)) return entry;
        return {
          ...entry,
          hooks: entry.hooks.filter((h: any) => h.command !== command),
        };
      })
      .filter((entry: any) => !Array.isArray(entry.hooks) || entry.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  // Drop empty mcpServers shell; lcm is now registered via settings.json (not removed here)
  if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;

  return settings;
}

export interface ServiceDeps {
  spawnSync: (cmd: string, args: string[], opts?: any) => SpawnSyncReturns<string>;
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string, opts?: any) => void;
  existsSync: (path: string) => boolean;
  promptUser: (question: string) => Promise<string>;
  ensureDaemon?: (opts: { port: number; pidFilePath: string; spawnTimeoutMs: number }) => Promise<{ connected: boolean }>;
  runDoctor?: () => Promise<Array<{ name: string; status: string; category?: string; message?: string }>>;
}

async function readlinePrompt(question: string): Promise<string> {
  const rl = (await import("node:readline/promises")).createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const defaultDeps: ServiceDeps = { spawnSync: spawnSync as any, readFileSync: (path, encoding) => readFileSync(path, encoding as BufferEncoding) as string, writeFileSync, mkdirSync, existsSync, promptUser: readlinePrompt };

export function resolveBinaryPath(deps: Pick<ServiceDeps, "spawnSync" | "existsSync"> = defaultDeps): string {
  const result = deps.spawnSync("sh", ["-c", "command -v lcm"], { encoding: "utf-8" });
  if (result.status === 0 && typeof result.stdout === "string" && result.stdout.trim()) {
    return result.stdout.trim();
  }

  const fallbacks = [
    join(homedir(), ".npm-global", "bin", "lcm"),
    "/usr/local/bin/lcm",
    "/opt/homebrew/bin/lcm",
  ];
  for (const p of fallbacks) {
    if (deps.existsSync(p)) return p;
  }

  return "lcm";
}


type SummarizerConfig = {
  provider: "auto" | "anthropic" | "openai";
  model: string;
  apiKey: string;
  baseURL: string;
};

async function pickSummarizer(deps: ServiceDeps): Promise<SummarizerConfig> {
  // Non-TTY (CI, piped stdin): skip interactive picker, default to auto.
  if (!process.stdin.isTTY) {
    return { provider: "auto", model: "", apiKey: "", baseURL: "" };
  }

  console.log("\n  ─── Summarizer (for conversation compaction)\n");
  console.log("  1) Native CLI default (recommended — Claude uses claude-process, Codex uses codex-process)");
  console.log("  2) Anthropic API     (direct API access — requires API key)");
  console.log("  3) Custom server     (any OpenAI-compatible URL)");
  console.log("");

  let choice = (await deps.promptUser("  Pick [1]: ")).trim();
  if (!["1", "2", "3"].includes(choice)) {
    console.log("  Invalid choice — please enter 1, 2, or 3.");
    choice = (await deps.promptUser("  Pick [1]: ")).trim();
  }
  if (!["1", "2", "3"].includes(choice)) {
    choice = "1"; // default after two invalid attempts
  }

  if (choice === "1") {
    return { provider: "auto", model: "", apiKey: "", baseURL: "" };
  }

  if (choice === "2") {
    const apiKey = process.env.ANTHROPIC_API_KEY ? "${ANTHROPIC_API_KEY}" : "";
    return { provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKey, baseURL: "" };
  }

  if (choice === "3") {
    const baseURL = (await deps.promptUser("  Server URL (e.g. http://192.168.1.x:8080/v1): ")).trim();
    const model = (await deps.promptUser("  Model name: ")).trim();
    return { provider: "openai", model, apiKey: "", baseURL };
  }

  // Fallback (should not reach here)
  return { provider: "auto", model: "", apiKey: "", baseURL: "" };
}

// ── Health-wait ──

export async function waitForHealth(
  url: string,
  timeoutMs: number = 10000,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(url);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

export async function install(deps: ServiceDeps = defaultDeps): Promise<void> {
  const lcDir = join(homedir(), ".lossless-claude");
  deps.mkdirSync(lcDir, { recursive: true });

  // 1. Create or update config.json
  const configPath = join(lcDir, "config.json");
  if (!deps.existsSync(configPath)) {
    const summarizerConfig = await pickSummarizer(deps);
    const { loadDaemonConfig } = await import("../src/daemon/config.js");
    const defaults = loadDaemonConfig("/nonexistent");
    defaults.llm = { ...defaults.llm, ...summarizerConfig };
    deps.writeFileSync(configPath, JSON.stringify(defaults, null, 2));
    console.log(`Created ${configPath}`);
  }

  // 2. Merge ~/.claude/settings.json (hooks + MCP)
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let existing: any = {};
  if (deps.existsSync(settingsPath)) {
    try { existing = JSON.parse(deps.readFileSync(settingsPath, "utf-8")); } catch {}
  }
  const merged = mergeClaudeSettings(existing);

  // Register MCP server directly in settings.json.
  // plugin.json mcpServers isn't reliably processed for locally-installed plugins
  // (installPath in installed_plugins.json points to wrong versioned dir).
  if (typeof merged.mcpServers !== "object" || merged.mcpServers === null) {
    merged.mcpServers = {};
  }
  const lcmBin = resolveBinaryPath(deps);
  merged.mcpServers["lcm"] = { command: lcmBin, args: ["mcp"] };

  deps.mkdirSync(join(homedir(), ".claude"), { recursive: true });
  deps.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
  console.log(`Updated ${settingsPath}`);

  // 3. Install slash commands to ~/.claude/commands/
  const commandsSrc = join(dirname(new URL(import.meta.url).pathname), "../..", ".claude-plugin", "commands");
  const commandsDst = join(homedir(), ".claude", "commands");
  if (deps.existsSync(commandsSrc)) {
    deps.mkdirSync(commandsDst, { recursive: true });
    for (const file of readdirSync(commandsSrc)) {
      if (file.endsWith(".md")) {
        copyFileSync(join(commandsSrc, file), join(commandsDst, file));
      }
    }
    console.log(`Installed slash commands to ${commandsDst}`);
  }

  // 4. Start daemon (lazy daemon — no persistent service)
  const configData = deps.existsSync(configPath)
    ? JSON.parse(deps.readFileSync(configPath, "utf-8"))
    : {};
  console.log("Verifying daemon...");
  const _ensureDaemon = deps.ensureDaemon ?? (async (opts) => {
    const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
    return ensureDaemon(opts);
  });
  const daemonPort = configData?.daemon?.port ?? configData?.port ?? 3737;
  const { connected } = await _ensureDaemon({
    port: daemonPort,
    pidFilePath: join(lcDir, "daemon.pid"),
    spawnTimeoutMs: 30000,
  });
  if (!connected) {
    console.warn("Warning: daemon not responding — run: lcm doctor");
  } else {
    console.log("Daemon started successfully.");
  }

  // 5. Final verification
  console.log("\nRunning doctor...");
  const _runDoctor = deps.runDoctor ?? (async () => {
    const { runDoctor, printResults: _print } = await import("../src/doctor/doctor.js");
    const _results = await runDoctor();
    _print(_results);
    return _results;
  });
  const results = await _runDoctor();
  const failures = results.filter((r: { status: string }) => r.status === "fail");
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed. Run 'lcm doctor' for details.`);
  } else {
    console.log("lcm installed successfully! All checks passed.");
  }
}

// Re-export rmSync so uninstall.ts can share the pattern
export { rmSync };
