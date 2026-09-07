import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LcmSummarizeFn, SummarizeContext, SummarizerUsage } from "./types.js";
import { LCM_SUMMARIZER_SYSTEM_PROMPT } from "../summarize.js";
import { buildSummaryPrompt } from "./prompt.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 120_000;
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const STDERR_ERROR_MAX_CHARS = 2_000;

let cachedEmptyPluginDir: string | undefined;

/**
 * An existing empty directory: `--plugin-dir` rejects a missing path. It is
 * private to this process (mkdtemp, mode 0700) so no other local user can
 * pre-create a same-named path and plant plugins in it. The cache is assigned
 * only after creation succeeds.
 */
export function emptyPluginDir(): string {
  cachedEmptyPluginDir ??= mkdtempSync(join(tmpdir(), "lcm-claude-empty-plugins-"));
  return cachedEmptyPluginDir;
}

type ClaudeModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
};

type ClaudeResult = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  modelUsage?: Record<string, ClaudeModelUsage>;
};

export type ClaudeJsonOutcome = {
  content: string;
  isError: boolean;
  usage?: SummarizerUsage;
};

/**
 * Reads the single result object from `claude --print --output-format json`.
 *
 * Claude splits the prompt across three counters — `inputTokens` covers only
 * the uncached part, with cache reads and cache writes reported separately —
 * so they are summed into the normalized `inputTokens`, and the cache-read
 * share is surfaced as `cachedInputTokens`.
 */
export function parseClaudeResult(stdout: string, fallbackModel: string): ClaudeJsonOutcome | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return undefined;

  let result: ClaudeResult;
  try {
    result = JSON.parse(trimmed) as ClaudeResult;
  } catch {
    return undefined;
  }

  const entries = Object.entries(result.modelUsage ?? {});
  let usage: SummarizerUsage | undefined;
  if (entries.length > 0) {
    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    for (const [, m] of entries) {
      inputTokens += (m.inputTokens ?? 0) + (m.cacheReadInputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0);
      cachedInputTokens += m.cacheReadInputTokens ?? 0;
      outputTokens += m.outputTokens ?? 0;
      costUsd += m.costUSD ?? 0;
    }
    usage = {
      provider: "claude-process",
      model: entries[0][0] || fallbackModel,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      tokensUsed: inputTokens + outputTokens,
      costUsd: result.total_cost_usd ?? costUsd,
    };
  }

  return {
    content: typeof result.result === "string" ? result.result.trim() : "",
    isError: result.is_error === true,
    usage,
  };
}

function buildClaudeExitError(code: number | null, stderr: string, stdout: string): Error {
  const exitLabel = code ?? "unknown";
  const detail = (stderr.trim() || stdout.trim()) || "no output";
  const excerpt =
    detail.length > STDERR_ERROR_MAX_CHARS
      ? `[...] ${detail.slice(-STDERR_ERROR_MAX_CHARS)}`
      : detail;
  return new Error(`claude exited ${exitLabel}: ${excerpt}`);
}

function friendlyMissingClaudeError(): Error {
  return new Error([
    "Claude Code CLI is not installed or not on PATH.",
    "Install it first, for example: npm install -g @anthropic-ai/claude-code",
  ].join("\n"));
}

function normalizeSpawnError(error: unknown): Error {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
    return friendlyMissingClaudeError();
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The summarizer needs a bare model call, not a Claude Code session. Without
 * the isolation flags the CLI loads the user's plugins, MCP servers, settings
 * and CLAUDE.md files into every prompt (tens of thousands of tokens and
 * several seconds per call). `--bare` is not used because it disables OAuth,
 * which would move the cost off the subscription.
 */
export function buildClaudeArgs(
  model: string,
  systemPrompt = LCM_SUMMARIZER_SYSTEM_PROMPT,
  pluginDir = emptyPluginDir(),
): string[] {
  return [
    "--print",
    "--output-format", "json",
    "--model", model,
    "--no-session-persistence",
    "--system-prompt", systemPrompt,
    "--tools", "",
    "--disable-slash-commands",
    "--plugin-dir", pluginDir,
    "--strict-mcp-config",
    "--mcp-config", EMPTY_MCP_CONFIG,
    "--setting-sources", "",
  ];
}

type ClaudeProcessDeps = {
  model?: string;
  spawn?: typeof defaultSpawn;
  timeoutMs?: number;
};

export function createClaudeProcessSummarizer(opts: ClaudeProcessDeps = {}): LcmSummarizeFn {
  const deps = {
    model: opts.model?.trim() || HAIKU_MODEL,
    spawn: opts.spawn ?? defaultSpawn,
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
  };

  return async function summarize(text: string, aggressive?: boolean, ctx: SummarizeContext = {}): Promise<string> {
    const prompt = buildSummaryPrompt(text, aggressive, ctx);

    return new Promise((resolve, reject) => {
      let proc: ChildProcessWithoutNullStreams;
      try {
        // Directory creation happens here, inside the spawn error path.
        proc = deps.spawn("claude", buildClaudeArgs(deps.model, ctx.taskPrompt, emptyPluginDir()), { stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        reject(normalizeSpawnError(error));
        return;
      }

      let stdout = "";
      let stderr = "";
      let finished = false;

      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        try {
          proc.kill();
        } catch {
          // ignore kill failures during timeout cleanup
        }
        reject(new Error(`claude process timed out after ${Math.round(deps.timeoutMs / 1000)}s`));
      }, deps.timeoutMs);

      proc.on("error", (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(normalizeSpawnError(err));
      });

      proc.on("close", (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        const outcome = parseClaudeResult(stdout, deps.model);
        if (outcome?.usage) ctx.onUsage?.(outcome.usage);

        if (code !== 0 || outcome?.isError) {
          reject(buildClaudeExitError(code, stderr, stdout));
          return;
        }
        if (!outcome) {
          reject(new Error(`claude produced unparseable output: ${stdout.slice(0, 200) || "empty"}`));
          return;
        }
        if (!outcome.content) {
          reject(new Error("claude output was empty"));
          return;
        }
        resolve(outcome.content);
      });

      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  };
}
