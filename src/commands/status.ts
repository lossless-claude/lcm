import { readFileSync } from "node:fs";
import { join } from "node:path";

export type StatusOptions = { json: boolean; provider: string };

export async function handleStatus(
  opts: StatusOptions,
  port: number,
  lcDir: string,
): Promise<void> {
  // Read auth token — best-effort, never throws
  let daemonToken: string | null = null;
  try {
    daemonToken = readFileSync(join(lcDir, "daemon.token"), "utf-8").trim();
  } catch {
    // ENOENT or unreadable — proceed without auth
  }

  let daemonStatus = "down";
  let statusData: Record<string, unknown> | null = null;

  try {
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    if (healthRes.ok) daemonStatus = "up";

    if (daemonStatus === "up") {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (daemonToken) headers["Authorization"] = `Bearer ${daemonToken}`;

      const statusRes = await fetch(`http://127.0.0.1:${port}/status`, {
        method: "POST",
        headers,
        body: JSON.stringify({ cwd: process.cwd() }),
      });
      if (statusRes.ok) {
        statusData = await statusRes.json() as Record<string, unknown>;
      } else if (statusRes.status === 401) {
        daemonStatus = "token-stale";
      }
    }
  } catch { /* daemon unreachable */ }

  if (opts.json) {
    const result = {
      daemon: daemonStatus === "up" && statusData
        ? (statusData as any).daemon
        : { status: daemonStatus },
      project: statusData ? (statusData as any).project : null,
    };
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (daemonStatus === "token-stale") {
    console.log("daemon: token stale — restart daemon with `lcm daemon start --detach`");
    return;
  }

  if (statusData) {
    const d = (statusData as any).daemon;
    const p = (statusData as any).project;
    console.log(`Daemon: up`);
    console.log(`  Version: ${d.version}`);
    console.log(`  Uptime: ${d.uptime}s`);
    console.log(`  Port: ${d.port}`);
    console.log(`  Provider: ${opts.provider}`);
    console.log();
    console.log("Project:");
    console.log(`  Messages: ${p.messageCount}`);
    console.log(`  Summaries: ${p.summaryCount}`);
    console.log(`  Promoted: ${p.promotedCount}`);
    if (p.lastIngest) console.log(`  Last Ingest: ${p.lastIngest}`);
    if (p.lastCompact) console.log(`  Last Compact: ${p.lastCompact}`);
    if (p.lastPromote) console.log(`  Last Promote: ${p.lastPromote}`);
  } else {
    console.log(`daemon: ${daemonStatus} · provider: ${opts.provider}`);
  }
}
