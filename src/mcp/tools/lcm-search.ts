export const lcmSearchTool = {
  name: "lcm_search",
  description: "Search episodic and promoted project memory. Native search returns separate layer lists. With backend=qmd, use an explicitly prepared index and receive one ranked matches list with source references; QMD failure returns an explicit native fallback. Run lcm index first, or lcm index --embed before hybrid mode.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Natural language search query" },
      limit: { type: "number", description: "Max results (native: per layer; QMD: total, 1–100; default: 5)" },
      layers: { type: "array", items: { type: "string", enum: ["episodic", "promoted"] }, description: "Which memory layers to search (default: both)" },
      tags: { type: "array", items: { type: "string" }, description: "Filter results to entries that include all specified tags (e.g. ['reasoning'], ['decision', 'architecture'])" },
      backend: { type: "string", enum: ["native", "qmd"], description: "Search backend (default: native)" },
      mode: { type: "string", enum: ["lexical", "hybrid"], description: "QMD mode (default: lexical, no models). Hybrid may download and run local models." },
    },
    required: ["query"],
  },
};
