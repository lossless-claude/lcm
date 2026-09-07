import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdtempSync as defaultMkdtempSync, readFileSync as defaultReadFileSync, rmSync as defaultRmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LcmSummarizeFn, SummarizeContext, SummarizerUsage } from "./types.js";
import { buildSummaryPromptWithSystem } from "./prompt.js";

const TIMEOUT_MS = 120_000;
const STDERR_ERROR_MAX_CHARS = 2_000;

// The Codex CLI writes a config banner to stderr before any useful output:
//   OpenAI Codex <version>
//   --------
//   workdir: <path>
//   model: <model>
//   provider: openai
//   approval: on-request
//   sandbox: read-only
//   reasoning effort: medium
//   reasoning summaries: none
//   session id: <uuid>
// The banner alone is ~279 bytes, so head-truncating stderr loses the actual
// error message, which always comes after it.
const BANNER_END_MARKER = "session id:";

type CodexTurnUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
};

/**
 * Reads the `turn.completed` event from `codex exec --json`.
 *
 * Codex counts `cached_input_tokens` as a SUBSET of `input_tokens`, so the
 * total it prints as "tokens used" equals input + output. The summary itself
 * arrives via --output-last-message, so stdout is free for the event stream.
 */
export function parseCodexUsage(stdout: string, model?: string): SummarizerUsage | undefined {
  let usage: CodexTurnUsage | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as { type?: string; usage?: CodexTurnUsage };
      if (event.type === "turn.completed" && event.usage) usage = event.usage;
    } catch {
      continue; // partial or non-JSON line — ignore
    }
  }
  if (!usage) return undefined;

  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    provider: "codex-process",
    model,
    inputTokens,
    cachedInputTokens: usage.cached_input_tokens,
    outputTokens,
    tokensUsed: inputTokens + outputTokens,
  };
}

/** Fallback for older Codex builds that only print a "tokens used" total on stderr. */
export function parseLegacyCodexTokens(stderr: string): number | undefined {
  const normalized = stderr.replace(/\r\n/g, "\n");
  const match = normalized.match(/tokens used\s*\n\s*([0-9][0-9,]*)/i);
  if (!match) return undefined;
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function skipCodexBanner(stderr: string): string {
  const lines = stderr.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "--------" || /^openai codex\b/i.test(line)) continue;
    if (/^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries):/i.test(line)) continue;
    if (line.toLowerCase().startsWith(BANNER_END_MARKER)) {
      return lines.slice(i + 1).join("\n").trim();
    }
    return lines.slice(i).join("\n").trim();
  }
  return stderr.trim();
}

/**
 * With `--json`, the real failure is a JSONL event on stdout — stderr carries
 * only unrelated transport noise — so stdout is the primary error source.
 */
export function extractCodexErrorEvents(stdout: string): string {
  const messages: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !/error|failed/i.test(trimmed)) continue;
    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        message?: unknown;
        error?: { message?: unknown };
      };
      if (event.type === "turn.failed" && typeof event.error?.message === "string") {
        messages.push(event.error.message);
      } else if (event.type === "error" && typeof event.message === "string") {
        messages.push(event.message);
      }
    } catch {
      // ignore
    }
  }
  // turn.failed repeats the error event verbatim; keep one copy.
  return [...new Set(messages)].join("\n");
}

function isUsageLimitError(text: string): boolean {
  return /usage limit|rate limit|quota|too many requests|\b429\b/i.test(text);
}

function buildCodexExitError(code: number | null, stderr: string, stdout: string): Error {
  const exitLabel = code ?? "unknown";
  const detail = extractCodexErrorEvents(stdout) || skipCodexBanner(stderr);
  if (!detail) {
    return new Error(`codex exited ${exitLabel}: no output`);
  }
  const excerpt =
    detail.length > STDERR_ERROR_MAX_CHARS
      ? `[...] ${detail.slice(-STDERR_ERROR_MAX_CHARS)}`
      : detail;
  if (isUsageLimitError(detail)) {
    return new Error(
      `codex usage limit reached (exit ${exitLabel}) — wait for the limit to reset or switch models before retrying.\n${excerpt}`,
    );
  }
  return new Error(`codex exited ${exitLabel}: ${excerpt}`);
}

type CodexProcessDeps = {
  model?: string;
  spawn?: typeof defaultSpawn;
  mkdtempSync?: typeof defaultMkdtempSync;
  readFileSync?: typeof defaultReadFileSync;
  rmSync?: typeof defaultRmSync;
  tmpdir?: typeof tmpdir;
  timeoutMs?: number;
};

function friendlyMissingCodexError(): Error {
  return new Error([
    "Codex CLI is not installed or not on PATH.",
    "Install it first, for example: npm install -g @openai/codex",
    "Then run lossless-codex again.",
  ].join("\n"));
}

function normalizeSpawnError(error: unknown): Error {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
    return friendlyMissingCodexError();
  }
  return error instanceof Error ? error : new Error(String(error));
}

function buildArgs(outputPath: string, model?: string): string[] {
  const args = [
    "exec",
    "-",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--output-last-message",
    outputPath,
  ];

  if (model && model.trim()) {
    args.splice(1, 0, "--model", model.trim());
  }

  return args;
}

function cleanupTempDir(rmSync: typeof defaultRmSync, tempDir: string): void {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}

function runCodexSummarizer(
  prompt: string,
  deps: Required<Pick<CodexProcessDeps, "spawn" | "mkdtempSync" | "readFileSync" | "rmSync" | "tmpdir" | "timeoutMs">> & {
    model?: string;
  },
  onUsage?: SummarizeContext["onUsage"],
): Promise<string> {
  const tempDir = deps.mkdtempSync(join(deps.tmpdir(), "lossless-codex-"));
  const outputPath = join(tempDir, "last-message.txt");

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;

    try {
      child = deps.spawn("codex", buildArgs(outputPath, deps.model), {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      cleanupTempDir(deps.rmSync, tempDir);
      reject(normalizeSpawnError(error));
      return;
    }

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill();
      } catch {
        // ignore kill failures during timeout cleanup
      }
      cleanupTempDir(deps.rmSync, tempDir);
      reject(new Error(`codex process timed out after ${Math.round(deps.timeoutMs / 1000)}s`));
    }, deps.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanupTempDir(deps.rmSync, tempDir);
      reject(normalizeSpawnError(error));
    });

    child.on("close", (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      try {
        const usage = parseCodexUsage(stdout, deps.model)
          ?? legacyUsage(parseLegacyCodexTokens(stderr), deps.model);
        if (usage) onUsage?.(usage);
        if (code !== 0) {
          throw buildCodexExitError(code, stderr, stdout);
        }
        const summary = deps.readFileSync(outputPath, "utf-8").trim();
        if (!summary) {
          throw new Error("codex output was empty");
        }
        resolve(summary);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        cleanupTempDir(deps.rmSync, tempDir);
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function legacyUsage(tokensUsed: number | undefined, model?: string): SummarizerUsage | undefined {
  return tokensUsed === undefined ? undefined : { provider: "codex-process", model, tokensUsed };
}

export function createCodexProcessSummarizer(opts: CodexProcessDeps = {}): LcmSummarizeFn {
  const deps = {
    model: opts.model,
    spawn: opts.spawn ?? defaultSpawn,
    mkdtempSync: opts.mkdtempSync ?? defaultMkdtempSync,
    readFileSync: opts.readFileSync ?? defaultReadFileSync,
    rmSync: opts.rmSync ?? defaultRmSync,
    tmpdir: opts.tmpdir ?? tmpdir,
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
  };

  return async function summarize(text, aggressive, ctx = {}): Promise<string> {
    const prompt = buildSummaryPromptWithSystem(text, aggressive, ctx);
    return runCodexSummarizer(prompt, deps, ctx.onUsage);
  };
}
