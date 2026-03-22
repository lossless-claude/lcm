import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdtempSync as defaultMkdtempSync, readFileSync as defaultReadFileSync, rmSync as defaultRmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LcmSummarizeFn, SummarizeContext } from "./types.js";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  resolveTargetTokens,
} from "../summarize.js";

const TIMEOUT_MS = 120_000;

type CodexProcessDeps = {
  model?: string;
  spawn?: typeof defaultSpawn;
  mkdtempSync?: typeof defaultMkdtempSync;
  readFileSync?: typeof defaultReadFileSync;
  rmSync?: typeof defaultRmSync;
  tmpdir?: typeof tmpdir;
  timeoutMs?: number;
};

function buildPrompt(text: string, aggressive: boolean | undefined, ctx: SummarizeContext): string {
  const estimatedInputTokens = Math.ceil(text.length / 4);
  const targetTokens = ctx.targetTokens ?? resolveTargetTokens({
    inputTokens: estimatedInputTokens,
    mode: aggressive ? "aggressive" : "normal",
    isCondensed: ctx.isCondensed ?? false,
    condensedTargetTokens: 2000,
  });

  const summaryPrompt = ctx.isCondensed
    ? buildCondensedSummaryPrompt({ text, targetTokens, depth: ctx.depth ?? 1 })
    : buildLeafSummaryPrompt({ text, mode: aggressive ? "aggressive" : "normal", targetTokens });

  return [LCM_SUMMARIZER_SYSTEM_PROMPT, summaryPrompt].filter(Boolean).join("\n\n");
}

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
        if (code !== 0) {
          throw new Error(`codex exited ${code}: ${stderr.slice(0, 200) || "no output"}`);
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
    const prompt = buildPrompt(text, aggressive, ctx);
    return runCodexSummarizer(prompt, deps);
  };
}
