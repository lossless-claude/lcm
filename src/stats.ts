import { DatabaseSync } from "node:sqlite";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runLcmMigrations } from "./db/migration.js";
import { collectEventStats } from "./db/events-stats.js";
import { RecallStore, type RecallStats } from "./db/recall.js";
import { PromotedStore } from "./db/promoted.js";
import { loadDaemonConfig } from "./daemon/config.js";

export type { RecallStats };

interface ConversationStats {
  conversationId: number;
  messages: number;
  summaries: number;
  maxDepth: number;
  rawTokens: number;
  summaryTokens: number;
  ratio: number;
  promotedCount: number;
}

export interface RedactionCounts {
  builtIn: number;
  global: number;
  project: number;
  total: number;
}

interface OverallStats {
  projects: number;
  conversations: number;
  compactedConversations: number;
  messages: number;
  summaries: number;
  maxDepth: number;
  rawTokens: number;
  summaryTokens: number;
  ratio: number;
  promotedCount: number;
  conversationDetails: ConversationStats[];
  redactionCounts: RedactionCounts;
  eventsCaptured: number;
  eventsUnprocessed: number;
  eventsErrors: number;
  recallStats: RecallStats;
  staleCount: number;
}

function queryProjectStats(dbPath: string, projectId: string): Omit<OverallStats, "projects" | "recallStats" | "staleCount"> & { recallStats: RecallStats; staleCount: number } {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");

  try {
    runLcmMigrations(db);
    const msgStats = db.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(token_count), 0) as tokens FROM messages`
    ).get() as { count: number; tokens: number };

    const sumStats = db.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(token_count), 0) as tokens, COALESCE(MAX(depth), 0) as maxDepth FROM summaries`
    ).get() as { count: number; tokens: number; maxDepth: number };

    const promoted = db.prepare(
      `SELECT COUNT(*) as count FROM promoted`
    ).get() as { count: number };

    const redactionRows = db.prepare(
      `SELECT category, COALESCE(SUM(count), 0) as count FROM redaction_stats WHERE project_id = ? GROUP BY category`
    ).all(projectId) as { category: string; count: number }[];
    const redactionMap = Object.fromEntries(redactionRows.map((r) => [r.category, r.count]));
    const redactionCounts: RedactionCounts = {
      builtIn: redactionMap["built_in"] ?? 0,
      global: redactionMap["global"] ?? 0,
      project: redactionMap["project"] ?? 0,
      total: 0,
    };
    redactionCounts.total = redactionCounts.builtIn + redactionCounts.global + redactionCounts.project;

    const convRows = db.prepare(`
      SELECT
        c.conversation_id,
        COALESCE(m.msg_count, 0) as messages,
        COALESCE(s.sum_count, 0) as summaries,
        COALESCE(s.max_depth, 0) as max_depth,
        COALESCE(m.raw_tokens, 0) as raw_tokens,
        COALESCE(s.sum_tokens, 0) as summary_tokens
      FROM conversations c
      LEFT JOIN (
        SELECT conversation_id, COUNT(*) as msg_count, SUM(token_count) as raw_tokens
        FROM messages GROUP BY conversation_id
      ) m ON m.conversation_id = c.conversation_id
      LEFT JOIN (
        SELECT conversation_id, COUNT(*) as sum_count, SUM(token_count) as sum_tokens, MAX(depth) as max_depth
        FROM summaries GROUP BY conversation_id
      ) s ON s.conversation_id = c.conversation_id
      ORDER BY c.conversation_id DESC
    `).all() as { conversation_id: number; messages: number; summaries: number; max_depth: number; raw_tokens: number; summary_tokens: number }[];

    const conversationDetails: ConversationStats[] = convRows.map((r) => ({
      conversationId: r.conversation_id,
      messages: r.messages,
      summaries: r.summaries,
      maxDepth: r.max_depth,
      rawTokens: r.raw_tokens,
      summaryTokens: r.summary_tokens,
      ratio: r.summary_tokens > 0 && r.raw_tokens > 0 ? r.raw_tokens / r.summary_tokens : 0,
      promotedCount: 0,
    }));

    // Compression metrics only count conversations where summarization happened
    const compacted = conversationDetails.filter((c) => c.summaries > 0);
    const compactedRaw = compacted.reduce((s, c) => s + c.rawTokens, 0);
    const compactedSum = compacted.reduce((s, c) => s + c.summaryTokens, 0);

    const recallStats = new RecallStore(db).getStats();

    // Count stale promoted memories
    let staleCount = 0;
    try {
      const cfg = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
      staleCount = new PromotedStore(db).findStale({
        staleAfterDays: cfg.restoration.staleAfterDays,
        staleSurfacingWithoutUseLimit: cfg.restoration.staleSurfacingWithoutUseLimit,
        projectId,
      }).length;
    } catch { /* non-fatal */ }

    return {
      conversations: convRows.length,
      compactedConversations: compacted.length,
      messages: msgStats.count,
      summaries: sumStats.count,
      maxDepth: sumStats.maxDepth,
      rawTokens: compactedRaw,
      summaryTokens: compactedSum,
      ratio: compactedSum > 0 && compactedRaw > 0 ? compactedRaw / compactedSum : 0,
      promotedCount: promoted.count,
      conversationDetails,
      redactionCounts,
      eventsCaptured: 0, eventsUnprocessed: 0, eventsErrors: 0,
      recallStats,
      staleCount,
    };
  } finally {
    db.close();
  }
}

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function formatRatio(before: number, after: number): string {
  if (before > 0 && after > 0) return (before / after).toFixed(1);
  return "\u2013";
}

function pad(s: string, width: number, align: "left" | "right" = "right"): string {
  return align === "left" ? s.padEnd(width) : s.padStart(width);
}

function sectionHeader(name: string): string {
  const cyan = "\x1b[36m";
  const reset = "\x1b[0m";
  const totalWidth = 42;
  // "── Name ────..."
  const prefix = `── ${name} `;
  const remaining = totalWidth - prefix.length;
  const dashes = "─".repeat(Math.max(0, remaining));
  return `    ${cyan}${prefix}${dashes}${reset}`;
}

export function printStats(stats: OverallStats, verbose: boolean): void {
  const dim = "\x1b[2m";
  const cyan = "\x1b[36m";
  const green = "\x1b[32m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";

  console.log();
  console.log(`    ${bold}${cyan}🧠 lossless-claude${reset}`);
  console.log();

  // Memory section
  console.log(sectionHeader("Memory"));
  console.log();

  const memRows: [string, string][] = [
    ["Projects", String(stats.projects)],
    ["Messages", formatNumber(stats.messages)],
    ["Summaries", formatNumber(stats.summaries)],
    ["DAG depth", String(stats.maxDepth)],
    ["Promoted memories", String(stats.promotedCount)],
  ];

  if (stats.eventsCaptured > 0) {
    memRows.push(["Events", `${formatNumber(stats.eventsCaptured)} captured (${stats.eventsUnprocessed} unprocessed, ${stats.eventsErrors} errors (30d))`]);
  }

  const labelWidth = Math.max(...memRows.map(([l]) => l.length));
  for (const [label, value] of memRows) {
    console.log(`    ${dim}${pad(label, labelWidth, "left")}${reset}  ${value}`);
  }

  // Compression section (only when summarization has happened)
  if (stats.summaries > 0) {
    console.log();
    console.log(sectionHeader("Compression"));
    console.log();

    const rawStr = formatNumber(stats.rawTokens);
    const sumStr = formatNumber(stats.summaryTokens);
    const savedPct = stats.rawTokens > 0
      ? ((1 - stats.summaryTokens / stats.rawTokens) * 100).toFixed(1)
      : "0.0";
    const ratioStr = stats.ratio > 0 ? stats.ratio.toFixed(1) + "x" : "–";
    const barColor = stats.ratio > 10 ? green : cyan;

    const compactedStr = `${stats.compactedConversations} of ${stats.projects} projects`;
    const tokensStr = `${rawStr} → ${sumStr}`;

    const compRows: [string, string][] = [
      ["Compacted", compactedStr],
      ["Tokens", tokensStr],
      ["Ratio", ratioStr],
    ];

    const cLabelWidth = Math.max(...compRows.map(([l]) => l.length));
    for (const [label, value] of compRows) {
      console.log(`    ${dim}${pad(label, cLabelWidth, "left")}${reset}  ${value}`);
    }

    // Percentage line
    console.log(`    ${" ".repeat(cLabelWidth)}  ${savedPct}% compressed`);

    // Visual bar (30 chars wide)
    const barWidth = 30;
    const filled = stats.rawTokens > 0
      ? Math.round((1 - stats.summaryTokens / stats.rawTokens) * barWidth)
      : 0;
    const empty = barWidth - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    console.log(`    ${" ".repeat(cLabelWidth)}  ${barColor}${bar}${reset}`);
  }

  // Security section (always shown)
  {
    const rc = stats.redactionCounts;
    console.log();
    console.log(sectionHeader("Security"));
    console.log();

    if (rc.total === 0) {
      console.log(`    ${dim}redactions${reset}  0`);
    } else {
      const detail = `(built-in: ${rc.builtIn}  global: ${rc.global}  project: ${rc.project})`;
      console.log(`    ${dim}redactions${reset}  ${rc.total} total  ${dim}${detail}${reset}`);
    }
  }

  // Recall section (only when any surfacing data exists)
  if (stats.recallStats.memoriesSurfaced > 0 || stats.recallStats.memoriesActedUpon > 0) {
    const rc = stats.recallStats;
    console.log();
    console.log(sectionHeader("Recall"));
    console.log();

    const precisionStr = rc.recallPrecision !== null
      ? `${rc.recallPrecision.toFixed(1)}%`
      : "–";

    const recallRows: [string, string][] = [
      ["Surfaced", String(rc.memoriesSurfaced)],
      ["Acted upon", String(rc.memoriesActedUpon)],
      ["Precision", precisionStr],
    ];
    const rLabelWidth = Math.max(...recallRows.map(([l]) => l.length));
    for (const [label, value] of recallRows) {
      console.log(`    ${dim}${pad(label, rLabelWidth, "left")}${reset}  ${value}`);
    }

    if (rc.topRecalled.length > 0) {
      console.log();
      console.log(`    ${dim}Top recalled memories:${reset}`);
      for (const m of rc.topRecalled) {
        const preview = m.content.length > 60 ? m.content.slice(0, 60) + "…" : m.content;
        console.log(`    ${dim}×${m.actCount}${reset}  ${preview}`);
      }
    }
  }

  // Per Conversation (verbose only, compacted only)
  if (verbose) {
    // Stale memories section (verbose only)
    if (stats.staleCount > 0) {
      const yellow = "\x1b[33m";
      console.log();
      console.log(sectionHeader("Stale Memories"));
      console.log();
      console.log(`    ${dim}candidates${reset}  ${yellow}${stats.staleCount}${reset} promoted memories may be stale`);
      console.log(`    ${dim}${reset}           Run ${cyan}lcm review-stale${reset} to inspect and archive.`);
    }

    const compactedDetails = stats.conversationDetails.filter((c) => c.summaries > 0);
    if (compactedDetails.length > 0) {
      console.log();
      console.log(sectionHeader("Per Conversation"));
      console.log();

      const hdr = ["#", "msgs", "sums", "depth", "tokens", "ratio"];
      const colWidths = [4, 6, 6, 5, 16, 6];

      const header = hdr.map((h, i) => pad(h, colWidths[i])).join("  ");
      console.log(`    ${dim}${header}${reset}`);
      console.log(`    ${dim}${"─".repeat(header.length)}${reset}`);

      for (const c of compactedDetails) {
        const tokensStr = `${formatNumber(c.rawTokens)} → ${formatNumber(c.summaryTokens)}`;
        const r = c.ratio > 0 ? c.ratio.toFixed(1) + "x" : "–";

        const cells = [
          pad(String(c.conversationId), colWidths[0]),
          pad(formatNumber(c.messages), colWidths[1]),
          pad(formatNumber(c.summaries), colWidths[2]),
          pad(String(c.maxDepth), colWidths[3]),
          pad(tokensStr, colWidths[4]),
          pad(r, colWidths[5]),
        ];
        console.log(`    ${cells.join("  ")}`);
      }
    }
  }

  console.log();
}

export function collectStats(): OverallStats {
  const baseDir = join(homedir(), ".lossless-claude", "projects");

  const emptyRecallStats: RecallStats = {
    memoriesSurfaced: 0, memoriesActedUpon: 0, recallPrecision: null, topRecalled: [],
  };

  if (!existsSync(baseDir)) {
    return {
      projects: 0, conversations: 0, compactedConversations: 0, messages: 0, summaries: 0,
      maxDepth: 0, rawTokens: 0, summaryTokens: 0, ratio: 0,
      promotedCount: 0, conversationDetails: [],
      redactionCounts: { builtIn: 0, global: 0, project: 0, total: 0 },
      eventsCaptured: 0, eventsUnprocessed: 0, eventsErrors: 0,
      recallStats: emptyRecallStats,
      staleCount: 0,
    };
  }

  let totalProjects = 0;
  let totalConversations = 0;
  let totalCompacted = 0;
  let totalMessages = 0;
  let totalSummaries = 0;
  let totalMaxDepth = 0;
  let totalRawTokens = 0;
  let totalSummaryTokens = 0;
  let totalPromoted = 0;
  let totalStale = 0;
  let allDetails: ConversationStats[] = [];
  const totalRedactions: RedactionCounts = { builtIn: 0, global: 0, project: 0, total: 0 };
  let totalMemoriesSurfaced = 0;
  let totalMemoriesActedUpon = 0;
  const allTopRecalled: Array<{ id: string; content: string; actCount: number }> = [];

  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dbPath = join(baseDir, entry.name, "db.sqlite");
    if (!existsSync(dbPath)) continue;

    try {
      const projStats = queryProjectStats(dbPath, entry.name);
      // Only count projects with stored messages
      if (projStats.messages === 0) continue;
      totalProjects++;
      totalConversations += projStats.conversations;
      totalCompacted += projStats.compactedConversations;
      totalMessages += projStats.messages;
      totalSummaries += projStats.summaries;
      totalMaxDepth = Math.max(totalMaxDepth, projStats.maxDepth);
      totalRawTokens += projStats.rawTokens;
      totalSummaryTokens += projStats.summaryTokens;
      totalPromoted += projStats.promotedCount;
      totalStale += projStats.staleCount;
      allDetails = allDetails.concat(projStats.conversationDetails);
      totalRedactions.builtIn += projStats.redactionCounts.builtIn;
      totalRedactions.global += projStats.redactionCounts.global;
      totalRedactions.project += projStats.redactionCounts.project;
      totalRedactions.total += projStats.redactionCounts.total;
      totalMemoriesSurfaced += projStats.recallStats.memoriesSurfaced;
      totalMemoriesActedUpon += projStats.recallStats.memoriesActedUpon;
      allTopRecalled.push(...projStats.recallStats.topRecalled);
    } catch {
      // skip corrupt databases
    }
  }

  // Passive learning event stats
  let eventsCaptured = 0;
  let eventsUnprocessed = 0;
  let eventsErrors = 0;
  try {
    const eventStats = collectEventStats(2000);
    eventsCaptured = eventStats.captured;
    eventsUnprocessed = eventStats.unprocessed;
    eventsErrors = eventStats.errors;
  } catch { /* non-fatal */ }

  // Deduplicate and sort allTopRecalled, take top 5 globally
  const topRecalledByCount = allTopRecalled
    .sort((a, b) => b.actCount - a.actCount)
    .slice(0, 5);
  const recallPrecision = totalMemoriesSurfaced > 0
    ? Math.min(100, (totalMemoriesActedUpon / totalMemoriesSurfaced) * 100)
    : null;

  return {
    projects: totalProjects,
    conversations: totalConversations,
    compactedConversations: totalCompacted,
    messages: totalMessages,
    summaries: totalSummaries,
    maxDepth: totalMaxDepth,
    rawTokens: totalRawTokens,
    summaryTokens: totalSummaryTokens,
    ratio: totalSummaryTokens > 0 ? totalRawTokens / totalSummaryTokens : 0,
    promotedCount: totalPromoted,
    conversationDetails: allDetails,
    redactionCounts: totalRedactions,
    eventsCaptured, eventsUnprocessed, eventsErrors,
    recallStats: {
      memoriesSurfaced: totalMemoriesSurfaced,
      memoriesActedUpon: totalMemoriesActedUpon,
      recallPrecision,
      topRecalled: topRecalledByCount,
    },
    staleCount: totalStale,
  };
}
