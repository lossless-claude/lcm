export const lcmStatsTool = {
  name: "lcm_stats",
  description: "Show token savings, compression ratios, transcript scan counts, and usage statistics across all lossless-claude projects. Use to check how much context is being saved and whether subagent transcripts are still being identified.",
  inputSchema: {
    type: "object" as const,
    properties: {
      verbose: { type: "boolean", description: "Include per-conversation breakdown", default: false },
    },
  },
};
