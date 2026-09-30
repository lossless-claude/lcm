import { workerRefusal } from "./worker-warning.js";
import { randomUUID } from "node:crypto";
import type { DaemonClient } from "./daemon/client.js";
import type { SummarizeJob, JobAnswer } from "./daemon/summarize-jobs.js";
import { validPoolModel } from "./daemon/summarize-jobs.js";

export type WorkerIdentity = { caller_session_id: string; cwd: string; client: "claude" | "codex"; transport: "cli" | "mcp" };
export type AgentClaim = { job?: SummarizeJob; worker_id: string; warning: string; guidance: string };
export type AgentSubmission = {
  jobId: string; workerId: string; model: string; text?: string; error?: string; usage?: JobAnswer["usage"];
};

/** Session identity comes only from the harness environment, never from tool arguments. */
export function agentWorkerIdentity(transport: "cli" | "mcp", env: NodeJS.ProcessEnv, cwd: string): WorkerIdentity {
  const claude = env.CLAUDE_CODE_SESSION_ID?.trim();
  const codex = env.CODEX_THREAD_ID?.trim();
  if (env.PI_SESSION_FILE || claude && codex) throw new Error("Worker harness identity is unverified or ambiguous. Use a dedicated Claude Code session, or Codex shell commands.");
  if (codex && transport === "mcp") throw new Error("Codex MCP session identity is unverified. Use the CLI in a dedicated Codex session.");
  const id = claude ?? codex;
  if (!id) throw new Error("Missing harness session identity. Start a dedicated session with LCM_SUMMARIZE_WORKER=1 and its lcm hooks enabled.");
  return { caller_session_id: id, cwd, client: claude ? "claude" : "codex", transport };
}

export function createAgentWorkerTransport(
  client: Pick<DaemonClient, "get" | "post">, transport: "cli" | "mcp",
  env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(),
) {
  const identity = () => agentWorkerIdentity(transport, env, cwd);
  return {
    async claim(): Promise<AgentClaim> {
      try {
        const bound = identity();
        const workerId = randomUUID();
        const query = new URLSearchParams({ ...bound, worker_id: workerId, wait_ms: "0" });
        return await client.get<AgentClaim>(`/summarize-jobs/next?${query}`);
      } catch (error) { throw workerRefusal(error); }
    },
    async submit(input: AgentSubmission): Promise<{ discarded: boolean }> {
      const bound = identity();
      if (!validPoolModel(input.model)) throw new Error("Invalid worker model id");
      if (!input.jobId?.trim() || !input.workerId?.trim()) throw new Error("jobId and workerId are required");
      return await client.post(`/summarize-jobs/${encodeURIComponent(input.jobId)}`, {
        ...bound, worker_id: input.workerId, providerId: `session-pool:${input.model}`,
        text: input.text, error: input.error, usage: input.usage,
      });
    },
  };
}
