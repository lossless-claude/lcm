import type { PivotLanguages } from "../../search/pivot-language.js";
import { pivotQueryApplies } from "../../search/pivot-language.js";

const BASE_DESCRIPTION =
  "Search native project memory across episodic messages/summaries and promoted memories. Returns separate ranked layer lists. Episodic matches include bounded source context, exact spans and source hashes.";

const PIVOT_QUERY_DESCRIPTION =
  "Your own translation of `query` into the project's pivot language. Supply it when the author's language differs from the pivot language (both are named in this tool's description and in every search response); the daemon adds its terms to the original query's rather than replacing them. Omit it when the two languages are the same.";

/**
 * The tool as a caller sees it for one project: the base description plus, when
 * the author writes in a language other than the pivot, the two language names
 * and the instruction to translate. Nothing is added when they match, so a
 * single-language project sees the description it has always seen.
 */
export function lcmSearchToolFor(languages: PivotLanguages) {
  const description = pivotQueryApplies(languages)
    ? `${BASE_DESCRIPTION} This project's author language is ${languages.authorLanguage} and its search pivot language is ${languages.pivotLanguage} (the language to translate a query into, not a language detected in the corpus): pass \`pivotQuery\` with your query translated to ${languages.pivotLanguage}.`
    : BASE_DESCRIPTION;
  return { ...lcmSearchTool, description };
}

export const lcmSearchTool = {
  name: "lcm_search",
  description: BASE_DESCRIPTION,
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Natural language search query" },
      pivotQuery: { type: "string", description: PIVOT_QUERY_DESCRIPTION },
      limit: { type: "number", description: "Max results per layer (default: 5)" },
      layers: { type: "array", items: { type: "string", enum: ["episodic", "promoted"] }, description: "Which memory layers to search (default: both)" },
      tags: { type: "array", items: { type: "string" }, description: "Filter results to entries that include all specified tags (e.g. ['reasoning'], ['decision', 'architecture'])" },
    },
    required: ["query"],
  },
};
