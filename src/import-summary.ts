import type { ImportResult, RebuildRunResult } from "./import.js";
import { formatNumber, formatRatio, formatUsd } from "./stats.js";

export function printImportSummary(
  result: ImportResult,
  opts: { replay?: boolean } = {},
): void {
  const sessionsProcessed = result.imported + result.skippedEmpty + result.failed;
  const tokenSuffix = result.totalTokens > 0 ? `, ${formatNumber(result.totalTokens)} tokens` : "";
  console.log(`  ${result.imported} sessions imported (${result.totalMessages} messages${tokenSuffix})`);
  if (result.skippedEmpty > 0) console.log(`  ${result.skippedEmpty} skipped (empty transcript)`);
  if (result.failed > 0) console.log(`  ${result.failed} failed`);
  if (result.ompRootsScanned) console.log(`  OMP roots scanned: ${result.ompRootsScanned.join(", ")}`);
  if (result.ompDuplicatesSkipped) console.log(`  OMP duplicates skipped (session id also in another root): ${result.ompDuplicatesSkipped.join(", ")}`);

  if (opts.replay) {
    console.log("  [replay] Sessions compacted sequentially with threaded context.");
  }

  // Show compression summary when tokens were ingested
  if (result.totalTokens > 0) {
    const border = "\u2500".repeat(41);
    console.log();
    console.log(`  ${border}`);

    const rows: [string, string][] = [
      ["Sessions processed", String(sessionsProcessed)],
      ["Tokens ingested", formatNumber(result.totalTokens)],
    ];

    if (opts.replay && result.totalTokens > result.tokensAfter) {
      const ratio = formatRatio(result.totalTokens, result.tokensAfter);
      const freed = result.totalTokens - result.tokensAfter;
      rows.push(
        ["Tokens after", formatNumber(result.tokensAfter)],
        ["Compression ratio", `${ratio}\u00d7`],
        ["Tokens freed", formatNumber(freed)],
      );
    }

    const labelWidth = Math.max(...rows.map(([l]) => l.length));
    for (const [label, value] of rows) {
      console.log(`  ${label.padEnd(labelWidth)} : ${value}`);
    }

    console.log(`  ${border}`);
  }

  if (opts.replay && result.replayUsage && result.replayUsage.calls > 0) {
    const border = "\u2500".repeat(41);
    const avgPerSession =
      sessionsProcessed > 0 ? Math.round(result.replayUsage.tokensSpent / sessionsProcessed) : 0;
    const rows: [string, string][] = [
      ["Summarizer", `${result.replayUsage.provider} / ${result.replayUsage.model}`],
      [
        "Calls",
        `${result.replayUsage.calls} (${result.replayUsage.okCalls} ok, ${result.replayUsage.failedCalls} failed)`,
      ],
      ["Tokens spent", formatNumber(result.replayUsage.tokensSpent)],
      [
        "  breakdown",
        `${formatNumber(result.replayUsage.tokensInput)} in (${formatNumber(result.replayUsage.tokensCached)} cached), ` +
        `${formatNumber(result.replayUsage.tokensOutput)} out`,
      ],
      ["Avg per session", formatNumber(avgPerSession)],
      [
        "Cost",
        // Zero priced calls means nobody reported a price, which is unknown —
        // printing $0.00 here would claim the run was free.
        result.replayUsage.callsWithCost > 0 && result.replayUsage.costUsd !== undefined
          ? `${formatUsd(result.replayUsage.costUsd)} (${result.replayUsage.callsWithCost} of ${result.replayUsage.calls} calls priced)`
          : `unknown (0 of ${result.replayUsage.calls} calls priced)`,
      ],
    ];
    const labelWidth = Math.max(...rows.map(([l]) => l.length));
    console.log(`  ${border}`);
    for (const [label, value] of rows) {
      console.log(`  ${label.padEnd(labelWidth)} : ${value}`);
    }
    console.log(`  ${border}`);
  }
}

/** `lcm import --provider claude --rebuild`: one line per candidate session, then the totals. */
export function printRebuildSummary(run: RebuildRunResult, opts: { apply: boolean }): void {
  const counts = { aligned: 0, repairable: 0, unavailable: 0, ambiguous: 0 };
  let leaf = 0;
  let condensed = 0;
  for (const { cwd, plan, rebuilt, ingested, error } of run.sessions) {
    counts[plan.kind]++;
    const summaries = `${plan.leafSummaries} leaf and ${plan.condensedSummaries} condensed summaries`;
    if (plan.kind === "repairable") {
      leaf += plan.leafSummaries;
      condensed += plan.condensedSummaries;
    }
    const detail = plan.kind === "repairable" || plan.kind === "ambiguous"
      ? ` — ${plan.gaps} missing, ${plan.extras} extra stored rows, ${summaries}` : "";
    const outcome = error ? `; failed: ${error}` : rebuilt ? `; rebuilt: ${ingested} messages captured, summaries discarded` : "";
    console.log(`  ${plan.kind.padEnd(11)} ${plan.sessionId}${detail}${plan.reason ? ` (${plan.reason})` : ""}${outcome}  [${cwd}]`);
  }
  console.log(
    `  ${run.sessions.length} Claude Code sessions checked: ${counts.aligned} aligned, ${counts.repairable} repairable, ` +
      `${counts.unavailable} unavailable, ${counts.ambiguous} ambiguous.`,
  );
  for (const backup of run.backups) console.log(`  Backup: ${backup}`);
  for (const { cwd, error } of run.failedProjects) console.log(`  Not rebuilt in ${cwd}: ${error}`);
  if (!opts.apply) {
    if (counts.repairable > 0) {
      console.log(`  A rebuild would discard ${leaf} leaf and ${condensed} condensed summaries. No changes written; rerun with --yes to rebuild.`);
    } else {
      console.log("  Nothing to rebuild. No changes written.");
    }
  } else if (run.sessions.some((s) => s.rebuilt)) {
    console.log("  Regenerate the rebuilt sessions' summaries with `lcm compact`, or threaded with `lcm import --provider claude --replay`.");
  }
}

/** Codex and OMP rebuild mode updates only verified historical NUL-cut message rows. */
export function printCutRepairSummary(
  run: import("./import.js").CutRepairRunResult,
  opts: { apply: boolean; provider: "codex" | "omp" },
): void {
  let cutRows = 0;
  let repaired = 0;
  for (const report of run.sessions) {
    cutRows += report.plan.rows.length;
    repaired += report.repaired ?? 0;
    const detail = report.plan.kind === "repairable" ? ` — ${report.plan.rows.length} cut rows` : "";
    console.log(`  ${report.plan.kind.padEnd(11)} ${report.plan.sessionId}${detail}${report.plan.reason ? ` (${report.plan.reason})` : ""}${report.error ? `; failed: ${report.error}` : ""}  [${report.cwd}]`);
    if (report.backupPath) console.log(`  Backup: ${report.backupPath}`);
  }
  for (const { cwd, error } of run.failedProjects) console.log(`  Not repaired in ${cwd}: ${error}`);
  console.log(`  ${run.sessions.length} ${opts.provider} sessions checked; ${cutRows} cut rows found; ${repaired} repaired.`);
  if (!opts.apply) console.log(cutRows ? "  No changes written; rerun with --yes to repair." : "  Nothing to repair. No changes written.");
}
