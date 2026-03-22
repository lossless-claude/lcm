export type SummarizeContext = {
  isCondensed?: boolean;
  targetTokens?: number;
  depth?: number;
};

export type LcmSummarizeFn = (
  text: string,
  aggressive?: boolean,
  ctx?: SummarizeContext,
) => Promise<string>;
