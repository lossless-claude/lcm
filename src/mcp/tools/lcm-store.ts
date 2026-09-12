export const lcmStoreTool = {
  name: "lcm_store",
  description: "Store a memory into the promoted layer. Use to persist decisions, findings, reasoning outcomes, or any knowledge worth retrieving in future sessions. Stored memories are searchable via lcm_search.",
  inputSchema: {
    type: "object" as const,
    properties: {
      text: { type: "string", description: "The content to store" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Canonical tags following the <prefix>:<value> schema (see docs/tag-schema.md). Use at least type: and one of project: or scope:. Examples: ['type:solution', 'scope:lcm', 'project:lcm', 'source:session']. Prefixes: type, scope, project, source, priority.",
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
