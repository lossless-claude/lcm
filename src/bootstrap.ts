import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { mergeClaudeSettings } from "../installer/install.js";
import { loadDaemonConfig } from "./daemon/config.js";

export interface EnsureCoreDeps {
  configPath: string;
  settingsPath: string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  ensureDaemon: (opts: { port: number; pidFilePath: string; spawnTimeoutMs: number }) => Promise<{ connected: boolean }>;
}

function defaultDeps(): EnsureCoreDeps {
  return {
    configPath: join(homedir(), ".lossless-claude", "config.json"),
    settingsPath: join(homedir(), ".claude", "settings.json"),
    existsSync,
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    mkdirSync,
    ensureDaemon: async (opts) => {
      const { ensureDaemon } = await import("./daemon/lifecycle.js");
      return ensureDaemon(opts);
    },
  };
}

export async function ensureCore(deps: EnsureCoreDeps = defaultDeps()): Promise<void> {
  // 1. Create config.json with defaults if missing
  if (!deps.existsSync(deps.configPath)) {
    deps.mkdirSync(dirname(deps.configPath), { recursive: true });
    const defaults = loadDaemonConfig("/nonexistent");
    deps.writeFileSync(deps.configPath, JSON.stringify(defaults, null, 2));
  }

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
  const flagPath = join(tmpdir(), `lcm-bootstrapped-${safeId}.flag`);
  try {
    if (deps.flagExists(flagPath)) return;
  } catch {}

  await ensureCore(deps);
  try { deps.writeFlag(flagPath); } catch {}
}
