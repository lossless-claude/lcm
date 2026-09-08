import type { ImportResult } from "./import.js";
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
