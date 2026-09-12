import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mergeClaudeSettings } from "./installer/settings.js";
import { loadDaemonConfig } from "./daemon/config.js";
import { lcmPath } from "./lcm-home.js";

export interface EnsureCoreDeps {
  configPath: string;
  settingsPath: string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  chmodSync?: (path: string, mode: number) => void;
  ensureDaemon: (opts: { port: number; pidFilePath: string; spawnTimeoutMs: number }) => Promise<{ connected: boolean }>;
}

function defaultDeps(): EnsureCoreDeps {
  return {
    configPath: lcmPath("config.json"),
    settingsPath: join(homedir(), ".claude", "settings.json"),
    existsSync,
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    mkdirSync,
    chmodSync: chmodSync,
    ensureDaemon: async (opts) => {
      const { ensureDaemon } = await import("./daemon/lifecycle.js");
      return ensureDaemon(opts);
    },
  };
}

/**
 * Record the node interpreter this process is running under in config.json, so the
 * plugin's static `.claude-plugin/lcm-mcp.sh` launcher — which cannot depend on PATH
 * resolving node either — can read a measured, working path instead of guessing.
 * Read-modify-write: preserves every other key, and only rewrites when the recorded
 * path is stale (e.g. after an nvm switch or node upgrade).
 */
function recordMcpNodePath(deps: EnsureCoreDeps): void {
  let raw: unknown;
  try {
    raw = JSON.parse(deps.readFileSync(deps.configPath, "utf-8"));
  } catch {
    return; // config.json missing or unreadable — nothing to patch
  }
  if (typeof raw !== "object" || raw === null) return;
  const config = raw as Record<string, unknown>;
  if (config.mcpNodePath === process.execPath) return;
  try {
    deps.writeFileSync(deps.configPath, JSON.stringify({ ...config, mcpNodePath: process.execPath }, null, 2));
  } catch (err) {
    // Don't throw: a config that cannot be written must not stop the daemon from
    // starting. But don't swallow either — the launcher then falls back to PATH
    // for good, which is the failure this whole change exists to remove, and it
    // would look identical to never having tried.
    console.error("lcm: could not record mcpNodePath in config.json:", err instanceof Error ? err.message : err);
  }
}

export async function ensureCore(deps: EnsureCoreDeps = defaultDeps()): Promise<void> {
  // 1. Create config.json with defaults if missing
  if (!deps.existsSync(deps.configPath)) {
    deps.mkdirSync(dirname(deps.configPath), { recursive: true });
    const defaults = loadDaemonConfig("/nonexistent");
    deps.writeFileSync(deps.configPath, JSON.stringify(defaults, null, 2));
    try {
      deps.chmodSync?.(deps.configPath, 0o600);
    } catch {}
  }
  recordMcpNodePath(deps);

  // 2. Clean stale/duplicate hooks from settings.json (fixes #94)
  // Only rewrite settings.json if mergeClaudeSettings actually changed the data
  if (deps.existsSync(deps.settingsPath)) {
    try {
      const existing = JSON.parse(deps.readFileSync(deps.settingsPath, "utf-8"));
      const merged = mergeClaudeSettings(existing);
      if (JSON.stringify(existing) !== JSON.stringify(merged)) {
        deps.mkdirSync(dirname(deps.settingsPath), { recursive: true });
        deps.writeFileSync(deps.settingsPath, JSON.stringify(merged, null, 2));
      }
    } catch {}
  }

  // 3. Start daemon if not running
  const config = loadDaemonConfig(deps.configPath);
  await deps.ensureDaemon({
    port: config.daemon?.port ?? 3737,
    pidFilePath: join(dirname(deps.configPath), "daemon.pid"),
    spawnTimeoutMs: 5000,
  });
}

export interface BootstrapDeps extends EnsureCoreDeps {
  flagExists: (path: string) => boolean;
  writeFlag: (path: string) => void;
}

function defaultBootstrapDeps(): BootstrapDeps {
  return {
    ...defaultDeps(),
    flagExists: existsSync,
    writeFlag: (p) => writeFileSync(p, ""),
  };
}

export async function ensureBootstrapped(
  sessionId: string,
  deps: BootstrapDeps = defaultBootstrapDeps(),
): Promise<void> {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const flagDir = lcmPath("tmp");
  mkdirSync(flagDir, { recursive: true });
  const flagPath = join(flagDir, `bootstrapped-${safeId}.flag`);
  try {
    if (deps.flagExists(flagPath)) return;
  } catch {}

  await ensureCore(deps);
  try { deps.writeFlag(flagPath); } catch {}
}
