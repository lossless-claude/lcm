import type { ProjectedMatch } from './qmd-projection.js';

export type QmdMode = 'lexical' | 'hybrid';
export type QmdIndexRequest = { cwd: string; embed?: boolean; timeoutMs?: number };
export type QmdSearchRequest = {
  cwd: string; query: string; limit?: number; mode?: QmdMode;
  layers?: string[]; tags?: string[];
};
export type QmdCapabilities = { lexical: true; embeddingReady: boolean; needsEmbedding: number };
export type QmdIndexResult = {
  engine: 'qmd'; projectionRevision: string; documents: number; written: number; removed: number; unchanged: number;
  embedded: boolean; capabilities: QmdCapabilities;
};
export type QmdSearchResult = {
  engine: 'qmd'; projectionRevision: string; strategy: QmdMode; matches: ProjectedMatch[];
  staleCount: number; candidateCount: number; candidateLimit: number;
  candidateCapReached: boolean; partial: boolean;
  capabilities: QmdCapabilities;
};
export type QmdTask = { id: number } & (
  { operation: 'index'; request: QmdIndexRequest } |
  { operation: 'search'; request: QmdSearchRequest }
);
export type QmdReply = { id: number } & (
  { ok: true; result: QmdIndexResult | QmdSearchResult } |
  { ok: false; error: string }
);
