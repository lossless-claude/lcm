/**
 * Summary renderer — prints the final summary after all sessions are processed.
 * Replaces import-summary.ts for commands that use the ninja renderer.
 */

import type { ProgressState } from './progress-state.js';
import type { RenderOpts } from './render-frame.js';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `~${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtRatio(before: number, after: number): string {
  return (before / after).toFixed(1) + '×';
}

function renderBar(barWidth: number): string {
  return '[' + '█'.repeat(barWidth) + ']';
}

/** Print the compact (non-verbose) summary table to stdout. */
export function printSummary(state: ProgressState, opts: RenderOpts): void {
  const elapsed = (Date.now() - state.startedAt) / 1_000;
  const total = state.completed + state.errors.length;
  const width = Math.max(opts.width, 40);

  // Phase bar (only if there are phases)
  if (state.phases.length > 0) {
    const phaseBar = state.phases
      .map(p => `● ${p.name}`)
      .join('  →  ');
    const doneLabel = state.aborted ? 'Aborted' : 'Done ✓';
    process.stdout.write(`\n  ${phaseBar}          ${doneLabel}\n`);
  }

  // Progress bar
  const barWidth = width < 60 ? 20 : 22;
  const pct = total > 0 ? Math.round((state.completed / total) * 100) : 100;
  let tokenFlowStr = '';
  if (state.tokensIn > 0) {
    if (state.tokensOut > 0 && state.tokensOut < state.tokensIn) {
      const ratio = fmtRatio(state.tokensIn, state.tokensOut);
      tokenFlowStr = `  ${fmtTokens(state.tokensIn)} → ${fmtTokens(state.tokensOut)} tokens, ${ratio}`;
    } else {
      tokenFlowStr = `  ${fmtTokens(state.tokensIn)} tokens`;
    }
  }
  const msgs = state.messagesIn > 0 ? `  ${state.messagesIn.toLocaleString()} msgs` : '';
  process.stdout.write(`\n  ${renderBar(barWidth)} ${pct}%${msgs}${tokenFlowStr}\n`);

  // Metrics table
  const border = '─'.repeat(49);
  process.stdout.write(`\n  ${border}\n`);

  const rows: [string, string][] = [];

  rows.push(['Sessions', `${total} processed`]);

  if (state.tokensIn > 0 && state.tokensOut > 0 && state.tokensOut < state.tokensIn) {
    rows.push(['Compression', fmtRatio(state.tokensIn, state.tokensOut)]);
  }

  if (state.dag) {
    rows.push(['DAG nodes', `${state.dag.nodes}  (+${state.dag.newNodes} new)`]);
    rows.push(['DAG depth', String(state.dag.depth)]);
    if (state.dag.memoriesPromoted > 0) {
      rows.push(['Memories', `${state.dag.memoriesPromoted} promoted`]);
    }
  }

  rows.push(['Total time', `${elapsed.toFixed(1)}s`]);

  if (state.errors.length > 0) {
    rows.push(['Failed', String(state.errors.length)]);
  }

  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  for (const [label, value] of rows) {
    process.stdout.write(`  ${label.padEnd(labelWidth)}  ${value}\n`);
  }

  process.stdout.write(`  ${border}\n`);

  // Error list
  if (state.errors.length > 0) {
    process.stdout.write('\n  Failed:\n');
    for (const { sessionId, message } of state.errors) {
      process.stdout.write(`    ${sessionId}: ${message}\n`);
    }
  }

  process.stdout.write('\n');
}
