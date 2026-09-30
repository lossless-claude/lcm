import type { Tool } from "@modelcontextprotocol/server";
import type { PivotLanguages } from "../search/pivot-language.js";
import { pivotQueryApplies } from "../search/pivot-language.js";
import { STORE_TOOL_DESCRIPTION, STORE_TOOL_TAGS_DESCRIPTION } from "../guidance.js";

type LocalHandler = (args: Record<string, unknown>) => Promise<string>;
export type LocalHandlers = { stats: LocalHandler; doctor: LocalHandler };

type Destination =
  | { kind: "daemon"; route: string }
  | { kind: "local"; handler: keyof LocalHandlers }
  | { kind: "worker"; action: "claim" | "submit" };

type ToolEntry = { definition: Tool; destination: Destination };

type ResolvedTool = {
  destination: { kind: "daemon"; route: string } | { kind: "local"; handler: LocalHandler } | { kind: "worker"; action: "claim" | "submit" };
  args: Record<string, unknown>;
};

type ToolCatalog = {
  list(languages: PivotLanguages): Tool[];
  resolve(name: string, rawArgs: Record<string, unknown>): ResolvedTool | undefined;
};

const SEARCH_DESCRIPTION =
  "Search native project memory across episodic messages/summaries and promoted memories. Returns separate ranked layer lists. Episodic matches include bounded source context, exact spans and source hashes.";

const PIVOT_QUERY_DESCRIPTION =
  "Your own translation of `query` into the project's pivot language. Supply it when the author's language differs from the pivot language (both are named in this tool's description and in every search response); the daemon adds its terms to the original query rather than replacing it. Omit it when the two languages are the same.";

const PROJECT_ID_DESCRIPTION =
  "The `project.id` of the search result the node came from. Required whenever the node did not come from this project, since node ids are only unique within one project.";

const ENTRIES: ToolEntry[] = [
  {
    definition: {
      name: "lcm_summarize_claim",
      description: "Claim one pool job in a dedicated declared worker. Claude Code stdio MCP only; identity is read from the harness environment. The session and its subagents are permanently excluded from lcm; the harness transcript stays on disk. Use a dedicated session.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    destination: { kind: "worker", action: "claim" },
  },
  {
    definition: {
      name: "lcm_summarize_submit",
      description: "Submit a summary or completion error for a claimed pool job. Must use the returned workerId and the same enrolled session. Optional usage defaults to estimated.",
      inputSchema: { type: "object", additionalProperties: false,
        properties: {
          jobId: { type: "string", description: "Claimed job id" },
          workerId: { type: "string", description: "worker_id returned by the claim" },
          model: { type: "string", description: "Model that produced the answer; validated as session-pool:<model>" },
          text: { type: "string", description: "Summary text; provide text or error" },
          error: { type: "string", description: "Completion error; provide error or text" },
          usage: { type: "object", properties: {
            input_tokens: { type: "integer", minimum: 0 }, output_tokens: { type: "integer", minimum: 0 }, estimated: { type: "boolean" },
          }, required: ["input_tokens", "output_tokens", "estimated"], additionalProperties: false },
        }, required: ["jobId", "workerId", "model"],
      },
    },
    destination: { kind: "worker", action: "submit" },
  },
  {
    definition: {
      name: "lcm_grep",
      description: "Search conversation history by keyword or regex across raw messages and summaries. Use when recalling what was said, decided, or done in a past session.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Keyword, phrase, or regex to search" },
          scope: { type: "string", enum: ["messages", "summaries", "all"], default: "all" },
          sessionId: { type: "string", description: "Filter to a specific session" },
          since: { type: "string", description: "ISO datetime lower bound" },
        },
        required: ["query"],
      },
    },
    destination: { kind: "daemon", route: "/grep" },
  },
  {
    definition: {
      name: "lcm_expand",
      description: "Decompress a summary node into its full source content by traversing the DAG. Use when a summary references something that needs more detail.",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: { type: "string", description: "Summary node ID to expand" },
          depth: { type: "number", description: "How many levels of the DAG to traverse (default: 1)" },
          projectId: { type: "string", description: PROJECT_ID_DESCRIPTION },
        },
        required: ["nodeId"],
      },
    },
    destination: { kind: "daemon", route: "/expand" },
  },
  {
    definition: {
      name: "lcm_describe",
      description: "Inspect metadata and lineage of a memory node without expanding content. Returns depth, token count, parent/child links, and whether it was promoted to long-term memory.",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: { type: "string", description: "Node ID to describe" },
          projectId: { type: "string", description: PROJECT_ID_DESCRIPTION },
        },
        required: ["nodeId"],
      },
    },
    destination: { kind: "daemon", route: "/describe" },
  },
  {
    definition: {
      name: "lcm_search",
      description: SEARCH_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          pivotQuery: { type: "string", description: PIVOT_QUERY_DESCRIPTION },
          limit: { type: "number", description: "Max results per layer (default: 5)" },
          layers: { type: "array", items: { type: "string", enum: ["episodic", "promoted"] }, description: "Which memory layers to search (default: both)" },
          tags: { type: "array", items: { type: "string" }, description: "Filter results to entries that include all specified tags (e.g. ['reasoning'], ['decision', 'architecture'])" },
        },
        required: ["query"],
      },
    },
    destination: { kind: "daemon", route: "/search" },
  },
  {
    definition: {
      name: "lcm_store",
      description: STORE_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The content to store" },
          tags: {
            type: "array",
            items: { type: "string" },
            description: STORE_TOOL_TAGS_DESCRIPTION,
          },
          metadata: {
            type: "object",
            description: "Optional key/value metadata (e.g. projectId, sessionId, source)",
            additionalProperties: true,
          },
        },
        required: ["text"],
      },
    },
    destination: { kind: "daemon", route: "/store" },
  },
  {
    definition: {
      name: "lcm_stats",
      description: "Show token savings, compression ratios, and usage statistics across all lossless-claude projects. Use to check how much context is being saved.",
      inputSchema: {
        type: "object",
        properties: {
          verbose: { type: "boolean", description: "Include per-conversation breakdown", default: false },
        },
      },
    },
    destination: { kind: "local", handler: "stats" },
  },
  {
    definition: {
      name: "lcm_doctor",
      description: "Run diagnostics on the lossless-claude installation. Checks daemon, hooks, MCP config, and summarizer health.",
      inputSchema: { type: "object", properties: {} },
    },
    destination: { kind: "local", handler: "doctor" },
  },
];

export function getMcpToolDefinitions(): Tool[] {
  return ENTRIES.map(({ definition }) => definition);
}

export function createToolCatalog(localHandlers: LocalHandlers): ToolCatalog {
  const byName = new Map<string, (typeof ENTRIES)[number]>(ENTRIES.map((entry) => [entry.definition.name, entry]));

  return {
    list(languages: PivotLanguages): Tool[] {
      return ENTRIES.map(({ definition }) => {
        if (definition.name !== "lcm_search" || !pivotQueryApplies(languages)) return definition;
        return {
          ...definition,
          description: `${SEARCH_DESCRIPTION} This project's author language is ${languages.authorLanguage} and its search pivot language is ${languages.pivotLanguage} (the language to translate a query into, not a language detected in the corpus): pass \`pivotQuery\` with your query translated to ${languages.pivotLanguage}.`,
        };
      });
    },
    resolve(name: string, rawArgs: Record<string, unknown>): ResolvedTool | undefined {
      const entry = byName.get(name);
      if (!entry) return undefined;
      const args: Record<string, unknown> = {};
      for (const key of Object.keys(entry.definition.inputSchema.properties ?? {})) {
        if (key in rawArgs) args[key] = rawArgs[key];
      }
      const destination = entry.destination.kind === "local"
        ? { kind: "local" as const, handler: localHandlers[entry.destination.handler] }
        : entry.destination;
      return { destination, args };
    },
  };
}
