import type { DaemonClient } from "../daemon/client.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { join } from "node:path";
import { homedir } from "node:os";

export async function handleSessionStart(stdin: string, client: DaemonClient, port?: number): Promise<{ exitCode: number; stdout: string }> {
  const daemonPort = port ?? 3737;
  const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");
  const { connected } = await ensureDaemon({ port: daemonPort, pidFilePath, spawnTimeoutMs: 5000 });
  if (!connected) return { exitCode: 0, stdout: "" };

  try {
    const input = JSON.parse(stdin || "{}");
    const result = await client.post<{ context: string }>("/restore", input);
    return { exitCode: 0, stdout: result.context || "" };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}
