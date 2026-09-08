import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LCM_STATUS_PREFIX = "LCM lifecycle:";

type JsonObject = Record<string, unknown>;

interface CodexHookSpec {
  event: string;
  matcher?: string;
  statusMessage: string;
  timeout: number;
}

export interface CodexHookCommandOptions {
  nodePath?: string;
  cliPath?: string;
}

export type ConnectorInstallStatus = "not-installed" | "partial" | "installed";

export interface CodexHooksDiagnosis {
  status: ConnectorInstallStatus;
  path: string;
  installed: boolean;
  complete: boolean;
  active: boolean | null;
  trust: "not-applicable" | "unknown";
  issues: string[];
  message: string;
}

const CODEX_HOOK_SPECS: readonly CodexHookSpec[] = [
  {
    event: "SessionStart",
    matcher: "startup|resume|clear|compact",
    statusMessage: `${LCM_STATUS_PREFIX} restoring context`,
    timeout: 25,
  },
  {
    event: "UserPromptSubmit",
    statusMessage: `${LCM_STATUS_PREFIX} recalling memory`,
    timeout: 20,
  },
  {
    event: "Stop",
    statusMessage: `${LCM_STATUS_PREFIX} capturing turn`,
    timeout: 20,
  },
  {
    event: "Interrupt",
    statusMessage: `${LCM_STATUS_PREFIX} capturing interruption`,
    timeout: 3,
  },
  {
    event: "SessionEnd",
    matcher: "other",
    statusMessage: `${LCM_STATUS_PREFIX} closing session`,
    timeout: 3,
  },
  {
    event: "PreCompact",
    matcher: "manual|auto",
    statusMessage: `${LCM_STATUS_PREFIX} preserving context`,
    timeout: 130,
  },
] as const;

const MANAGED_STATUS_MESSAGES = new Set(CODEX_HOOK_SPECS.map(spec => spec.statusMessage));

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildCodexHookCommand(options: CodexHookCommandOptions = {}): string {
  const nodePath = resolve(options.nodePath ?? process.execPath);
  const argvPath = process.argv[1];
  const argvBase = argvPath ? basename(argvPath) : "";
  const invokedThroughLcm = argvBase === "lcm" || /^lcm\.(?:js|mjs)$/.test(argvBase);
  const installedEntrypoint = fileURLToPath(new URL("../../bin/lcm.js", import.meta.url));
  const cliPath = options.cliPath ?? (invokedThroughLcm ? argvPath : installedEntrypoint);
  return `${quoteShellArgument(nodePath)} ${quoteShellArgument(resolve(cliPath))} codex-hook`;
}

function readConfigForInstall(filePath: string): JsonObject {
  if (!existsSync(filePath)) return {};
  const source = readFileSync(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`Cannot install Codex hooks: ${filePath} is not valid JSON`);
  }
  if (!isObject(parsed)) {
    throw new Error(`Cannot install Codex hooks: ${filePath} must contain a JSON object`);
  }
  if (parsed.hooks !== undefined && !isObject(parsed.hooks)) {
    throw new Error(`Cannot install Codex hooks: "hooks" in ${filePath} must be an object`);
  }
  if (isObject(parsed.hooks)) {
    for (const [event, groups] of Object.entries(parsed.hooks)) {
      if (!Array.isArray(groups)) {
        throw new Error(`Cannot install Codex hooks: "hooks.${event}" in ${filePath} must be an array`);
      }
      for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group.hooks)) {
          throw new Error(`Cannot install Codex hooks: every "hooks.${event}" group in ${filePath} must contain a hooks array`);
        }
      }
    }
  }
  return parsed;
}

function isManagedHandler(value: unknown, spec?: CodexHookSpec): boolean {
  return isObject(value)
    && value.type === "command"
    && typeof value.statusMessage === "string"
    && (spec
      ? value.statusMessage === spec.statusMessage
      : MANAGED_STATUS_MESSAGES.has(value.statusMessage));
}

function withoutManagedHandlers(groups: unknown, spec: CodexHookSpec): unknown[] {
  if (!Array.isArray(groups)) return [];
  const retained: unknown[] = [];
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      retained.push(group);
      continue;
    }
    const handlers = group.hooks.filter(handler => !isManagedHandler(handler, spec));
    if (handlers.length > 0) retained.push({ ...group, hooks: handlers });
  }
  return retained;
}

function managedGroup(spec: CodexHookSpec, command: string): JsonObject {
  const group: JsonObject = {
    hooks: [{
      type: "command",
      command,
      timeout: spec.timeout,
      statusMessage: spec.statusMessage,
    }],
  };
  if (spec.matcher !== undefined) group.matcher = spec.matcher;
  return group;
}

export function installCodexHooks(
  filePath: string,
  options: CodexHookCommandOptions = {},
): void {
  const config = readConfigForInstall(filePath);
  const hooks = isObject(config.hooks) ? { ...config.hooks } : {};
  const command = buildCodexHookCommand(options);

  for (const spec of CODEX_HOOK_SPECS) {
    const retained = withoutManagedHandlers(hooks[spec.event], spec);
    hooks[spec.event] = [...retained, managedGroup(spec, command)];
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ ...config, hooks }, null, 2) + "\n");
}

export function removeCodexHooks(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return false;
  }
  if (!isObject(config) || !isObject(config.hooks)) return false;

  const hooks: JsonObject = { ...config.hooks };
  let removed = false;
  for (const spec of CODEX_HOOK_SPECS) {
    const event = spec.event;
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const retained: unknown[] = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        retained.push(group);
        continue;
      }
      const handlers = group.hooks.filter(handler => !isManagedHandler(handler, spec));
      if (handlers.length !== group.hooks.length) removed = true;
      if (handlers.length > 0) retained.push({ ...group, hooks: handlers });
    }
    if (retained.length > 0) hooks[event] = retained;
    else delete hooks[event];
  }

  if (!removed) return false;
  const nextConfig: JsonObject = { ...config };
  if (Object.keys(hooks).length > 0) nextConfig.hooks = hooks;
  else delete nextConfig.hooks;

  if (Object.keys(nextConfig).length === 0) unlinkSync(filePath);
  else writeFileSync(filePath, JSON.stringify(nextConfig, null, 2) + "\n");
  return true;
}

function diagnoseManagedSpec(
  hooks: JsonObject,
  spec: CodexHookSpec,
  expectedCommand: string,
): string[] {
  const groups = hooks[spec.event];
  if (!Array.isArray(groups)) return [`${spec.event}: managed hook is missing`];

  const matches: Array<{ group: JsonObject; handler: JsonObject }> = [];
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    for (const handler of group.hooks) {
      if (isManagedHandler(handler, spec)) {
        matches.push({ group, handler });
      }
    }
  }
  if (matches.length === 0) return [`${spec.event}: managed hook is missing`];
  if (matches.length > 1) return [`${spec.event}: managed hook is duplicated`];

  const [{ group, handler }] = matches;
  const issues: string[] = [];
  if (spec.matcher === undefined) {
    if (group.matcher !== undefined && group.matcher !== "") {
      issues.push(`${spec.event}: unexpected matcher`);
    }
  } else if (group.matcher !== spec.matcher) {
    issues.push(`${spec.event}: matcher differs from the managed configuration`);
  }
  if (handler.command !== expectedCommand) {
    issues.push(`${spec.event}: command points to a different lcm entrypoint`);
  }
  if (handler.timeout !== spec.timeout) {
    issues.push(`${spec.event}: timeout differs from the managed configuration`);
  }
  return issues;
}

function diagnoseHookShapes(hooks: JsonObject): string[] {
  const issues: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      issues.push(`${event}: hook groups must be an array`);
      continue;
    }
    if (groups.some(group => !isObject(group) || !Array.isArray(group.hooks))) {
      issues.push(`${event}: every hook group must contain a hooks array`);
    }
  }
  return issues;
}

export function diagnoseCodexHooks(
  filePath: string,
  options: CodexHookCommandOptions = {},
): CodexHooksDiagnosis {
  if (!existsSync(filePath)) {
    return {
      status: "not-installed",
      path: filePath,
      installed: false,
      complete: false,
      active: false,
      trust: "not-applicable",
      issues: [],
      message: "Codex lifecycle hooks are not installed.",
    };
  }

  let config: unknown;
  try {
    config = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return {
      status: "partial",
      path: filePath,
      installed: false,
      complete: false,
      active: null,
      trust: "unknown",
      issues: ["hooks.json is not valid JSON"],
      message: "Codex hook activation cannot be determined.",
    };
  }
  if (!isObject(config)) {
    return {
      status: "partial",
      path: filePath,
      installed: false,
      complete: false,
      active: null,
      trust: "unknown",
      issues: ["hooks.json must contain a JSON object"],
      message: "Codex hook activation cannot be determined.",
    };
  }
  if (config.hooks === undefined) {
    return {
      status: "not-installed",
      path: filePath,
      installed: false,
      complete: false,
      active: false,
      trust: "not-applicable",
      issues: [],
      message: "Codex lifecycle hooks are not installed.",
    };
  }
  if (!isObject(config.hooks)) {
    return {
      status: "partial",
      path: filePath,
      installed: false,
      complete: false,
      active: null,
      trust: "unknown",
      issues: ["hooks.json field \"hooks\" must be an object"],
      message: "Codex hook activation cannot be determined.",
    };
  }

  const hooks = config.hooks;
  const expectedCommand = buildCodexHookCommand(options);
  const hasAnyManagedHook = CODEX_HOOK_SPECS.some(spec => {
    const groups = hooks[spec.event];
    return Array.isArray(groups) && groups.some(group =>
      isObject(group) && Array.isArray(group.hooks)
      && group.hooks.some(handler => isManagedHandler(handler, spec)));
  });
  if (!hasAnyManagedHook) {
    return {
      status: "not-installed",
      path: filePath,
      installed: false,
      complete: false,
      active: false,
      trust: "not-applicable",
      issues: [],
      message: "Codex lifecycle hooks are not installed.",
    };
  }

  const issues = [
    ...diagnoseHookShapes(hooks),
    ...CODEX_HOOK_SPECS.flatMap(spec => diagnoseManagedSpec(hooks, spec, expectedCommand)),
  ];
  return {
    status: issues.length === 0 ? "installed" : "partial",
    path: filePath,
    installed: true,
    complete: issues.length === 0,
    active: null,
    trust: "unknown",
    issues,
    message: issues.length === 0
      ? "Hooks are installed. Codex activation and trust cannot be read from hooks.json; review them with /hooks."
      : "Hooks are partially installed or differ from the managed configuration. Codex activation and trust are unknown.",
  };
}
