export type SummarizeContext = {
  isCondensed?: boolean;
  targetTokens?: number;
  depth?: number;
  onUsage?: (usage: SummarizerUsage) => void;
};

export type SummarizerUsage = {
  provider: "codex-process";
  model?: string;
  tokensUsed: number;
};

export type LcmSummarizeFn = (
  text: string,
  aggressive?: boolean,
  ctx?: SummarizeContext,
) => Promise<string>;
