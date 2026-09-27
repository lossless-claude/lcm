// src/guidance.ts
//
// The guidance: the text that teaches an agent when to search memory and what to store.
// Every surface that carries it renders it here, so the rule is stated once:
//
//   LCM_MD_CONTENT        ~/.claude/lcm.md, included from CLAUDE.md (MCP tool names)
//   LEARNING_INSTRUCTION  the UserPromptSubmit instruction (MCP tool names)
//   RULES_CLI, RULES_MCP  connector rules files, one per naming of the tools
//   SKILL                 the connector skill (CLI names)
//   STORE_TOOL_*          the lcm_store MCP definition
//
// The learning instruction is store-only: it rides beside the <memory-context> block the
// same hook surfaces, so it never repeats when to search. lcm.md leaves out the reserved
// tags because every Claude Code prompt already carries the learning instruction.
//
// hooks/lcm-hooks.ts keeps a verbatim copy of LEARNING_INSTRUCTION (the module cannot import
// from src/), so that text holds no backticks and no `${`; test/hooks/learning-instruction.test.ts
// fails when the copy drifts. docs/tag-schema.md must list every type and prefix named here.

/** The `type:` values an agent is asked to store, each with when it applies. */
export const STORE_TYPES: ReadonlyArray<{ value: string; when: string }> = [
  { value: "decision", when: "an architectural or design choice, with the trade-off that settled it" },
  { value: "preference", when: "how the user wants things done" },
  { value: "root-cause", when: "a bug cause that took effort to uncover" },
  { value: "pattern", when: "a codebase convention documented nowhere else" },
  { value: "gotcha", when: "a non-obvious pitfall" },
  { value: "solution", when: "a non-trivial fix worth remembering" },
  { value: "workflow", when: "a multi-step process that works" },
];

/** The prefixes a store's tags are drawn from. */
export const TAG_PREFIXES = ["type", "scope", "project", "source", "priority"] as const;

const TAGS_RULE =
  "Tag each store with type: plus one of project: or scope:; add source: when the origin matters for trust, and priority: rarely.";

const SEARCH_TRIGGER =
  "Search memory before a code task in this project, and before asking the user about anything a past session may have settled.";

const SKIP_RULE =
  "Skip both for general programming concepts, meta tasks (run tests, build, commit, open a PR), and clarifications about a previous response.";

type Nouns = { search: string; grep: string; describe: string; expand: string; store: string };

const MCP: Nouns = { search: "lcm_search", grep: "lcm_grep", describe: "lcm_describe", expand: "lcm_expand", store: "lcm_store" };
const CLI: Nouns = { search: "lcm search", grep: "lcm grep", describe: "lcm describe", expand: "lcm expand", store: "lcm store" };

function storeRule(n: Nouns): string {
  return `Store durable insights explicitly with \`${n.store}\`, tagged with \`type:\`: one concise insight and its why per store.`;
}

function recallSteps(n: Nouns): string[] {
  return [
    `\`${n.search}\`: broad recall across sessions ("how was X implemented", "the decision about Y")`,
    `\`${n.grep}\`: when you hold an exact keyword, error message or function name`,
    `\`${n.describe}\`: check a node's metadata before expanding it`,
    `\`${n.expand}\`: recover the detail a summary compressed away`,
  ];
}

function typeTable(): string {
  return ["| Tag | Store when |", "|-----|------------|",
    ...STORE_TYPES.map((t) => `| \`type:${t.value}\` | ${t.when} |`)].join("\n");
}

// The reserved tags: reporting that a surfaced memory was acted on, and voting on one.
const USED = { text: "Acted on memory <id> — <one-line how>", tags: ["signal:memory_used", "memory_id:<id>"] };
const CONFIRMED = { text: "<what confirmed it, e.g. a file, test, or command output>", tags: ["signal:memory_vote", "vote:+1", "memory_id:<id>"] };
const CONTRADICTED = { text: "<what contradicts it>", tags: ["signal:memory_vote", "vote:-1", "memory_id:<id>"] };
const ACTED_ON = "When you act on a surfaced memory (use it to inform a decision, avoid a known pitfall, or reference it in your work), emit:";
const VOTE = "When you check a surfaced memory against current evidence, vote on it (reason is required both ways):";
const NOT_A_DOWNVOTE = "\"Not relevant here\" is not a -1 — only a real contradiction is.";

function call(n: Nouns, store: { text: string; tags: string[] }): string {
  return n === MCP
    ? `${n.store}(text: "${store.text}", tags: [${store.tags.map((t) => `"${t}"`).join(", ")}])`
    : `${n.store} "${store.text}" ${store.tags.map((t) => `--tag ${t}`).join(" ")}`;
}

function reservedTags(n: Nouns): string {
  return [ACTED_ON, `- \`${call(n, USED)}\``, "", VOTE,
    `- \`${call(n, CONFIRMED)}\``, `- \`${call(n, CONTRADICTED)}\``, "", NOT_A_DOWNVOTE].join("\n");
}

function rules(n: Nouns, intro: string, tools: string): string {
  return `# Workflow Instruction

${intro}

${guidanceBody(n)}

${tools}`;
}

function guidanceBody(n: Nouns): string {
  return `## Core Rules

- ${SEARCH_TRIGGER}
- ${storeRule(n)}
- ${SKIP_RULE}

## Recall

${recallSteps(n).map((s) => `- ${s}`).join("\n")}

## When to Store

${typeTable()}

${TAGS_RULE}

${reservedTags(n)}`;
}

export const LCM_MD_CONTENT = `# lcm memory

Hooks capture sessions automatically.

## When to search

${SEARCH_TRIGGER}

## Recall

${recallSteps(MCP).map((s) => `- ${s}`).join("\n")}

## Storage

${storeRule(MCP)} Worth storing: ${STORE_TYPES.map((t) => t.value).join(", ")}. ${TAGS_RULE}
`;

export const LEARNING_INSTRUCTION = `<learning-instruction>
When you recognize a durable insight, call lcm_store immediately:
${STORE_TYPES.map((t) => `- ${t.value}: ${t.when}`).join("\n")}

${TAGS_RULE}
Usage: ${call(MCP, { text: "concise insight with why", tags: ["type:decision", "project:<repo>"] })}

${ACTED_ON}
${call(MCP, USED)}

${VOTE}
${call(MCP, CONFIRMED)}
${call(MCP, CONTRADICTED)}
${NOT_A_DOWNVOTE}
</learning-instruction>`;

export const RULES_CLI = rules(CLI, "You are a coding agent. Use the lcm CLI to manage persistent memory across sessions.", `## Available Commands

- \`lcm search "query"\`: search episodic and promoted memory for the current project
- \`lcm grep "pattern" --mode regex\`: regex search across messages and summaries
- \`lcm describe <nodeId>\`: inspect metadata for a specific memory node
- \`lcm expand <nodeId> --depth N\`: expand a summary node into lower-level detail
- \`lcm store "content" --tag type:<kind> --tag scope:<domain>\`: persist a durable insight to promoted memory
- \`lcm stats\`: show compression ratios and token savings
- \`lcm doctor\`: run diagnostics
- \`lcm diagnose\`: scan recent Claude Code transcripts for hook and MCP issues
- \`lcm import\`: import Claude Code, Codex and OMP session transcripts into memory
- \`lcm import --all\`: import from all projects
- \`lcm compact --all\`: summarize all uncompacted sessions

Run \`lcm --help\` for all options.`);

export const RULES_MCP = rules(MCP, "You are a coding agent integrated with lcm via MCP (Model Context Protocol).", `## Tools

- \`lcm_search\`: full-text search across memory
- \`lcm_grep\`: regex search across conversations
- \`lcm_describe\`: show memory metadata
- \`lcm_expand\`: expand a summary node
- \`lcm_store\`: persist a durable insight to promoted memory
- \`lcm_stats\`: show compression ratios and token savings
- \`lcm_doctor\`: run diagnostics`);

/** The connector skill (`lcm-memory/SKILL.md`). Model-invoked, so its description lists only triggers. */
export const SKILL = `---
name: lcm-memory
description: Search and store lcm memory with the lcm CLI. Use before a code task in this project, before asking the user about something a past session may have settled, and when a durable insight (${STORE_TYPES.map((t) => t.value).join(", ")}) surfaces.
---

# lcm memory

${guidanceBody(CLI)}

## Examples

- \`lcm search "How is authentication implemented?"\`
- \`lcm grep "createDaemon|startMcpServer" --mode regex\`
- \`lcm describe sum_abc123def456\`
- \`lcm expand sum_abc123def456 --depth 2\`
- \`lcm store "Auth uses JWT with 24h expiry instead of server sessions: the API stays stateless across instances. See src/middleware/auth.ts" --tag type:decision --tag scope:security\`

## When a command fails

- \`lcm\` not found: \`npm install -g @lossless-claude/lcm\`
- daemon down: \`lcm daemon start --detach\`
- search returns nothing: memory may be empty; proceed normally
- anything else: \`lcm doctor\`
`;

export const STORE_TOOL_DESCRIPTION =
  `Store a durable insight in promoted memory: one concise insight and its why. Worth storing: ${STORE_TYPES.map((t) => t.value).join(", ")}. Stored memories are searchable via lcm_search.`;

export const STORE_TOOL_TAGS_DESCRIPTION =
  `Canonical tags following the <prefix>:<value> schema (see docs/tag-schema.md). ${TAGS_RULE} Examples: ['type:solution', 'scope:lcm', 'project:lcm', 'source:session']. Reserved, not categories: signal:memory_used with memory_id:<id> reports acting on a surfaced memory; signal:memory_vote with memory_id:<id> and one of vote:+1 / vote:-1 votes on it, with the reason as text.`;
