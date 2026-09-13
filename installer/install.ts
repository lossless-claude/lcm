import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, rmSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { ensureCore } from "../src/bootstrap.js";
import { mcpServerEntry } from "../src/installer/mcp-server-entry.js";
import { packageRoot } from "../src/cli-entrypoint.js";
import { installConnector } from "../src/connectors/installer.js";
import { runningFromPluginBundle } from "../src/hooks/fail-open.js";
import { isOlderVersion } from "../src/daemon/lifecycle.js";
import { PKG_VERSION } from "../src/daemon/version.js";
export { REQUIRED_HOOKS, mergeClaudeSettings } from "../src/installer/settings.js";

export interface ServiceDeps {
  spawnSync: (cmd: string, args: string[], opts?: any) => SpawnSyncReturns<string>;
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string, opts?: any) => void;
  existsSync: (path: string) => boolean;
  chmodSync?: (path: string, mode: number) => void;
  copyFileSync: (src: string, dest: string) => void;
  rmSync: (path: string, opts?: { recursive?: boolean; force?: boolean }) => void;
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

const defaultDeps: ServiceDeps = { spawnSync: spawnSync as any, readFileSync: (path, encoding) => readFileSync(path, encoding as BufferEncoding) as string, writeFileSync, mkdirSync, existsSync, chmodSync: chmodSync, copyFileSync, rmSync, promptUser: readlinePrompt };

export interface ResolveBinaryDeps {
  spawnSync: (cmd: string, args: string[], opts?: object) => { status: number | null; stdout: string | Buffer };
  existsSync: (path: string) => boolean;
}

export function resolveBinaryPath(deps: ResolveBinaryDeps = defaultDeps): string {
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

const LCM_BLOCK_START = "<!-- lcm:start -->";
const LCM_BLOCK_END = "<!-- lcm:end -->";

export function ensureLcmMd(
  deps: Pick<ServiceDeps, "readFileSync" | "writeFileSync" | "existsSync" | "mkdirSync">,
  lcmMdContent: string,
  homeDirPath: string = homedir(),
): { lcmMdWritten: boolean; claudeMdPatched: boolean } {
  const claudeDir = join(homeDirPath, ".claude");
  deps.mkdirSync(claudeDir, { recursive: true });

  // Always overwrite lcm.md to keep content up-to-date with the installed version
  const lcmMdPath = join(claudeDir, "lcm.md");
  let lcmMdWritten = false;
  let existingLcmMd = "";
  if (deps.existsSync(lcmMdPath)) {
    try {
      existingLcmMd = deps.readFileSync(lcmMdPath, "utf-8");
    } catch {
      // treat unreadable as stale — overwrite
    }
  }
  if (existingLcmMd !== lcmMdContent) {
    deps.writeFileSync(lcmMdPath, lcmMdContent);
    lcmMdWritten = true;
  }

  // Ensure @lcm.md appears in CLAUDE.md inside a managed block
  const claudeMdPath = join(claudeDir, "CLAUDE.md");
  let claudeMdPatched = false;
  let existing = "";
  if (deps.existsSync(claudeMdPath)) {
    try { existing = deps.readFileSync(claudeMdPath, "utf-8"); } catch {}
  }

  const block = `${LCM_BLOCK_START}\n<!-- Claude Code include: @lcm.md -->\n${LCM_BLOCK_END}`;
  const blockRegex = /[ \t]*<!--\s*lcm:start\s*-->[\s\S]*?<!--\s*lcm:end\s*-->\s*/;

  if (blockRegex.test(existing)) {
    // Block exists — replace it in case content changed
    const updated = existing.replace(blockRegex, block + "\n");
    if (updated !== existing) {
      deps.writeFileSync(claudeMdPath, updated);
      claudeMdPatched = true;
    }
  } else {
    // No block yet — append
    deps.writeFileSync(claudeMdPath, existing ? existing.trimEnd() + "\n" + block + "\n" : block + "\n");
    claudeMdPatched = true;
  }

  return { lcmMdWritten, claudeMdPatched };
}

/** One line per harness: what `lcm install` did for it. */
export type HarnessOutcome = { status: "ok" | "skipped" | "failed"; detail: string };
export type InstallOutcome = { claude: HarnessOutcome; codex: HarnessOutcome };

export async function install(deps: ServiceDeps = defaultDeps): Promise<InstallOutcome> {
  let claude: HarnessOutcome;
  try {
    claude = await installClaudeCode(deps);
  } catch (err) {
    claude = { status: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
  const codex = installCodex(deps);

  console.log("");
  for (const [harness, outcome] of [["Claude Code", claude], ["Codex", codex]] as const) {
    const mark = outcome.status === "ok" ? "✓" : outcome.status === "skipped" ? "○" : "✗";
    console.log(`  ${mark} ${harness}: ${outcome.detail}`);
  }
  return { claude, codex };
}

/**
 * Codex keeps the npm CLI: when `codex` is on PATH, install the lifecycle hooks
 * globally (`~/.codex/hooks.json`), the equivalent of `lcm connectors install
 * codex --global`. Project scope stays explicit through `lcm connectors`.
 * Reinstalling reconciles the managed handlers without duplicating them.
 */
function installCodex(deps: ServiceDeps): HarnessOutcome {
  // The Codex hooks name an absolute CLI path. From the plugin bundle that path would be a
  // versioned plugin-cache entry the next plugin update deletes; Codex stays on the npm CLI.
  if (runningFromPluginBundle()) {
    return { status: "skipped", detail: "run lcm install from the npm CLI to set up Codex: npm install -g @lossless-claude/lcm && lcm install" };
  }
  try {
    const found = deps.spawnSync("sh", ["-c", "command -v codex"], { encoding: "utf-8" });
    if (found.status !== 0 || typeof found.stdout !== "string" || !found.stdout.trim()) {
      return { status: "skipped", detail: "codex not on PATH" };
    }
    const result = installConnector("codex", "hooks", homedir(), {
      writeFile: (path, data) => {
        deps.mkdirSync(dirname(path), { recursive: true });
        deps.writeFileSync(path, data);
      },
    });
    return { status: "ok", detail: `hooks installed in ${result.path}${result.notice ? ` — ${result.notice}` : ""}` };
  } catch (err) {
    return { status: "failed", detail: err instanceof Error ? err.message : String(err) };
  }
}

async function installClaudeCode(deps: ServiceDeps): Promise<HarnessOutcome> {
  const lcDir = join(homedir(), ".lossless-claude");
  deps.mkdirSync(lcDir, { recursive: true });
  // Clear plugin cache entries for older versions so stale/corrupted installs don't persist.
  // Only older: a newer plugin next to an older npm CLI is a supported state (newest wins).
  try {
    const cacheDir = join(homedir(), ".claude", "plugins", "cache", "lossless-claude", "lcm");
    if (PKG_VERSION && deps.existsSync(cacheDir)) {
      for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
        if (entry.isDirectory() && isOlderVersion(entry.name, PKG_VERSION)) {
          console.log(`Clearing plugin cache for v${entry.name}`);
          deps.rmSync(join(cacheDir, entry.name), { recursive: true, force: true });
        }
      }
    }
  } catch {
    // non-fatal: cache clearing failure shouldn't abort install
  }

  const configPath = join(lcDir, "config.json");
  const settingsPath = join(homedir(), ".claude", "settings.json");

  // 1-3. Core setup (config + settings cleanup + daemon)
  // ensureCore handles: creating config.json, merging settings.json hooks, and starting daemon
  // For install, we inject summarizer config into the default config if creating fresh
  if (!deps.existsSync(configPath)) {
    const summarizerConfig = await pickSummarizer(deps);
    const { loadDaemonConfig } = await import("../src/daemon/config.js");
    const defaults = loadDaemonConfig("/nonexistent");
    defaults.llm = { ...defaults.llm, ...summarizerConfig };
    deps.mkdirSync(dirname(configPath), { recursive: true });
    deps.writeFileSync(configPath, JSON.stringify(defaults, null, 2));
    try { deps.chmodSync?.(configPath, 0o600); } catch { /* best-effort */ }
    console.log(`Created ${configPath}`);
  }

  // ensureCore will:
  // - Skip config creation (already exists or just created above)
  // - Merge settings.json hooks (remove duplicates, clean old commands)
  // - Start the daemon
  await ensureCore({
    configPath,
    settingsPath,
    existsSync: deps.existsSync,
    readFileSync: deps.readFileSync,
    writeFileSync: deps.writeFileSync,
    mkdirSync: deps.mkdirSync,
    ensureDaemon: deps.ensureDaemon ?? (async (opts) => {
      const { ensureDaemon } = await import("../src/daemon/lifecycle.js");
      return ensureDaemon(opts);
    }),
  });

  // Register MCP server directly in settings.json when running from the npm CLI.
  // From the plugin bundle the entry would name a versioned plugin-cache path that the
  // next plugin update deletes; plugin.json already registers the server there.
  if (runningFromPluginBundle()) {
    console.log("MCP server registered by the plugin manifest; settings.json left alone");
  } else {
    let merged: any = {};
    if (deps.existsSync(settingsPath)) {
      try { merged = JSON.parse(deps.readFileSync(settingsPath, "utf-8")); } catch {}
    }
    if (typeof merged !== "object" || merged === null) {
      merged = {};
    }
    const mcpServers = (typeof merged.mcpServers === "object" && merged.mcpServers !== null) ? merged.mcpServers : {};
    mcpServers["lcm"] = mcpServerEntry();
    (merged as any).mcpServers = mcpServers;

    deps.mkdirSync(dirname(settingsPath), { recursive: true });
    deps.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
    console.log(`Updated ${settingsPath}`);
  }

  // 4. Install the /memory skill to ~/.claude/skills/memory/, and drop the per-command files
  //    earlier versions installed, so /lcm-doctor and friends stop shadowing it.
  const skillSrc = join(packageRoot(), "skills", "memory", "SKILL.md");
  const skillDst = join(homedir(), ".claude", "skills", "memory");
  if (deps.existsSync(skillSrc)) {
    deps.mkdirSync(skillDst, { recursive: true });
    deps.copyFileSync(skillSrc, join(skillDst, "SKILL.md"));
    console.log(`Installed the /memory skill to ${skillDst}`);
  }
  const legacyCommands = join(homedir(), ".claude", "commands");
  if (deps.existsSync(legacyCommands)) {
    for (const file of readdirSync(legacyCommands)) {
      if (/^(lcm|lossless-claude)-[a-z]+\.md$/.test(file)) deps.rmSync(join(legacyCommands, file), { force: true });
    }
  }

  // 5. Install lcm.md and @lcm.md reference in CLAUDE.md
  const { LCM_MD_CONTENT } = await import("../src/daemon/orientation.js");
  const { lcmMdWritten, claudeMdPatched } = ensureLcmMd(deps, LCM_MD_CONTENT);
  if (lcmMdWritten) console.log(`Installed ~/.claude/lcm.md`);
  if (claudeMdPatched) console.log(`Added @lcm.md to ~/.claude/CLAUDE.md`);

  // 7. Final verification
  console.log("\nRunning doctor...");
  const _runDoctor = deps.runDoctor ?? (async () => {
    const { runDoctor, printResults: _print } = await import("../src/doctor/doctor.js");
    const _results = await runDoctor();
    _print(_results);
    return _results;
  });
  const results = await _runDoctor();
  // Only what install itself set up counts as its failure; an optional summarizer CLI
  // being absent is doctor's advice, not a broken Claude Code install.
  // A missing plugin bundle is repaired by `claude plugin update`, not by install.
  const owned = new Set(["Stack", "Daemon", "Settings"]);
  const failures = results.filter((r) => r.status === "fail" && r.name !== "plugin-bundle" && (r.category === undefined || owned.has(r.category)));
  if (failures.length > 0) {
    return { status: "failed", detail: `${failures.length} doctor check(s) failed (${failures.map((r) => r.name).join(", ")}) — run: lcm doctor` };
  }
  return { status: "ok", detail: "settings, MCP server, /memory skill and lcm.md installed; all checks passed" };
}

// Re-export rmSync so uninstall.ts can share the pattern
export { rmSync };
