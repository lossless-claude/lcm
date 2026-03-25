// src/hooks/extractors.ts

export interface ExtractedEvent {
  type: string;
  category: string;
  data: string;
  priority: number;
}

interface PostToolInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: unknown;
  tool_output?: { isError?: boolean };
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
  const isError = input.tool_output?.isError === true;

  // Error detection (priority 1)
  if (isError) {
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
  const filePath = String(
    input.tool_input.file_path ?? input.tool_input.path ?? input.tool_input.pattern ?? ""
  );
  if (!filePath || isSensitivePath(filePath)) return [];

  const typeMap: Record<string, string> = {
    Read: "file_read", Edit: "file_edit", Write: "file_write",
    Glob: "file_glob", Grep: "file_grep",
  };

  return [{
    type: typeMap[toolName] ?? "file_access",
    category: "file",
    data: truncate(`${filePath} (${classifyFile(filePath)})`),
    priority: 3,
  }];
}

export function extractPostToolEvents(input: PostToolInput): ExtractedEvent[] {
  const { tool_name } = input;

  // Skip lcm_store to prevent feedback loops
  if (tool_name.includes("lcm_store") || tool_name.includes("lcm__lcm_store")) return [];

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

  // Any other tool with isError flag
  if (input.tool_output?.isError === true) {
    return [{
      type: "error_tool",
      category: "error",
      data: truncate(`${tool_name} error`),
      priority: 1,
    }];
  }

  return [];
}

export function extractUserPromptEvents(prompt: string): ExtractedEvent[] {
  const events: ExtractedEvent[] = [];
  const lower = prompt.toLowerCase();

  // Decision extraction with negative-match guards
  const hasNegative = NEGATIVE_PATTERNS.some(np => lower.includes(np));
  if (!hasNegative) {
    const decisionPatterns = [
      /\b(don'?t|never|always|prefer|use .+ instead)\b/i,
    ];
    for (const pattern of decisionPatterns) {
      if (pattern.test(prompt)) {
        events.push({
          type: "user_decision",
          category: "decision",
          data: truncate(prompt),
          priority: 1,
        });
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
    if (pattern.test(prompt)) {
      events.push({
        type: "user_role",
        category: "role",
        data: truncate(prompt),
        priority: 2,
      });
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
    if (pattern.test(prompt)) {
      events.push({
        type: `intent_${intent}`,
        category: "intent",
        data: intent,
        priority: 3,
      });
      break;
    }
  }

  return events;
}
