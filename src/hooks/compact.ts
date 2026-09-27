import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { PKG_VERSION } from "../daemon/version.js";
import type { LcmPaths } from "../lcm-paths.js";
import { randomUUID } from "node:crypto";
import { observeHook } from "./observe.js";

/**
 * Deadline for /compact — summarization calls an LLM, so allow minutes, not seconds.
 * Keep in sync with the PreCompact `timeout` in .claude-plugin/plugin.json; without a
 * matching host timeout Claude Code kills the hook at its 60s default and this deadline
 * never fires.
 */
const COMPACT_TIMEOUT_MS = 120_000;

export async function handlePreCompact(stdin: string, client: DaemonClient, paths: LcmPaths, port?: number): Promise<{ exitCode: number; stdout: string }> {
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(stdin || "{}") as Record<string, unknown>;
  } catch {
    return { exitCode: 0, stdout: "" };
  }
  const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const operationId = randomUUID();
  const observeDelivery = (status: "accepted" | "rejected" | "unconfirmed", reason?: string) =>
    observeHook(cwd, {
      sessionId, harness: "claude-command", hook: "PreCompact", operation: "precompact",
      kind: "delivery", status, reason, operationId,
      ...(status === "rejected" ? { failureCode: reason ?? "rejected" } : {}),
    }, paths);
  const daemonPort = port ?? 3737;
  const pidFilePath = paths.pidPath;
  try {
    const { connected } = await ensureDaemon({ port: daemonPort, pidFilePath, spawnTimeoutMs: 5000, expectedVersion: PKG_VERSION });
    if (!connected) {
      observeDelivery("unconfirmed", "daemon-unavailable");
      return { exitCode: 0, stdout: "" };
    }
    const result = await client.post<{ summary: string; latestSummaryContent?: string }>("/compact", {
      ...input,
      client: "claude",
      capture_required: true,
      operation_id: operationId,
    }, { timeoutMs: COMPACT_TIMEOUT_MS });
    observeDelivery("accepted");

    try {
      const { firePromoteEventsRequest } = await import("./daemon-requests.js");
      firePromoteEventsRequest(daemonPort, { cwd: input.cwd }, paths);
    } catch {
      // Silent fail — PreCompact must not delay session
    }

    const parts: string[] = [];
    if (result.summary) parts.push(result.summary);
    if (result.latestSummaryContent) {
      const truncated = result.latestSummaryContent.length > 2000
        ? result.latestSummaryContent.slice(0, 2000) + "\n[truncated]"
        : result.latestSummaryContent;
      parts.push(truncated);
    }

    return { exitCode: 0, stdout: parts.join("\n\n") };
  } catch (err) {
    const status = (err as { status?: unknown })?.status;
    observeDelivery(typeof status === "number" ? "rejected" : "unconfirmed",
      typeof status === "number" ? `http-${status}` : err instanceof Error && err.name === "TimeoutError" ? "timeout" : "transport");
    return { exitCode: 0, stdout: "" };
  }
}
