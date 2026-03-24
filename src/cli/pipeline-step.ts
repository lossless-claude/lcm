/**
 * PipelineStep interface + PipelineSession type.
 * Defines the contract for commands integrated with the ninja renderer.
 */

import type { ProgressState } from './progress-state.js';

export interface PipelineSession {
  sessionId: string;
  path: string;
  messages?: number;   // known upfront for compact, discovered for import
  tokens?: number;     // estimated from content length
}

export type ProgressUpdate = (patch: Partial<ProgressState>) => void;

export interface PipelineStep {
  name: string;
  count(opts: Record<string, unknown>): Promise<number>;
  run(
    session: PipelineSession,
    update: ProgressUpdate,
  ): Promise<{ success: boolean; error?: string }>;
}
