import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { join } from "node:path";
import { homedir } from "node:os";

type PromptSearchResponse = {
  hints: string[];
};

export async function handleUserPromptSubmit(
  stdin: string,
  client: DaemonClient,
  port?: number,
): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");
  const { connected } = await ensureDaemon({ port: daemonPort, pidFilePath, spawnTimeoutMs: 5000 });
  if (!connected) return { exitCode: 0, stdout: "" };

  try {
    const input = JSON.parse(stdin || "{}");
    if (!input.prompt || typeof input.prompt !== "string" || !input.prompt.trim()) {
      return { exitCode: 0, stdout: "" };
    }

    const result = await client.post<PromptSearchResponse>("/prompt-search", {
      query: input.prompt,
      cwd: input.cwd,
      session_id: input.session_id,
    });

    if (!result.hints || result.hints.length === 0) {
      return { exitCode: 0, stdout: "" };
    }

    const snippets = result.hints.map((h) => `- ${h}`).join("\n");
    const hint = `<memory-context>\nRelevant context from previous sessions (use lcm_expand for details):\n${snippets}\n</memory-context>`;
    return { exitCode: 0, stdout: hint };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
