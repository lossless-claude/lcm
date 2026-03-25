/**
 * Pure renderFrame() function — no side effects, no IO.
 * Returns the string to write to stdout.
 */

import type { ProgressState } from './progress-state.js';

export interface RenderOpts {
  isTTY: boolean;
  width: number;
  color: boolean;
  verbose: boolean;
}

// ANSI helpers
const ESC = '\x1b';
const RESET = `${ESC}[0m`;
const RED = `${ESC}[31m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
/** Move cursor up N lines */
const cursorUp = (n: number) => `${ESC}[${n}A`;
/** Clear from cursor to end of line */
const clearLine = `${ESC}[2K`;
/** Carriage return */
const CR = '\r';

/** Format token count with K/M suffix */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `~${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Format elapsed milliseconds */
function fmtElapsed(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

/** Format compression ratio, coloured when color=true */
function fmtRatio(ratio: number, color: boolean): string {
  const text = `${ratio.toFixed(1)}×`;
  if (!color) return text;
  if (ratio >= 10) return `${GREEN}${text}${RESET}`;
  if (ratio >= 5) return `${YELLOW}${text}${RESET}`;
  return text;
}

/** Build the phase bar string, e.g. "● Import  →  ○ Compact" */
function renderPhaseBar(state: ProgressState): string {
  if (state.phases.length === 0) return '';
  return state.phases
    .map(p => `${p.status === 'pending' ? '○' : '●'} ${p.name}`)
    .join('  →  ');
}

/** Build a progress bar of a given bar width */
function renderBar(completed: number, total: number, barWidth: number): string {
  if (total === 0) return '[' + '░'.repeat(barWidth) + ']';
  const filled = Math.round((completed / total) * barWidth);
  const empty = barWidth - filled;
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}

/**
 * Render one frame.
 *
 * In TTY mode: returns 3 lines prefixed with cursor-up + clear sequences so the
 * caller can overwrite the previous frame in-place. On the very first render
 * (prevLines === 0) no cursor movement is emitted.
 *
 * In non-TTY mode (and verbose TTY): returns a single line per completed session.
 */
export function renderFrame(
  state: ProgressState,
  opts: RenderOpts,
  prevLines = 3,
): string {
  const { isTTY, color, width } = opts;

  if (!isTTY) {
    // Non-TTY: emit one line per completed session (called by caller when a session finishes)
    const last = state.lastResult;
    if (!last) return '';
    const counter = `[${state.completed}/${state.total}]`;
    const tokens =
      last.tokensAfter !== undefined && last.tokensAfter < last.tokensBefore
        ? `${fmtTokens(last.tokensBefore)} → ${fmtTokens(last.tokensAfter)}`
        : fmtTokens(last.tokensBefore);
    const provider = last.provider ? ` [${last.provider}]` : '';
    return `  ${counter} ${last.sessionId}: ${last.messages} msgs, ${tokens}${provider} ${fmtElapsed(last.elapsed)}\n`;
  }

  if (opts.verbose) {
    // Verbose TTY: sequential log lines, no overwrite
    const last = state.lastResult;
    if (!last) return '';
    const tokens =
      last.tokensAfter !== undefined && last.tokensAfter < last.tokensBefore
        ? `${fmtTokens(last.tokensBefore)} → ${fmtTokens(last.tokensAfter)}`
        : fmtTokens(last.tokensBefore);
    const provider = last.provider ? `  [${last.provider}]` : '';
    const ratio =
      last.tokensAfter !== undefined && last.tokensAfter < last.tokensBefore
        ? `  (${fmtRatio(last.tokensBefore / last.tokensAfter, color)})`
        : '';
    return `  ✓ ${last.sessionId}  ${last.messages} msgs  ${tokens}${ratio}${provider}  ${fmtElapsed(last.elapsed)}\n`;
  }

  // ── TTY non-verbose: 3-line ninja display ──────────────────────────────────

  const effectiveWidth = Math.max(width, 40);
  const now = Date.now();

  // Line 1: phase bar + progress counter + failures
  const phaseBar = renderPhaseBar(state);
  const counter = state.total > 0 ? `${state.completed}/${state.total}` : '';
  const failCount = state.errors.length;
  const failStr = failCount > 0
    ? (color ? `  ${RED}${failCount} failed${RESET}` : `  ${failCount} failed`)
    : '';
  const dryRunBadge = state.dryRun ? '  [dry-run]' : '';
  const line1Parts = [phaseBar, counter, failStr, dryRunBadge].filter(Boolean);
  const line1 = '  ' + line1Parts.join('   ');

  // Line 2: progress bar + running totals
  const barWidth = effectiveWidth < 60 ? 0 : 22;
  const pct = state.total > 0 ? Math.round((state.completed / state.total) * 100) : 0;
  const barStr = barWidth > 0 ? renderBar(state.completed, state.total, barWidth) + ' ' : '';
  const pctStr = `${pct}%`;
  const msgs = state.messagesIn > 0 ? `  ${state.messagesIn.toLocaleString()} msgs` : '';
  let tokenFlow = '';
  if (state.tokensIn > 0) {
    if (state.tokensOut > 0 && state.tokensOut < state.tokensIn) {
      const ratio = state.tokensIn / state.tokensOut;
      tokenFlow = `  (${fmtTokens(state.tokensIn)} → ${fmtTokens(state.tokensOut)} tokens, ${fmtRatio(ratio, color)})`;
    } else {
      tokenFlow = `  (${fmtTokens(state.tokensIn)} tokens)`;
    }
  }
  const line2 = `  ${barStr}${pctStr}${msgs}${tokenFlow}`;

  // Line 3: current or last session detail
  let line3 = '';
  if (state.current) {
    const elapsed = fmtElapsed(now - state.current.startedAt);
    line3 = `  ● ${state.current.sessionId}  ${state.current.messages} msgs  processing...  ${elapsed}`;
  } else if (state.lastResult) {
    const last = state.lastResult;
    const tokens =
      last.tokensAfter !== undefined && last.tokensAfter < last.tokensBefore
        ? `${fmtTokens(last.tokensBefore)} → ${fmtTokens(last.tokensAfter)}`
        : fmtTokens(last.tokensBefore);
    const provider = last.provider ? `  [${last.provider}]` : '';
    line3 = `  ● ${last.sessionId}  ${last.messages} msgs  ${tokens}${provider}  ${fmtElapsed(last.elapsed)}`;
  } else {
    line3 = '  …';
  }

  // Overwrite the previous frame: cursor up N lines then clear+rewrite each line
  const overwrite = prevLines > 0
    ? cursorUp(prevLines) + [line1, line2, line3].map(l => CR + clearLine + l).join('\n')
    : [line1, line2, line3].join('\n');

  return overwrite + '\n';
}

/**
 * The number of lines renderFrame emits in TTY non-verbose mode.
 * The caller tracks this as `prevLines` for the next call.
 */
export const FRAME_LINES = 3;
