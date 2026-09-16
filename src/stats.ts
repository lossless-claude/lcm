import { DatabaseSync } from "node:sqlite";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectEventStats } from "./db/events-stats.js";
import { closeLcmConnection, getLcmConnection } from "./db/connection.js";
import { collectLegacyUsageCounts, RecallStore, type RecallStats } from "./db/recall.js";
import { PromotedStore } from "./db/promoted.js";
import { isSignalTagged, parseStoredTags } from "./db/votes.js";
import { loadDaemonConfig } from "./daemon/config.js";
import { projectGroups } from "./daemon/project-group.js";
import type { LcmPaths } from "./lcm-paths.js";
import { SUBAGENT_SESSION_PREFIX } from "./search/native-history.js";

export type { RecallStats };

export function collectLegacyUsageByGroups(
  groupsByOwner: ReadonlyMap<string, readonly string[]>,
  open: (id: string) => DatabaseSync,
  close: (id: string) => void,
): { byOwner: Map<string, Map<string, number>>; ambiguousByOwner: Map<string, Set<string>> } {
  const byOwner = new Map<string, Map<string, number>>();
  const ambiguousByOwner = new Map<string, Set<string>>();
  const cached = new Map<string, ReturnType<typeof collectLegacyUsageCounts>>();
  for (const [owner, members] of groupsByOwner) {
    const group = [...new Set(members)].sort();
    const cacheKey = group.join("\0");
    let legacy = cached.get(cacheKey);
    if (!legacy) {
      const databases = new Map<string, DatabaseSync>();
      try {
        for (const id of group) {
          try { databases.set(id, open(id)); } catch { /* skip one unreadable member */ }
        }
        legacy = collectLegacyUsageCounts(databases);
      } catch { /* a malformed group does not suppress later groups */ }
      finally { for (const id of databases.keys()) close(id); }
      legacy ??= { byOwner: new Map(), ambiguousIds: new Set() };
      cached.set(cacheKey, legacy);
    }
    byOwner.set(owner, legacy.byOwner.get(owner) ?? new Map());
    ambiguousByOwner.set(owner, legacy.ambiguousIds);
  }
  return { byOwner, ambiguousByOwner };
}

export interface VoteObjection {
  voteId: string;
  reason: string;
  ownerProjectId: string;
}

export interface PromotionCandidate {
  id: string;
  ownerProjectId: string;
  content: string;
  useCount: number;
  plusOne: number;
  minusOne: number;
  objections: VoteObjection[];
}

export interface ContestedMemory {
  id: string;
  ownerProjectId: string;
  content: string;
  objections: VoteObjection[];
}

/**
 * Promotion candidates (heavily used, for a human to consider enforcing structurally) and
 * contested memories (at least one `-1`), read from votes and usage reports already stored
 * on this database's own promoted rows. Votes are always written into the database that
 * holds their target, so no cross-project join is needed here.
 */
function computePromotionSections(
  db: DatabaseSync,
  enforcementThreshold: number,
  ownerProjectId: string,
  legacyUsageCounts: ReadonlyMap<string, number> = new Map(),
  ambiguousIds: ReadonlySet<string> = new Set(),
): { promotionCandidates: PromotionCandidate[]; contested: ContestedMemory[] } {
  const promotedStore = new PromotedStore(db);
  const active = promotedStore.getAll().filter((r) => {
    const tags = parseStoredTags(r.tags);
    return tags !== null && !isSignalTagged(tags);
  });
  if (active.length === 0) return { promotionCandidates: [], contested: [] };

  const feedback = new RecallStore(db).getFeedback(active.map((r) => r.id), legacyUsageCounts, ambiguousIds);
  const voteCounts = promotedStore.getVoteCounts();

  const promotionCandidates: PromotionCandidate[] = [];
  const contested: ContestedMemory[] = [];

  for (const row of active) {
    const useCount = feedback.get(row.id)?.usageCount ?? 0;
    const votes = voteCounts.get(row.id) ?? { plusOne: 0, minusOne: 0, objections: [] };
    const objections: VoteObjection[] = votes.objections.map((o) => ({ voteId: o.voteId, reason: o.reason, ownerProjectId }));

    if (useCount >= enforcementThreshold) {
      promotionCandidates.push({ id: row.id, ownerProjectId, content: row.content, useCount, plusOne: votes.plusOne, minusOne: votes.minusOne, objections });
    }
    if (votes.minusOne > 0) {
      contested.push({ id: row.id, ownerProjectId, content: row.content, objections });
    }
  }

  return { promotionCandidates, contested };
}

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

export interface LlmUsageStats {
  calls: number;
  okCalls: number;
  failedCalls: number;
  tokensSpent: number;
  tokensInput: number;
  tokensCached: number;
  tokensOutput: number;
  /** `null` when nothing priced these calls — unknown, never free. */
  costUsd: number | null;
  /** How many of `calls` the cost covers; 0 means the total says nothing. */
  callsWithCost: number;
}

/**
 * How many stored conversations the search filter treats as subagent transcripts.
 * `byName` is what `SUBAGENT_SESSION` in src/search/native-history.ts matches: a session id
 * starting with `SUBAGENT_SESSION_PREFIX`, a naming convention owned by the host harness. `attributedNotByName`
 * are conversations the `.meta.json` sidecar attributed to a parent session but whose id the
 * name filter misses — non-zero means the convention drifted and search got noisier.
 */
export interface SubagentStats {
  byName: number;
  attributedNotByName: number;
}

interface OverallStats {
  projects: number;
  conversations: number;
  subagent: SubagentStats;
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
  llmUsage: LlmUsageStats;
  promotionCandidates: PromotionCandidate[];
  contested: ContestedMemory[];
}

/** Like every other optional metric here, a column the database lacks counts as 0. */
function querySubagentStats(db: DatabaseSync, conversationColumns: Set<string>): SubagentStats {
  // GLOB, unlike LIKE, is case-sensitive for ASCII in SQLite, matching the case-sensitive
  // SUBAGENT_SESSION regex in src/search/native-history.ts.
  const subagentGlob = `'${SUBAGENT_SESSION_PREFIX}*'`;
  const byName = conversationColumns.has("session_id") ? `SUM(session_id GLOB ${subagentGlob})` : "0";
  const attributedNotByName = conversationColumns.has("parent_session_id")
    ? `SUM(parent_session_id IS NOT NULL AND session_id NOT GLOB ${subagentGlob})`
    : "0";
  const row = db.prepare(
    `SELECT COALESCE(${byName}, 0) as byName,
            COALESCE(${attributedNotByName}, 0) as attributedNotByName
       FROM conversations`,
  ).get() as { byName: number; attributedNotByName: number };
  return { byName: row.byName, attributedNotByName: row.attributedNotByName };
}

function queryProjectStats(
  dbPath: string,
  projectId: string,
  staleCfg: { staleAfterDays: number; staleSurfacingWithoutUseLimit: number; enforcementThreshold: number },
  legacyUsageCounts: ReadonlyMap<string, number> = new Map(),
  ambiguousIds: ReadonlySet<string> = new Set(),
): Omit<OverallStats, "projects" | "recallStats" | "staleCount"> & { recallStats: RecallStats; staleCount: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000");

  try {
    const columns = (table: string) => new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
    );
    const summaryColumns = columns("summaries");
    const summaryDepth = summaryColumns.has("depth") ? "depth" : "0";
    const promotedColumns = columns("promoted");
    const usageColumns = columns("llm_usage_stats");
    const usageSum = (column: string, fallback = "0") => usageColumns.has(column) ? `SUM(${column})` : fallback;
    const msgStats = db.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(token_count), 0) as tokens FROM messages`
    ).get() as { count: number; tokens: number };

    const sumStats = db.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(token_count), 0) as tokens, COALESCE(MAX(${summaryDepth}), 0) as maxDepth FROM summaries`
    ).get() as { count: number; tokens: number; maxDepth: number };

    const promoted = promotedColumns.size ? db.prepare(
      `SELECT COUNT(*) as count FROM promoted`
    ).get() as { count: number } : { count: 0 };

    const redactionRows = columns("redaction_stats").size ? db.prepare(
      `SELECT category, COALESCE(SUM(count), 0) as count FROM redaction_stats WHERE project_id = ? GROUP BY category`
    ).all(projectId) as { category: string; count: number }[] : [];
    const redactionMap = Object.fromEntries(redactionRows.map((r) => [r.category, r.count]));
    const redactionCounts: RedactionCounts = {
      builtIn: redactionMap["built_in"] ?? 0,
      global: redactionMap["global"] ?? 0,
      project: redactionMap["project"] ?? 0,
      total: 0,
    };
    redactionCounts.total = redactionCounts.builtIn + redactionCounts.global + redactionCounts.project;

    const llmUsageRow = usageColumns.size ? db.prepare(
      `SELECT
         COALESCE(${usageSum("calls_total")}, 0) as calls,
         COALESCE(${usageSum("calls_ok")}, 0) as okCalls,
         COALESCE(${usageSum("calls_failed")}, 0) as failedCalls,
         COALESCE(${usageSum("tokens_spent_total")}, 0) as tokensSpent,
         COALESCE(${usageSum("tokens_input_total")}, 0) as tokensInput,
         COALESCE(${usageSum("tokens_cached_total")}, 0) as tokensCached,
         COALESCE(${usageSum("tokens_output_total")}, 0) as tokensOutput,
         -- Deliberately not COALESCEd: all-NULL must stay NULL, not become 0.
         ${usageSum("cost_usd_total", "NULL")} as costUsd,
         COALESCE(${usageSum("calls_with_cost")}, 0) as callsWithCost
       FROM llm_usage_stats`,
    ).get() as
      | { calls: number; okCalls: number; failedCalls: number; tokensSpent: number; tokensInput: number; tokensCached: number; tokensOutput: number; costUsd: number | null; callsWithCost: number }
      | undefined : undefined;

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
        SELECT conversation_id, COUNT(*) as sum_count, SUM(token_count) as sum_tokens, MAX(${summaryDepth}) as max_depth
        FROM summaries GROUP BY conversation_id
      ) s ON s.conversation_id = c.conversation_id
      ORDER BY c.conversation_id DESC
    `).all() as { conversation_id: number; messages: number; summaries: number; max_depth: number; raw_tokens: number; summary_tokens: number }[];

    const subagent = querySubagentStats(db, columns("conversations"));

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

    const activeMemoryIds = promotedColumns.has("archived_at")
      ? new Set(new PromotedStore(db).getAll()
        .filter((row) => {
          const tags = parseStoredTags(row.tags);
          return tags !== null && !isSignalTagged(tags);
        })
        .map((row) => row.id))
      : undefined;
    const recallStats: RecallStats = columns("recall_surfacing").size && promotedColumns.has("archived_at")
      ? new RecallStore(db).getStats(legacyUsageCounts, activeMemoryIds, ambiguousIds)
      : { memoriesSurfaced: 0, memoriesActedUpon: 0, recallPrecision: null, topRecalled: [] };

    // Count stale promoted memories (config is passed in to avoid re-reading per project)
    let staleCount = 0;
    try {
      staleCount = new PromotedStore(db).findStale({
        staleAfterDays: staleCfg.staleAfterDays,
        staleSurfacingWithoutUseLimit: staleCfg.staleSurfacingWithoutUseLimit,
        projectId,
        legacyUsageCounts,
        ambiguousIds,
      }).length;
    } catch { /* non-fatal */ }

    let promotionCandidates: PromotionCandidate[] = [];
    let contested: ContestedMemory[] = [];
    try {
      ({ promotionCandidates, contested } = computePromotionSections(db, staleCfg.enforcementThreshold, projectId, legacyUsageCounts, ambiguousIds));
    } catch { /* non-fatal */ }

    return {
      conversations: convRows.length,
      subagent,
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
      llmUsage: {
        calls: llmUsageRow?.calls ?? 0,
        okCalls: llmUsageRow?.okCalls ?? 0,
        failedCalls: llmUsageRow?.failedCalls ?? 0,
        tokensSpent: llmUsageRow?.tokensSpent ?? 0,
        tokensInput: llmUsageRow?.tokensInput ?? 0,
        tokensCached: llmUsageRow?.tokensCached ?? 0,
        tokensOutput: llmUsageRow?.tokensOutput ?? 0,
        costUsd: llmUsageRow?.costUsd ?? null,
        callsWithCost: llmUsageRow?.callsWithCost ?? 0,
      },
      promotionCandidates,
      contested,
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

/**
 * Summarizer calls cost fractions of a cent, so two decimals would print a
 * real charge as "$0.00" — the same "absent reads as free" bug an unreported
 * cost already guards against. Sub-dollar amounts keep six decimals.
 */
export function formatUsd(n: number): string {
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(6)}`;
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

/** One line: the share of conversations excluded from search as subagent, plus the drift count when non-zero. */
export function formatSubagentShare(stats: Pick<OverallStats, "conversations" | "subagent">): string {
  const { byName, attributedNotByName } = stats.subagent;
  const pct = stats.conversations > 0 ? ((byName / stats.conversations) * 100).toFixed(1) : "0.0";
  const share = `${byName} of ${stats.conversations} conversations (${pct}%) excluded from search`;
  return attributedNotByName > 0
    ? `${share}; ${attributedNotByName} attributed to a parent but not excluded`
    : share;
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
    ["Subagent", formatSubagentShare(stats)],
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

  // Summarizer section (only once the summarizer has reported a call)
  if (stats.llmUsage.calls > 0) {
    const usage = stats.llmUsage;
    console.log();
    console.log(sectionHeader("Summarizer"));
    console.log();

    const usageRows: [string, string][] = [
      ["Calls", `${usage.calls} (${usage.okCalls} ok, ${usage.failedCalls} failed)`],
      ["Tokens", formatNumber(usage.tokensSpent)],
      [
        "  breakdown",
        `${formatNumber(usage.tokensInput)} in (${formatNumber(usage.tokensCached)} cached), ` +
        `${formatNumber(usage.tokensOutput)} out`,
      ],
      [
        "Cost",
        // No priced call means nobody reported a figure, which is unknown;
        // printing $0.00 here would claim the summarization was free.
        usage.callsWithCost > 0 && usage.costUsd !== null
          ? `${formatUsd(usage.costUsd)} ${dim}(${usage.callsWithCost} of ${usage.calls} calls priced)${reset}`
          : `unknown ${dim}(0 of ${usage.calls} calls priced)${reset}`,
      ],
    ];

    const uLabelWidth = Math.max(...usageRows.map(([l]) => l.length));
    for (const [label, value] of usageRows) {
      console.log(`    ${dim}${pad(label, uLabelWidth, "left")}${reset}  ${value}`);
    }
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

  // Promotion candidates (always shown when non-empty: a human decides, not a hook)
  if (stats.promotionCandidates.length > 0) {
    console.log();
    console.log(sectionHeader("Promotion Candidates"));
    console.log();
    for (const c of stats.promotionCandidates) {
      const preview = c.content.length > 70 ? c.content.slice(0, 70) + "…" : c.content;
      console.log(`    ${dim}${preview}${reset}`);
      console.log(`    ${dim}id:${reset} ${c.id}  ${dim}owner:${reset} ${c.ownerProjectId}`);
      const objectionNote = c.minusOne > 0 ? `${dim} (contested — see below)${reset}` : "";
      console.log(`    ${dim}uses:${reset} ${c.useCount}  ${dim}+1:${reset} ${c.plusOne}  ${dim}-1:${reset} ${c.minusOne}${objectionNote}`);
      console.log();
    }
  }

  // Contested memories (at least one -1)
  if (stats.contested.length > 0) {
    const yellow = "\x1b[33m";
    console.log(sectionHeader("Contested"));
    console.log();
    for (const c of stats.contested) {
      const preview = c.content.length > 70 ? c.content.slice(0, 70) + "…" : c.content;
      console.log(`    ${yellow}${preview}${reset}`);
      console.log(`    ${dim}id:${reset} ${c.id}  ${dim}owner:${reset} ${c.ownerProjectId}`);
      for (const o of c.objections) {
        console.log(`    ${dim}-1 (${o.voteId}, owner: ${o.ownerProjectId}):${reset} ${o.reason}`);
      }
      console.log();
    }
    console.log(`    ${dim}Resolve: archive the memory, supersede it with a corrected lcm_store, or dismiss${reset}`);
    console.log(`    ${dim}a single objection by archiving its vote id via POST /review-stale (action: "archive").${reset}`);
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
      console.log(`    ${dim}${reset}           Call ${cyan}POST /review-stale${reset} to inspect and archive.`);
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

export function collectStats(paths: LcmPaths): OverallStats {
  const baseDir = paths.projectsDir;

  const emptyRecallStats: RecallStats = {
    memoriesSurfaced: 0, memoriesActedUpon: 0, recallPrecision: null, topRecalled: [],
  };

  if (!existsSync(baseDir)) {
    return {
      projects: 0, conversations: 0, subagent: { byName: 0, attributedNotByName: 0 },
      compactedConversations: 0, messages: 0, summaries: 0,
      maxDepth: 0, rawTokens: 0, summaryTokens: 0, ratio: 0,
      promotedCount: 0, conversationDetails: [],
      redactionCounts: { builtIn: 0, global: 0, project: 0, total: 0 },
      eventsCaptured: 0, eventsUnprocessed: 0, eventsErrors: 0,
      recallStats: emptyRecallStats,
      staleCount: 0,
      llmUsage: { calls: 0, okCalls: 0, failedCalls: 0, tokensSpent: 0, tokensInput: 0, tokensCached: 0, tokensOutput: 0, costUsd: null, callsWithCost: 0 },
      promotionCandidates: [],
      contested: [],
    };
  }

  let totalProjects = 0;
  let totalConversations = 0;
  const totalSubagent: SubagentStats = { byName: 0, attributedNotByName: 0 };
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
  const totalLlmUsage: LlmUsageStats = { calls: 0, okCalls: 0, failedCalls: 0, tokensSpent: 0, tokensInput: 0, tokensCached: 0, tokensOutput: 0, costUsd: null, callsWithCost: 0 };
  const allPromotionCandidates: PromotionCandidate[] = [];
  const allContested: ContestedMemory[] = [];

  // Load stale + promotion config once for all projects
  let staleCfg = { staleAfterDays: 90, staleSurfacingWithoutUseLimit: 5, enforcementThreshold: 3 };
  try {
    const cfg = loadDaemonConfig(paths.configPath);
    staleCfg = {
      staleAfterDays: cfg.restoration.staleAfterDays,
      staleSurfacingWithoutUseLimit: cfg.restoration.staleSurfacingWithoutUseLimit,
      enforcementThreshold: cfg.promotion.enforcementThreshold,
    };
  } catch { /* use defaults */ }

  const projectIds = new Set(
    readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(baseDir, entry.name, "db.sqlite")))
      .map((entry) => entry.name),
  );
  const cwdByProjectId = new Map<string, string>();
  for (const projectId of projectIds) {
    try {
      const meta = JSON.parse(readFileSync(join(baseDir, projectId, "meta.json"), "utf8")) as { cwd?: unknown };
      if (typeof meta.cwd === "string") cwdByProjectId.set(projectId, meta.cwd);
    } catch { /* a legacy project has no group identity */ }
  }
  const groupsByCwd = projectGroups(cwdByProjectId.values(), paths);
  const groupsByOwner = new Map<string, string[]>();
  for (const projectId of projectIds) {
    let groupIds = [projectId];
    const cwd = cwdByProjectId.get(projectId);
    if (cwd) groupIds = [...new Set([projectId, ...(groupsByCwd.get(cwd) ?? [])
      .map((member) => member.projectId)
      .filter((id) => projectIds.has(id))])];
    groupsByOwner.set(projectId, groupIds);
  }
  const { byOwner: legacyUsageByOwner, ambiguousByOwner } = collectLegacyUsageByGroups(
    groupsByOwner,
    (id) => getLcmConnection(join(baseDir, id, "db.sqlite"), { readOnly: true }),
    (id) => closeLcmConnection(join(baseDir, id, "db.sqlite"), { readOnly: true }),
  );

  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dbPath = join(baseDir, entry.name, "db.sqlite");
    if (!existsSync(dbPath)) continue;

    try {
      const projStats = queryProjectStats(dbPath, entry.name, staleCfg, legacyUsageByOwner.get(entry.name), ambiguousByOwner.get(entry.name));
      // Before the messages gate: a project can hold promoted memories and their use and
      // vote records without any conversation of its own — a fresh checkout using lcm_store.
      allPromotionCandidates.push(...projStats.promotionCandidates);
      allContested.push(...projStats.contested);
      // Only count projects with stored messages
      if (projStats.messages === 0) continue;
      totalProjects++;
      totalConversations += projStats.conversations;
      totalSubagent.byName += projStats.subagent.byName;
      totalSubagent.attributedNotByName += projStats.subagent.attributedNotByName;
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
      totalLlmUsage.calls += projStats.llmUsage.calls;
      totalLlmUsage.okCalls += projStats.llmUsage.okCalls;
      totalLlmUsage.failedCalls += projStats.llmUsage.failedCalls;
      totalLlmUsage.tokensSpent += projStats.llmUsage.tokensSpent;
      totalLlmUsage.tokensInput += projStats.llmUsage.tokensInput;
      totalLlmUsage.tokensCached += projStats.llmUsage.tokensCached;
      totalLlmUsage.tokensOutput += projStats.llmUsage.tokensOutput;
      // A project that priced nothing must not drag the total down to 0.
      if (projStats.llmUsage.costUsd !== null) {
        totalLlmUsage.costUsd = (totalLlmUsage.costUsd ?? 0) + projStats.llmUsage.costUsd;
      }
      totalLlmUsage.callsWithCost += projStats.llmUsage.callsWithCost;
    } catch {
      // skip corrupt databases
    }
  }

  // Passive learning event stats
  let eventsCaptured = 0;
  let eventsUnprocessed = 0;
  let eventsErrors = 0;
  try {
    const eventStats = collectEventStats(paths, 2000);
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
    subagent: totalSubagent,
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
    llmUsage: totalLlmUsage,
    promotionCandidates: allPromotionCandidates,
    contested: allContested,
  };
}
