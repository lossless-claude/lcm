import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { DaemonClient } from "../daemon/client.js";
import { loadDaemonConfig } from "../daemon/config.js";
import { ensureDaemon } from "../daemon/lifecycle.js";
import { lcmGrepTool } from "./tools/lcm-grep.js";
import { lcmExpandTool } from "./tools/lcm-expand.js";
import { lcmDescribeTool } from "./tools/lcm-describe.js";
import { lcmSearchTool } from "./tools/lcm-search.js";
import { lcmStoreTool } from "./tools/lcm-store.js";
import { lcmStatsTool } from "./tools/lcm-stats.js";
import { lcmDoctorTool } from "./tools/lcm-doctor.js";

const TOOLS = [lcmGrepTool, lcmExpandTool, lcmDescribeTool, lcmSearchTool, lcmStoreTool, lcmStatsTool, lcmDoctorTool];

const TOOL_ROUTES: Record<string, string> = {
  lcm_grep: "/grep",
  lcm_expand: "/expand",
  lcm_describe: "/describe",
  lcm_search: "/search",
  lcm_store: "/store",
};

const LOCAL_TOOLS: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  lcm_stats: async (args) => {
    const { collectStats, formatNumber } = await import("../stats.js");
    const stats = collectStats();
    const verbose = args.verbose === true;
    const lines: string[] = [];

    // Memory section
    lines.push("## 🧠 Memory");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Projects | ${stats.projects} |`);
    lines.push(`| Conversations | ${stats.conversations} |`);
    lines.push(`| Messages | ${formatNumber(stats.messages)} |`);
    lines.push(`| Summaries | ${formatNumber(stats.summaries)} |`);
    lines.push(`| DAG depth | ${stats.maxDepth} |`);
    lines.push(`| Promoted memories | ${stats.promotedCount} |`);

    // Compression section (only when summarization has happened)
    if (stats.summaries > 0) {
      lines.push("");
      lines.push("## Compression");
      lines.push("");
      lines.push("| Metric | Value |");
      lines.push("|--------|-------|");

      const rawStr = formatNumber(stats.rawTokens);
      const sumStr = formatNumber(stats.summaryTokens);
      const savedPct = stats.rawTokens > 0
        ? ((1 - stats.summaryTokens / stats.rawTokens) * 100).toFixed(1)
        : "0.0";
      const ratio = stats.ratio > 0 ? stats.ratio.toFixed(1) + "x" : "–";

      const barWidth = 30;
      const filled = stats.rawTokens > 0
        ? Math.round((1 - stats.summaryTokens / stats.rawTokens) * barWidth)
        : 0;
      const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

      lines.push(`| Compacted | ${stats.compactedConversations} of ${stats.conversations} conversations |`);
      lines.push(`| Tokens | ${rawStr} → ${sumStr} |`);
      lines.push(`| Ratio | ${ratio} |`);
      lines.push(`| | ${savedPct}% compressed |`);
      lines.push(`| | \`${bar}\` |`);

      // Per Conversation (verbose, compacted-only)
      if (verbose) {
        const compactedDetails = stats.conversationDetails.filter((c) => c.summaries > 0);
        if (compactedDetails.length > 0) {
          lines.push("");
          lines.push("## Per Conversation");
          lines.push("");
          lines.push("| # | msgs | sums | depth | tokens | ratio |");
          lines.push("|---|------|------|-------|--------|-------|");
          for (const c of compactedDetails) {
            const tokensStr = `${formatNumber(c.rawTokens)} → ${formatNumber(c.summaryTokens)}`;
            const r = c.ratio > 0 ? c.ratio.toFixed(1) + "x" : "–";
            lines.push(`| ${c.conversationId} | ${c.messages} | ${c.summaries} | ${c.maxDepth} | ${tokensStr} | ${r} |`);
          }
        }
      }
    }

    // Security section (always shown)
    {
      const rc = stats.redactionCounts;
      lines.push("");
      lines.push("## 🔒 Security");
      lines.push("");
      lines.push("| Metric | Value |");
      lines.push("|--------|-------|");
      if (rc.total === 0) {
        lines.push(`| Redactions | 0 |`);
      } else {
        lines.push(`| Redactions | ${rc.total} total (built-in: ${rc.builtIn}  global: ${rc.global}  project: ${rc.project}) |`);
      }
    }

    return lines.join("\n");
  },
  lcm_doctor: async () => {
    const { runDoctor, formatResultsPlain } = await import("../doctor/doctor.js");
    const results = await runDoctor();
    return formatResultsPlain(results);
  },
};

export function getMcpToolDefinitions() { return TOOLS; }

export type DaemonRequestOpts = {
  port: number;
  pidFilePath: string;
  _ensureDaemon?: typeof ensureDaemon;
};

/** Returns true if the error is a network/connection failure (not a daemon HTTP error). */
function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

/** Exported for testing. Calls a daemon route with auto-restart + retry on network failure. */
export async function handleDaemonRequest(
  client: Pick<DaemonClient, "post">,
  route: string,
  body: Record<string, unknown>,
  opts: DaemonRequestOpts,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const result = await client.post(route, body);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    // Only retry on network/connection errors, not daemon HTTP errors (4xx/5xx)
    if (!isNetworkError(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `lcm error: ${msg}` }], isError: true };
    }
    // Daemon crashed — attempt auto-restart then retry once
    const ensure = opts._ensureDaemon ?? ensureDaemon;
    try {
      await ensure({ port: opts.port, pidFilePath: opts.pidFilePath, spawnTimeoutMs: 10000 });
    } catch {
      // ensureDaemon failure is non-fatal — proceed to retry anyway
    }
    try {
      const result = await client.post(route, body);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (retryErr) {
      const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      return { content: [{ type: "text", text: `lcm daemon unavailable: ${msg}` }], isError: true };
    }
  }
}

export async function startMcpServer(): Promise<void> {
  const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
  const port = config.daemon.port;
  const pidFilePath = join(homedir(), ".lossless-claude", "daemon.pid");

  await ensureDaemon({ port, pidFilePath, spawnTimeoutMs: 10000 });

  const client = new DaemonClient(`http://127.0.0.1:${port}`);
  const server = new Server({ name: "lcm", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    const localHandler = LOCAL_TOOLS[name];
    if (localHandler) {
      try {
        const text = await localHandler(args);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `lcm error: ${msg}` }], isError: true };
      }
    }

    const route = TOOL_ROUTES[name];
    if (!route) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    const body = { ...args, cwd: process.env.PWD ?? process.cwd() };
    return handleDaemonRequest(client, route, body, { port, pidFilePath });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
