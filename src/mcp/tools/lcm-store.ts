export const lcmStoreTool = {
  name: "lcm_store",
  description: "Store a memory into lossless-claude's semantic layer. Use to persist decisions, findings, reasoning outcomes, or any knowledge worth retrieving in future sessions. Stored memories are searchable via lcm_search.",
  inputSchema: {
    type: "object" as const,
    properties: {
      text: { type: "string", description: "The content to store" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Categorical tags (e.g. ['decision', 'architecture', 'bug-fix'])",
      },
      metadata: {
        type: "object",
        description: "Optional key/value metadata (e.g. projectId, sessionId, source)",
        additionalProperties: true,
      },
    },
    required: ["text"],
  },
};
