import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { LcmSummarizeFn, SummarizeContext, SummarizerUsage } from "./types.js";
import { LCM_SUMMARIZER_SYSTEM_PROMPT } from "../summarize.js";
import { buildSummaryPrompt } from "./prompt.js";

const TIMEOUT_MS = 120_000;
const STDERR_ERROR_MAX_CHARS = 2_000;

type OmpUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  totalTokens?: number;
};

type OmpTextContent = { type: "text"; text: string };

type OmpAssistantMessage = {
  content?: (OmpTextContent | { type: string })[];
  usage?: OmpUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
};

/**
 * Reads the last `turn_end` event from `omp --print --mode json`.
 *
 * With `--no-tools` the run has exactly one turn, so the last (and only)
 * `turn_end` carries the final assistant message: its `content` is the
 * summary text, and its `usage` the token accounting.
 */
export function parseOmpTurnEnd(stdout: string): OmpAssistantMessage | undefined {
  let last: OmpAssistantMessage | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as { type?: string; message?: OmpAssistantMessage };
      if (event.type === "turn_end" && event.message) last = event.message;
    } catch {
      continue; // partial or non-JSON line — ignore
    }
  }
  return last;
}

export function parseOmpUsage(stdout: string, fallbackModel?: string): SummarizerUsage | undefined {
  const usage = parseOmpTurnEnd(stdout)?.usage;
  if (!usage) return undefined;
  const inputTokens = usage.input ?? 0;
  const outputTokens = usage.output ?? 0;
  return {
    provider: "omp-process",
    model: parseOmpTurnEnd(stdout)?.model || fallbackModel,
    inputTokens,
    cachedInputTokens: usage.cacheRead,
    outputTokens,
    tokensUsed: usage.totalTokens ?? inputTokens + outputTokens,
  };
}

function extractOmpContent(message: OmpAssistantMessage | undefined): string {
  if (!message?.content) return "";
  return message.content
    .filter((block): block is OmpTextContent => block.type === "text" && typeof (block as OmpTextContent).text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

function isUsageLimitError(text: string): boolean {
  return /usage limit|rate limit|quota|too many requests|\b429\b/i.test(text);
}

function buildOmpExitError(code: number | null, stderr: string, message: OmpAssistantMessage | undefined): Error {
  const exitLabel = code ?? "unknown";
  const detail = message?.errorMessage?.trim() || stderr.trim();
  if (!detail) {
    return new Error(`omp exited ${exitLabel}: no output`);
  }
  const excerpt =
    detail.length > STDERR_ERROR_MAX_CHARS
      ? `[...] ${detail.slice(-STDERR_ERROR_MAX_CHARS)}`
      : detail;
  if (isUsageLimitError(detail)) {
    return new Error(
      `omp usage limit reached (exit ${exitLabel}) — wait for the limit to reset or switch models before retrying.\n${excerpt}`,
    );
  }
  return new Error(`omp exited ${exitLabel}: ${excerpt}`);
}

function friendlyMissingOmpError(): Error {
  return new Error([
    "OMP CLI is not installed or not on PATH.",
    "Install it first, for example: npm install -g @oh-my-pi/pi-coding-agent",
  ].join("\n"));
}

function normalizeSpawnError(error: unknown): Error {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
    return friendlyMissingOmpError();
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The summarizer needs a bare model call, not an OMP agent session: without the
 * isolation flags the CLI would load the user's project extensions, skills and
 * rules into every prompt, spin up LSP, and persist a synthetic session for the
 * next import/replay to discover. `--no-tools` alone leaves no tool call
 * possible, so no approval prompt can block a `--print` run.
 */
export function buildOmpArgs(model: string | undefined, systemPrompt = LCM_SUMMARIZER_SYSTEM_PROMPT): string[] {
  const args = [
    "--print",
    "--mode", "json",
    "--no-session",
    "--no-tools",
    "--no-lsp",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--no-title",
    "--system-prompt", systemPrompt,
  ];

  if (model && model.trim()) {
    args.push("--model", model.trim());
  }

  return args;
}

type OmpProcessDeps = {
  model?: string;
  spawn?: typeof defaultSpawn;
  timeoutMs?: number;
};

export function createOmpProcessSummarizer(opts: OmpProcessDeps = {}): LcmSummarizeFn {
  const deps = {
    model: opts.model,
    spawn: opts.spawn ?? defaultSpawn,
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
  };

  return async function summarize(text: string, aggressive?: boolean, ctx: SummarizeContext = {}): Promise<string> {
    const prompt = buildSummaryPrompt(text, aggressive, ctx);
    const systemPrompt = ctx.taskPrompt ?? LCM_SUMMARIZER_SYSTEM_PROMPT;

    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = deps.spawn("omp", buildOmpArgs(deps.model, systemPrompt), { stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
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
        reject(new Error(`omp process timed out after ${Math.round(deps.timeoutMs / 1000)}s`));
      }, deps.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on("error", (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(normalizeSpawnError(error));
      });

      child.on("close", (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);

        const message = parseOmpTurnEnd(stdout);
        const usage = parseOmpUsage(stdout, deps.model);
        if (usage) ctx.onUsage?.(usage);

        if (code !== 0) {
          reject(buildOmpExitError(code, stderr, message));
          return;
        }
        const content = extractOmpContent(message);
        if (!content) {
          reject(new Error("omp output was empty"));
          return;
        }
        resolve(content);
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  };
}
