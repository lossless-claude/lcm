import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync as fsRenameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeClaudeSettings, hooksUpToDate } from "../../installer/install.js";

export interface AutoHealDeps {
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, data: string) => void;
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  appendFileSync: (path: string, data: string) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  settingsPath: string;
  logPath: string;
  nodePath: string;
  lcmMjsPath: string;
}

function defaultDeps(): AutoHealDeps {
  return {
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    existsSync,
    mkdirSync,
    appendFileSync,
    renameSync: fsRenameSync,
    settingsPath: join(homedir(), ".claude", "settings.json"),
    logPath: join(homedir(), ".lossless-claude", "auto-heal.log"),
    nodePath: process.execPath,
    lcmMjsPath: join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "lcm.mjs"),
  };
}

export function validateAndFixHooks(deps: AutoHealDeps = defaultDeps()): void {
  try {
    if (!deps.existsSync(deps.settingsPath)) return;

    const settings: any = JSON.parse(deps.readFileSync(deps.settingsPath, "utf-8"));

    if (hooksUpToDate(settings, deps.nodePath, deps.lcmMjsPath)) return;

    const merged = mergeClaudeSettings(settings, {
      intent: "upsert",
      nodePath: deps.nodePath,
      lcmMjsPath: deps.lcmMjsPath,
    });

    const tmp = `${deps.settingsPath}.${randomBytes(6).toString("hex")}.tmp`;
    deps.mkdirSync(dirname(deps.settingsPath), { recursive: true });
    deps.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    deps.renameSync(tmp, deps.settingsPath);
  } catch (err) {
    try {
      deps.mkdirSync(dirname(deps.logPath), { recursive: true });
      const msg = `[${new Date().toISOString()}] auto-heal error: ${err instanceof Error ? err.message : String(err)}\n`;
      deps.appendFileSync(deps.logPath, msg);
    } catch {
      // Last resort: silently fail
    }
  }
}
