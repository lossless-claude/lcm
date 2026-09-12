import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { PKG_VERSION } from "../daemon/version.js";
import { join } from "node:path";
import { lcmPath } from "../lcm-home.js";

/**
 * Deadline for /compact — summarization calls an LLM, so allow minutes, not seconds.
 * Keep in sync with the PreCompact `timeout` in .claude-plugin/plugin.json; without a
 * matching host timeout Claude Code kills the hook at its 60s default and this deadline
 * never fires.
 */
const COMPACT_TIMEOUT_MS = 120_000;

export async function handlePreCompact(stdin: string, client: DaemonClient, port?: number): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = lcmPath("daemon.pid");
  const { connected } = await ensureDaemon({ port: daemonPort, pidFilePath, spawnTimeoutMs: 5000, expectedVersion: PKG_VERSION });
  if (!connected) return { exitCode: 0, stdout: "" };

  try {
    const input = JSON.parse(stdin || "{}");
    const result = await client.post<{ summary: string; latestSummaryContent?: string }>("/compact", {
      ...input,
      client: "claude",
    }, { timeoutMs: COMPACT_TIMEOUT_MS });

    try {
      const { firePromoteEventsRequest } = await import("./session-end.js");
      firePromoteEventsRequest(daemonPort, { cwd: input.cwd });
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
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
