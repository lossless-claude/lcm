import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { REQUIRED_HOOKS, mergeClaudeSettings } from "../../installer/install.js";

export interface AutoHealDeps {
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, data: string) => void;
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, opts?: { recursive: boolean }) => void;
  appendFileSync: (path: string, data: string) => void;
  settingsPath: string;
  logPath: string;
}

function defaultDeps(): AutoHealDeps {
  return {
    readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
    writeFileSync,
    existsSync,
    mkdirSync,
    appendFileSync,
    settingsPath: join(homedir(), ".claude", "settings.json"),
    logPath: join(homedir(), ".lossless-claude", "auto-heal.log"),
  };
}

function hasHookCommand(entries: any[], command: string): boolean {
  return entries.some((entry: any) =>
    Array.isArray(entry.hooks) && entry.hooks.some((h: any) => h.command === command)
  );
}

export function validateAndFixHooks(deps: AutoHealDeps = defaultDeps()): void {
  try {
    if (!deps.existsSync(deps.settingsPath)) return;

    const settings: any = JSON.parse(deps.readFileSync(deps.settingsPath, "utf-8"));

    // Hooks are owned by plugin.json — if they leaked into settings.json
    // (from old installer or manual edits), remove them to prevent double-firing.
    const hooks = settings.hooks ?? {};
    const hasDuplicates = REQUIRED_HOOKS.some(({ event, command }) => {
      const entries = hooks[event];
      return Array.isArray(entries) && hasHookCommand(entries, command);
    });

    if (!hasDuplicates) return;

    // Clean up: remove lcm hooks from settings.json
    const merged = mergeClaudeSettings(settings);
    deps.mkdirSync(dirname(deps.settingsPath), { recursive: true });
    deps.writeFileSync(deps.settingsPath, JSON.stringify(merged, null, 2));
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
