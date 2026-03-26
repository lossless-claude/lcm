import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync as fsRenameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeClaudeSettings, hooksUpToDate } from "./installer/settings.js";
import { loadDaemonConfig } from "./daemon/config.js";

export interface EnsureCoreDeps {
  configPath: string;
  settingsPath: string;
  nodePath: string;
  lcmMjsPath: string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  chmodSync?: (path: string, mode: number) => void;
  ensureDaemon: (opts: { port: number; pidFilePath: string; spawnTimeoutMs: number }) => Promise<{ connected: boolean }>;
}

function defaultDeps(): EnsureCoreDeps {
  return {
    configPath: join(homedir(), ".lossless-claude", "config.json"),
    settingsPath: join(homedir(), ".claude", "settings.json"),
    nodePath: process.execPath,
    lcmMjsPath: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "lcm.mjs"),
    existsSync,
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    renameSync: fsRenameSync,
    mkdirSync,
    chmodSync,
    ensureDaemon: async (opts) => {
      const { ensureDaemon } = await import("./daemon/lifecycle.js");
      return ensureDaemon(opts);
    },
  };
}

function atomicWriteJSON(
  settingsPath: string,
  data: unknown,
  deps: Pick<EnsureCoreDeps, "writeFileSync" | "renameSync" | "mkdirSync">,
): void {
  const tmp = `${settingsPath}.${randomBytes(6).toString("hex")}.tmp`;
  deps.mkdirSync(dirname(settingsPath), { recursive: true });
  deps.writeFileSync(tmp, JSON.stringify(data, null, 2));
  deps.renameSync(tmp, settingsPath);
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

  // 2. Upsert hooks into settings.json (self-healing)
  // Hot path: read-only string compare. Write only if hooks are missing/stale.
  // On a fresh machine where settings.json does not exist yet, we still create it
  // so hooks are registered. The existsSync guard only skips the READ, not the write.
  try {
    const existing = deps.existsSync(deps.settingsPath)
      ? JSON.parse(deps.readFileSync(deps.settingsPath, "utf-8"))
      : {};
    if (!hooksUpToDate(existing, deps.nodePath, deps.lcmMjsPath)) {
      const merged = mergeClaudeSettings(existing, {
        intent: "upsert",
        nodePath: deps.nodePath,
        lcmMjsPath: deps.lcmMjsPath,
      });
      atomicWriteJSON(deps.settingsPath, merged, deps);
    }
  } catch {}

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
  const flagDir = join(homedir(), ".lossless-claude", "tmp");
  mkdirSync(flagDir, { recursive: true });
  const flagPath = join(flagDir, `bootstrapped-${safeId}.flag`);
  try {
    if (deps.flagExists(flagPath)) return;
  } catch {}

  await ensureCore(deps);
  try { deps.writeFlag(flagPath); } catch {}
}
