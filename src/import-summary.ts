import type { ImportResult } from "./import.js";
import { formatNumber } from "./stats.js";

export function printImportSummary(
  result: ImportResult,
  opts: { replay?: boolean } = {},
): void {
  const sessionsProcessed = result.imported + result.skippedEmpty + result.failed;
  console.log(`  ${result.imported} sessions imported (${result.totalMessages} messages)`);
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

    if (opts.replay && result.tokensAfter > 0) {
      const ratio = result.totalTokens > 0 && result.tokensAfter > 0
        ? (result.totalTokens / result.tokensAfter).toFixed(1)
        : "\u2013";
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
}
