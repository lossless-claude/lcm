import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mergeClaudeSettings } from "./installer/settings.js";
import { loadDaemonConfig } from "./daemon/config.js";
import { createLcmPaths, type LcmPaths } from "./lcm-paths.js";
import { PKG_VERSION } from "./daemon/version.js";
import { cliInvocation, daemonNotice, type DaemonNotice } from "./hooks/fail-open.js";

export type EnsureDaemonOutcome = { connected: boolean; ownership?: string; daemonVersion?: string };

export interface EnsureCoreDeps {
  configPath: string;
  settingsPath: string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  writeFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  chmodSync?: (path: string, mode: number) => void;
  ensureDaemon: (opts: { port: number; pidFilePath: string; spawnTimeoutMs: number; expectedVersion?: string }) => Promise<EnsureDaemonOutcome>;
}

export type EnsureCoreResult = { port: number; daemon: EnsureDaemonOutcome };

function defaultDeps(paths: LcmPaths): EnsureCoreDeps {
  return {
    configPath: paths.configPath,
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

export async function ensureCore(pathsOrDeps: LcmPaths | EnsureCoreDeps, injectedDeps?: EnsureCoreDeps): Promise<EnsureCoreResult> {
  const paths = "home" in pathsOrDeps ? pathsOrDeps : createLcmPaths(dirname(pathsOrDeps.configPath));
  const deps = "home" in pathsOrDeps ? (injectedDeps ?? defaultDeps(paths)) : pathsOrDeps;
  // 1. Create config.json with defaults if missing
  if (!deps.existsSync(deps.configPath)) {
    deps.mkdirSync(dirname(deps.configPath), { recursive: true });
    const defaults = loadDaemonConfig(deps.configPath);
    deps.writeFileSync(deps.configPath, JSON.stringify(defaults, null, 2));
    try {
      deps.chmodSync?.(deps.configPath, 0o600);
    } catch {}
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

  // 3. Start daemon if not running. Only the version is compared, never the build:
  // the plugin bundle and the npm CLI of one release are built in different CI runs,
  // and two hooks passing different build ids would restart the daemon at each other.
  const config = loadDaemonConfig(deps.configPath);
  const port = config.daemon?.port ?? 3737;
  const daemon = await deps.ensureDaemon({
    port,
    pidFilePath: join(dirname(deps.configPath), "daemon.pid"),
    spawnTimeoutMs: 5000,
    expectedVersion: PKG_VERSION,
  });
  return { port, daemon };
}

export interface BootstrapDeps extends EnsureCoreDeps {
  flagExists: (path: string) => boolean;
  /** The flag's content: empty when the session may use the daemon, else the notice that says why not. */
  readFlag: (path: string) => string;
  writeFlag: (path: string, content: string) => void;
  warn: (line: string) => void;
}

function defaultBootstrapDeps(paths: LcmPaths): BootstrapDeps {
  return {
    ...defaultDeps(paths),
    flagExists: existsSync,
    readFlag: (p) => readFileSync(p, "utf-8"),
    writeFlag: (p, content) => writeFileSync(p, content),
    warn: (line) => process.stderr.write(line + "\n"),
  };
}

const UNUSABLE_PREFIX = "unusable:";

/**
 * Runs `ensureCore` once per session and returns whether this session's hooks may
 * talk to the daemon. The first hook of a session writes the verdict into the flag
 * file and, when something is wrong, one line on stderr naming the repair; every
 * later hook only reads the flag back. A failing setup is reported the same way and
 * still writes the flag, so it is attempted once per session, not once per hook.
 */
export async function ensureBootstrapped(
  sessionId: string,
  pathsOrDeps: LcmPaths | BootstrapDeps,
  injectedDeps?: BootstrapDeps,
): Promise<{ usable: boolean }> {
  const paths = "home" in pathsOrDeps ? pathsOrDeps : createLcmPaths(dirname(pathsOrDeps.configPath));
  const deps = "home" in pathsOrDeps ? (injectedDeps ?? defaultBootstrapDeps(paths)) : pathsOrDeps;
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const flagDir = paths.tmpDir;
  mkdirSync(flagDir, { recursive: true });
  const flagPath = join(flagDir, `bootstrapped-${safeId}.flag`);
  try {
    if (deps.flagExists(flagPath)) {
      let content = "";
      try { content = deps.readFlag(flagPath); } catch {}
      // An unusable verdict is tied to the hook version that wrote it: once this
      // distribution has been updated, the same session is checked again.
      const writtenBy = content.startsWith(UNUSABLE_PREFIX) ? content.slice(UNUSABLE_PREFIX.length).trim().split(" ")[0] : undefined;
      if (writtenBy === undefined) return { usable: true };
      if (writtenBy === `v${PKG_VERSION}`) return { usable: false };
    }
  } catch {}

  let notice: DaemonNotice | undefined;
  try {
    const { port, daemon } = await ensureCore(paths, deps);
    notice = daemonNotice({ ...daemon, port }, PKG_VERSION);
  } catch (err) {
    // The flag is still written below: a broken environment is reported once, not
    // re-attempted (with its daemon timeout) by every hook of the session.
    notice = { usable: true, line: `lcm: setup failed (${err instanceof Error ? err.message : String(err)}); memory may be off until it is repaired. Repair: ${cliInvocation()} doctor` };
  }
  if (notice) deps.warn(notice.line);
  const usable = notice?.usable ?? true;
  try { deps.writeFlag(flagPath, usable ? "" : `${UNUSABLE_PREFIX} v${PKG_VERSION} ${notice!.line}`); } catch {}
  return { usable };
}
