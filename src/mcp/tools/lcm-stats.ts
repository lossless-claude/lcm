export const lcmStatsTool = {
  name: "lcm_stats",
  description: "Show token savings, compression ratios, and usage statistics across all lossless-claude projects. Use to check how much context is being saved.",
  inputSchema: {
    type: "object" as const,
    properties: {
      verbose: { type: "boolean", description: "Include per-conversation breakdown", default: false },
    },
  },
};
