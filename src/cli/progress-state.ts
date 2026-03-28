/** State model for the ninja CLI progress renderer. */

export interface ProgressPhase {
  name: string;
  status: 'pending' | 'active' | 'done';
}

export interface ProgressError {
  sessionId: string;
  message: string;
}

export interface ProgressCurrentSession {
  sessionId: string;
  messages: number;
  tokens: number;
  startedAt: number;
}

export interface ProgressLastResult {
  sessionId: string;
  messages: number;
  tokensBefore: number;
  tokensAfter?: number;
  provider?: string;
  elapsed: number;
}

export interface ProgressDag {
  nodes: number;
  newNodes: number;
  depth: number;
  memoriesPromoted: number;
}

export interface ProgressState {
  /** Phase tracking (multi-phase pipelines like curate) */
  phases: ProgressPhase[];

  /** Multi-project tracking (--all mode) */
  currentProject?: string;

  /** Total sessions to process */
  total: number;
  /** Completed sessions (success + skip) */
  completed: number;
  /** Failed sessions — derived from errors.length to avoid drift */
  errors: ProgressError[];

  /** Running metrics */
  tokensIn: number;
  tokensOut: number;     // 0 when no compaction (no replay)
  messagesIn: number;

  /** Current session being processed */
  current?: ProgressCurrentSession;

  /** Last completed session (drives line 3 of ninja display) */
  lastResult?: ProgressLastResult;

  /** DAG metrics (updated after compact/promote phases) */
  dag?: ProgressDag;

  /** Wall-clock start time */
  startedAt: number;

  /** Flags */
  dryRun: boolean;
  aborted: boolean;
}

export function makeProgressState(opts: {
  phases?: ProgressPhase[];
  total?: number;
  dryRun?: boolean;
}): ProgressState {
  return {
    phases: opts.phases ?? [],
    total: opts.total ?? 0,
    completed: 0,
    errors: [],
    tokensIn: 0,
    tokensOut: 0,
    messagesIn: 0,
    startedAt: Date.now(),
    dryRun: opts.dryRun ?? false,
    aborted: false,
  };
}
