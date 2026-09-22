// src/hooks/extractors.ts

export interface ExtractedEvent {
  type: string;
  category: string;
  data: string;
  priority: number;
  tags?: string[];
}

/**
 * Every tool name this module has a shape for — the vocabulary a harness adapter
 * translates onto. `mcp__`-prefixed names are handled by prefix and are not listed.
 *
 * A harness may only target a name in this list, and each name must keep producing at
 * least one event: test/hooks/extractors.test.ts fixes a payload per name and fails when
 * one goes quiet, so a name cannot be added here without a case behind it.
 */
export const EXTRACTOR_TOOL_NAMES = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "TaskCreate",
  "TaskUpdate",
  "Agent",
  "Skill",
  "GitHub",
  "SecurityScan",
  "ContextNote",
  "ContextChange",
] as const;

export type CanonicalToolName = (typeof EXTRACTOR_TOOL_NAMES)[number];

export interface PostToolInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
  tool_output?: { isError?: boolean };
  /** "PostToolUse" (success) or "PostToolUseFailure" (tool threw / MCP error result). */
  hook_event_name?: string;
  /** PostToolUseFailure only: error text; for Bash the first line is "Exit code N". */
  error?: string;
  /** PostToolUseFailure only: true when the failure was an abort, not a tool error. */
  is_interrupt?: boolean;
}

/** PostToolUse never fires for failed tools; failures arrive via PostToolUseFailure. */
function isToolFailure(input: PostToolInput): boolean {
  if (input.hook_event_name === "PostToolUseFailure") return input.is_interrupt !== true;
  return input.tool_output?.isError === true;
}

function errorHeadline(input: PostToolInput): string {
  // stdin is untrusted: a non-string `error` must not become "[object Object]".
  return (typeof input.error === "string" ? input.error : "").split("\n")[0].trim();
}

const SENSITIVE_PATHS = [".env", ".ssh/", "credentials", "secrets/", ".npmrc", ".netrc"];
const DATA_SOFT_CAP = 2000;

const NEGATIVE_PATTERNS = [
  "don't worry", "dont worry",
  "never mind", "nevermind",
  "not sure", "no idea",
  "doesn't matter", "doesnt matter", "does not matter",
  "forget about", "forget it",
  "no preference", "whatever you think",
  "up to you",
];

const ENV_COMMANDS = ["npm install", "npm i ", "yarn add", "pip install", "pip3 install",
  "nvm use", "volta install", "pnpm add", "uv pip install", "brew install"];

const GIT_COMMANDS = ["git commit", "git merge", "git rebase", "git checkout", "git switch",
  "git branch", "git push", "git pull", "git stash", "git reset", "git cherry-pick"];

/** GitHub operations that change something; the reads and searches return no event. */
const GITHUB_WRITE_OPS = ["pr_create", "pr_push", "pr_checkout", "run_watch"];

/** Actions that start a scan; polling, cancelling and validating it return no event. */
const SCAN_START_ACTIONS = ["start", "cloud_start"];

/** Context lifecycle kinds a harness may report. */
const CONTEXT_CHANGE_KINDS = ["checkpoint", "rewind", "reset"];

function truncate(s: string): string {
  return s.length > DATA_SOFT_CAP ? s.slice(0, DATA_SOFT_CAP) + "..." : s;
}

function isSensitivePath(path: string): boolean {
  const lower = path.toLowerCase();
  return SENSITIVE_PATHS.some(p => lower.includes(p));
}

function classifyFile(path: string): string {
  if (/\.(test|spec)\.[tj]sx?$/.test(path) || path.includes("__tests__")) return "test";
  if (/\.(json|ya?ml|toml|ini|env)$/.test(path) || path.includes("config")) return "config";
  if (/\.(md|txt|rst)$/.test(path) || path.includes("docs/")) return "docs";
  return "source";
}

function extractBashEvents(input: PostToolInput): ExtractedEvent[] {
  const command = String(input.tool_input.command ?? "");
  // Error detection (priority 1)
  if (isToolFailure(input)) {
    const prefix = command.split(/\s+/).slice(0, 3).join(" ");
    return [{ type: "error_tool", category: "error", data: truncate(`Bash error: ${prefix}`), priority: 1 }];
  }

  // Git operations (priority 2)
  const gitMatch = GIT_COMMANDS.find(gc => command.startsWith(gc));
  if (gitMatch) {
    const commitMsgMatch = command.match(/-m\s+["']([^"']+)["']/);
    const data = commitMsgMatch
      ? `${gitMatch}: ${commitMsgMatch[1]}`
      : gitMatch;
    return [{ type: `git_${gitMatch.split(" ")[1]}`, category: "git", data: truncate(data), priority: 2 }];
  }

  // Env commands (priority 2)
  const envMatch = ENV_COMMANDS.find(ec => command.startsWith(ec));
  if (envMatch) {
    return [{ type: "env_install", category: "env", data: truncate(command), priority: 2 }];
  }

  return [];
}

function extractFileEvents(toolName: string, input: PostToolInput): ExtractedEvent[] {
  const filePaths = Array.isArray(input.tool_input.file_paths)
    ? input.tool_input.file_paths.filter((path): path is string => typeof path === "string" && path.trim() !== "")
    : [String(input.tool_input.file_path ?? input.tool_input.path ?? input.tool_input.pattern ?? "")];

  const typeMap: Record<string, string> = {
    Read: "file_read", Edit: "file_edit", Write: "file_write",
    Glob: "file_glob", Grep: "file_grep",
  };

  return filePaths.filter(path => path.trim() !== "" && !isSensitivePath(path)).map(filePath => ({
    type: typeMap[toolName] ?? "file_access",
    category: "file",
    data: truncate(`${filePath} (${classifyFile(filePath)})`),
    priority: 3,
  }));
}

export function extractPostToolEvents(input: PostToolInput): ExtractedEvent[] {
  const { tool_name } = input;

  // Skip lcm_store to prevent feedback loops
  if (tool_name.includes("lcm_store") || tool_name.includes("lcm__lcm_store")) return [];

  // Failed tool (PostToolUseFailure) — error beats the success-shaped extractors below
  if (input.hook_event_name === "PostToolUseFailure") {
    if (!isToolFailure(input)) return []; // interrupted, not an error
    // The success path screens sensitive paths; the failure path must too.
    const failedPath = String(input.tool_input.file_path ?? input.tool_input.path ?? "");
    if (failedPath && isSensitivePath(failedPath)) return [];
    const rawHeadline = errorHeadline(input);
    const headline = isSensitivePath(rawHeadline) ? "" : rawHeadline;
    const commandPrefix = String(input.tool_input.command ?? "").split(/\s+/).slice(0, 3).join(" ");
    const subject = tool_name === "Bash"
      ? `Bash error${isSensitivePath(commandPrefix) ? "" : `: ${commandPrefix}`}`
      : `${tool_name} error`;
    return [{ type: "error_tool", category: "error", data: truncate(headline ? `${subject} — ${headline}` : subject), priority: 1 }];
  }

  // AskUserQuestion — extract Q+A pair (priority 1)
  if (tool_name === "AskUserQuestion") {
    const question = String(input.tool_input.question ?? "");
    const answer = String(input.tool_response ?? "");
    return [{
      type: "decision",
      category: "decision",
      data: truncate(`Q: ${question}\nA: ${answer}`),
      priority: 1,
    }];
  }

  // Plan mode (priority 1)
  if (tool_name === "EnterPlanMode") {
    return [{ type: "plan_enter", category: "plan", data: "Entered plan mode", priority: 1 }];
  }
  if (tool_name === "ExitPlanMode") {
    const response = String(input.tool_response ?? "");
    const status = /approve/i.test(response) ? "approved" : /reject/i.test(response) ? "rejected" : "exited";
    return [{ type: "plan_exit", category: "plan", data: `Plan ${status}`, priority: 1 }];
  }

  // Bash — multiple categories
  if (tool_name === "Bash") {
    return extractBashEvents(input);
  }

  // File operations (priority 3)
  if (["Read", "Edit", "Write", "Glob", "Grep"].includes(tool_name)) {
    return extractFileEvents(tool_name, input);
  }

  // Task operations (priority 2)
  if (tool_name === "TaskCreate" || tool_name === "TaskUpdate") {
    const subject = String(input.tool_input.subject ?? input.tool_input.taskId ?? "");
    const status = String(input.tool_input.status ?? "created");
    return [{
      type: `task_${tool_name === "TaskCreate" ? "create" : "update"}`,
      category: "task",
      data: truncate(`${subject} → ${status}`),
      priority: 2,
    }];
  }

  // Agent/subagent (priority 3)
  if (tool_name === "Agent") {
    const desc = String(input.tool_input.description ?? "");
    return [{ type: "subagent_dispatch", category: "subagent", data: truncate(desc), priority: 3 }];
  }

  // Skill (priority 3)
  if (tool_name === "Skill") {
    const skill = String(input.tool_input.skill ?? "");
    return [{ type: "skill_use", category: "skill", data: skill, priority: 3 }];
  }

  // MCP tools (priority 3) — tool name only, no args
  if (tool_name.startsWith("mcp__")) {
    return [{ type: "mcp_call", category: "mcp", data: tool_name, priority: 3 }];
  }

  // GitHub writes (priority 2). Reads and searches describe the repository, not the
  // work done to it, and would drown the git events the Bash path records.
  if (tool_name === "GitHub") {
    const op = String(input.tool_input.op ?? "");
    if (!GITHUB_WRITE_OPS.includes(op)) return [];
    const subject = String(input.tool_input.title ?? input.tool_input.pr ?? input.tool_input.repo ?? "");
    return [{ type: `github_${op}`, category: "git", data: truncate(subject ? `${op}: ${subject}` : op), priority: 2 }];
  }

  // Security scans (priority 2) — starting one is a deliberate act; polling its status is not.
  if (tool_name === "SecurityScan") {
    const action = String(input.tool_input.action ?? "");
    if (!SCAN_START_ACTIONS.includes(action)) return [];
    const target = String(input.tool_input.target_kind ?? "").trim();
    return [{ type: "security_scan", category: "security", data: truncate(target ? `scan started (${target})` : "scan started"), priority: 2 }];
  }

  // Agent-authored context notes (priority 2) — the note itself is the memory.
  if (tool_name === "ContextNote") {
    const text = String(input.tool_input.text ?? "").trim();
    if (!text) return [];
    return [{ type: "context_note", category: "context", data: truncate(text), priority: 2 }];
  }

  // Context lifecycle (priority 2) — explains later loss of context, and a rewind
  // carries the findings that ended an exploration.
  if (tool_name === "ContextChange") {
    const kind = String(input.tool_input.kind ?? "");
    if (!CONTEXT_CHANGE_KINDS.includes(kind)) return [];
    const detail = String(input.tool_input.detail ?? "").trim();
    const fallback = kind === "reset" ? "fresh context requested" : `${kind} recorded`;
    return [{ type: `context_${kind}`, category: "context", data: truncate(detail || fallback), priority: 2 }];
  }

  // Any other tool with the legacy isError flag
  if (isToolFailure(input)) {
    return [{ type: "error_tool", category: "error", data: truncate(`${tool_name} error`), priority: 1 }];
  }

  return [];
}

// Extract text content from <channel> XML tags, or return prompt as-is
export function normalizePromptWithChannels(prompt: string): { text: string; fromChannel: boolean } {
  const normalized = prompt.replace(/<channel[^>]*>([\s\S]*?)<\/channel>/g, (_, content) => content.trim());
  return { text: normalized, fromChannel: normalized !== prompt };
}

export function extractUserPromptEvents(prompt: string): ExtractedEvent[] {
  const events: ExtractedEvent[] = [];

  // Strip <channel> XML tags before running extractors
  const { text: normalizedPrompt, fromChannel } = normalizePromptWithChannels(prompt);

  const lower = normalizedPrompt.toLowerCase();

  const channelTags = fromChannel ? ["source:telegram"] : undefined;

  // Decision extraction with negative-match guards
  const hasNegative = NEGATIVE_PATTERNS.some(np => lower.includes(np));
  if (!hasNegative) {
    const decisionPatterns = [
      /\b(don'?t|never|always|prefer|use .+ instead)\b/i,
    ];
    for (const pattern of decisionPatterns) {
      if (pattern.test(normalizedPrompt)) {
        const event: ExtractedEvent = {
          type: "user_decision",
          category: "decision",
          data: truncate(normalizedPrompt),
          priority: 1,
        };
        if (channelTags) event.tags = channelTags;
        events.push(event);
        break;
      }
    }
  }

  // Role extraction
  const rolePatterns = [
    /\b(i'?m a|act as|i am a|as a|my role)\b/i,
    /\b(senior|junior|staff|lead|principal)\s+(engineer|developer|scientist|designer)\b/i,
  ];
  for (const pattern of rolePatterns) {
    if (pattern.test(normalizedPrompt)) {
      const event: ExtractedEvent = {
        type: "user_role",
        category: "role",
        data: truncate(normalizedPrompt),
        priority: 2,
      };
      if (channelTags) event.tags = channelTags;
      events.push(event);
      break;
    }
  }

  // Intent extraction
  const intentMap: [RegExp, string][] = [
    [/\b(why|explain|debug|investigate|understand)\b/i, "investigate"],
    [/\b(create|fix|build|implement|add|write)\b/i, "implement"],
    [/\b(review|check|verify|test|validate)\b/i, "review"],
    [/\b(refactor|clean|simplify|optimize)\b/i, "refactor"],
  ];
  for (const [pattern, intent] of intentMap) {
    if (pattern.test(normalizedPrompt)) {
      const event: ExtractedEvent = {
        type: `intent_${intent}`,
        category: "intent",
        data: intent,
        priority: 3,
      };
      if (channelTags) event.tags = channelTags;
      events.push(event);
      break;
    }
  }

  return events;
}
