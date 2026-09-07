export const lcmSearchTool = {
  name: "lcm_search",
  description: "Search native project memory across episodic messages/summaries and promoted memories. Returns separate ranked layer lists. Episodic matches include bounded source context, exact spans and source hashes.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Natural language search query" },
      limit: { type: "number", description: "Max results per layer (default: 5)" },
      layers: { type: "array", items: { type: "string", enum: ["episodic", "promoted"] }, description: "Which memory layers to search (default: both)" },
      tags: { type: "array", items: { type: "string" }, description: "Filter results to entries that include all specified tags (e.g. ['reasoning'], ['decision', 'architecture'])" },
    },
    required: ["query"],
  },
};
