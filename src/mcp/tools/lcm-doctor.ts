export const lcmDoctorTool = {
  name: "lcm_doctor",
  description: "Run diagnostics on the lossless-claude installation. Checks daemon, hooks, MCP config, and summarizer health.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};
