import { spawn } from "node:child_process";
import type { LcmSummarizeFn, SummarizeContext } from "./types.js";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  resolveTargetTokens,
} from "../summarize.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 120_000;

export function createClaudeProcessSummarizer(): LcmSummarizeFn {
  return async function summarize(text: string, aggressive?: boolean, ctx: SummarizeContext = {}): Promise<string> {
    const estimatedInputTokens = Math.ceil(text.length / 4);
    const targetTokens = ctx.targetTokens ?? resolveTargetTokens({
      inputTokens: estimatedInputTokens,
      mode: aggressive ? "aggressive" : "normal",
      isCondensed: ctx.isCondensed ?? false,
      condensedTargetTokens: 2000,
    });

    const prompt = ctx.isCondensed
      ? buildCondensedSummaryPrompt({ text, targetTokens, depth: ctx.depth ?? 1 })
      : buildLeafSummaryPrompt({ text, mode: aggressive ? "aggressive" : "normal", targetTokens });

    return new Promise((resolve, reject) => {
      const proc = spawn("claude", [
        "--print",
        "--model", HAIKU_MODEL,
        "--no-session-persistence",
        "--system-prompt", LCM_SUMMARIZER_SYSTEM_PROMPT,
        "--tools", "",
        "--disable-slash-commands",
      ], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`claude process timed out after ${TIMEOUT_MS / 1000}s`));
      }, TIMEOUT_MS);

      proc.on("close", (code: number | null) => {
        clearTimeout(timer);
        const out = stdout.trim();
        if (code === 0 && out) {
          resolve(out);
        } else {
          reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200) || "no output"}`));
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  };
}
