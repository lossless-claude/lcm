import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { LcmSummarizeFn, SummarizeContext, SummarizerUsage } from "./types.js";
import { buildSummaryPromptWithSystem } from "./prompt.js";

const TIMEOUT_MS = 120_000;
const STDERR_ERROR_MAX_CHARS = 2_000;

// The Copilot CLI takes its prompt as an argv value: `-p -` is read as the
// literal string "-", not as stdin. argv is capped by ARG_MAX (~1MB on macOS
// and Linux), so refuse oversized prompts with a clear message instead of
// letting the spawn fail with E2BIG.
const MAX_PROMPT_BYTES = 200_000;

type CopilotResultEvent = {
  type: "result";
  exitCode?: number;
  usage?: {
    premiumRequests?: number;
  };
};

type CopilotMessageEvent = {
  type: "assistant.message";
  data?: {
    content?: string;
    outputTokens?: number;
  };
};

export type CopilotJsonlOutcome = {
  content: string;
  outputTokens?: number;
  premiumRequests?: number;
};

/**
 * Reads Copilot's JSONL stream (`--output-format json`).
 *
 * Text mode is not usable here: it hard-wraps the answer at ~80 columns and
 * prefixes it with a bullet, which reflows the summary. The trade-off is that
 * JSON mode reports only output tokens and premium requests — the per-model
 * "N in, N cached" breakdown exists in text mode's stderr only, and the two
 * modes are mutually exclusive.
 */
export function parseCopilotJsonl(stdout: string): CopilotJsonlOutcome {
  let content = "";
  let outputTokens: number | undefined;
  let premiumRequests: number | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // partial or non-JSON line — ignore
    }
    if (!event || typeof event !== "object") continue;

    const type = (event as { type?: unknown }).type;
    if (type === "assistant.message") {
      const data = (event as CopilotMessageEvent).data;
      if (typeof data?.content === "string" && data.content.trim()) {
        content = data.content;
      }
      if (typeof data?.outputTokens === "number") {
        outputTokens = (outputTokens ?? 0) + data.outputTokens;
      }
    } else if (type === "result") {
      const premium = (event as CopilotResultEvent).usage?.premiumRequests;
      if (typeof premium === "number") {
        premiumRequests = (premiumRequests ?? 0) + premium;
      }
    }
  }

  return { content: content.trim(), outputTokens, premiumRequests };
}

function toUsage(outcome: CopilotJsonlOutcome, model?: string): SummarizerUsage | undefined {
  if (outcome.outputTokens === undefined && outcome.premiumRequests === undefined) {
    return undefined;
  }
  return {
    provider: "copilot-process",
    model,
    // Copilot's JSONL stream carries no prompt-token counts, so inputTokens and
    // cachedInputTokens stay undefined and tokensUsed covers output only.
    outputTokens: outcome.outputTokens,
    tokensUsed: outcome.outputTokens ?? 0,
    premiumRequests: outcome.premiumRequests,
  };
}

function isUsageLimitError(text: string): boolean {
  return /usage limit|rate limit|quota|too many requests|premium request|\b429\b/i.test(text);
}

function buildCopilotExitError(code: number | null, stderr: string, stdout: string): Error {
  const exitLabel = code ?? "unknown";
  const detail = (stderr.trim() || extractCopilotErrorEvents(stdout)).trim();
  if (!detail) {
    return new Error(`copilot exited ${exitLabel}: no output`);
  }
  const excerpt =
    detail.length > STDERR_ERROR_MAX_CHARS
      ? `[...] ${detail.slice(-STDERR_ERROR_MAX_CHARS)}`
      : detail;
  if (isUsageLimitError(detail)) {
    return new Error(
      `copilot usage limit reached (exit ${exitLabel}) — wait for the quota to reset or switch models before retrying.\n${excerpt}`,
    );
  }
  return new Error(`copilot exited ${exitLabel}: ${excerpt}`);
}

/** Copilot reports failures as JSONL events on stdout, leaving stderr empty. */
function extractCopilotErrorEvents(stdout: string): string {
  const messages: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !/error/i.test(trimmed)) continue;
    try {
      const event = JSON.parse(trimmed) as { type?: string; data?: { message?: unknown }; error?: unknown };
      if (typeof event.data?.message === "string") messages.push(event.data.message);
      else if (typeof event.error === "string") messages.push(event.error);
    } catch {
      // ignore
    }
  }
  return messages.join("\n");
}

function friendlyMissingCopilotError(): Error {
  return new Error([
    "Copilot CLI is not installed or not on PATH.",
    "Install it first, for example: npm install -g @github/copilot",
    "Then authenticate with: copilot login",
  ].join("\n"));
}

function normalizeSpawnError(error: unknown): Error {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT") {
    return friendlyMissingCopilotError();
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function buildCopilotArgs(prompt: string, model?: string): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--no-color",
    // Keep the run hermetic: no repo AGENTS.md, no MCP servers, no tools, no
    // interactive questions, no log files, no self-update mid-summarization.
    "--no-custom-instructions",
    "--disable-builtin-mcps",
    // An EMPTY --available-tools= is silently ignored by the CLI, which leaves
    // bash and file writes reachable from a summarization prompt. Naming a
    // tool that does not exist is what actually yields a toolless model.
    "--available-tools=__none__",
    "--no-ask-user",
    "--log-level",
    "none",
    "--no-auto-update",
    "--stream",
    "off",
  ];

  if (model && model.trim()) {
    args.push("--model", model.trim());
  }

  return args;
}

type CopilotProcessDeps = {
  model?: string;
  spawn?: typeof defaultSpawn;
  timeoutMs?: number;
};

function runCopilotSummarizer(
  prompt: string,
  deps: Required<Pick<CopilotProcessDeps, "spawn" | "timeoutMs">> & { model?: string },
  onUsage?: SummarizeContext["onUsage"],
): Promise<string> {
  const promptBytes = Buffer.byteLength(prompt, "utf-8");
  if (promptBytes > MAX_PROMPT_BYTES) {
    return Promise.reject(new Error(
      `copilot prompt is ${promptBytes} bytes, over the ${MAX_PROMPT_BYTES}-byte limit — ` +
      "the Copilot CLI only accepts prompts as command-line arguments. Use a provider that " +
      "does not pass the prompt via argv (claude, codex, anthropic, openai) for chunks this large.",
    ));
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;

    try {
      child = deps.spawn("copilot", buildCopilotArgs(prompt, deps.model), {
        stdio: ["pipe", "pipe", "pipe"],
      });
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
      reject(new Error(`copilot process timed out after ${Math.round(deps.timeoutMs / 1000)}s`));
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

      const outcome = parseCopilotJsonl(stdout);
      const usage = toUsage(outcome, deps.model);
      if (usage) onUsage?.(usage);

      if (code !== 0) {
        reject(buildCopilotExitError(code, stderr, stdout));
        return;
      }
      if (!outcome.content) {
        reject(new Error("copilot output was empty"));
        return;
      }
      resolve(outcome.content);
    });

    // The prompt travels in argv; close stdin so copilot never waits on it.
    child.stdin.end();
  });
}

export function createCopilotProcessSummarizer(opts: CopilotProcessDeps = {}): LcmSummarizeFn {
  const deps = {
    model: opts.model,
    spawn: opts.spawn ?? defaultSpawn,
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
  };

  return async function summarize(text, aggressive, ctx = {}): Promise<string> {
    // The Copilot CLI has no system-prompt flag, so the preamble is folded in.
    const prompt = buildSummaryPromptWithSystem(text, aggressive, ctx);
    return runCopilotSummarizer(prompt, deps, ctx.onUsage);
  };
}
