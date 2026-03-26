export const REQUIRED_HOOKS: { event: string; subcommand: string }[] = [
  { event: "PostToolUse", subcommand: "post-tool" },
  { event: "PreCompact", subcommand: "compact --hook" },
  { event: "SessionStart", subcommand: "restore" },
  { event: "SessionEnd", subcommand: "session-end" },
  { event: "UserPromptSubmit", subcommand: "user-prompt" },
  { event: "Stop", subcommand: "session-snapshot" },
];

export type HookOpts =
  | { intent: "remove" }
  | { intent: "upsert"; nodePath: string; lcmMjsPath: string };

export function requiredHooks(
  nodePath: string,
  lcmMjsPath: string,
): Array<{ event: string; command: string }> {
  return REQUIRED_HOOKS.map(({ event, subcommand }) => ({
    event,
    command: `"${nodePath}" "${lcmMjsPath}" ${subcommand}`,
  }));
}

/** Returns true if all 6 required hooks are present in `existing` with matching absolute paths. */
export function hooksUpToDate(
  existing: any,
  nodePath: string,
  lcmMjsPath: string,
): boolean {
  const needed = requiredHooks(nodePath, lcmMjsPath);
  const hooks = existing?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  return needed.every(({ event, command }) => {
    const entries = hooks[event];
    return (
      Array.isArray(entries) &&
      entries.some(
        (entry: any) =>
          Array.isArray(entry?.hooks) &&
          entry.hooks.some((h: any) => h.command === command),
      )
    );
  });
}

/** Returns true if `cmd` is an lcm-managed hook command in any known format. */
export function isLcmHookCommand(cmd: string): boolean {
  return (
    cmd.includes("lcm.mjs") ||
    /^"?lcm\s/.test(cmd) ||
    /^"?lossless-claude\s/.test(cmd)
  );
}

export function mergeClaudeSettings(existing: any, opts: HookOpts = { intent: "remove" }): any {
  const settings = JSON.parse(JSON.stringify(existing));
  settings.hooks =
    settings.hooks &&
    typeof settings.hooks === "object" &&
    !Array.isArray(settings.hooks)
      ? settings.hooks
      : {};
  settings.mcpServers =
    settings.mcpServers &&
    typeof settings.mcpServers === "object" &&
    !Array.isArray(settings.mcpServers)
      ? settings.mcpServers
      : {};

  // Migrate old command strings to current bare form before processing
  const OLD_TO_NEW: Record<string, string> = {
    "lossless-claude compact": "lcm compact --hook",
    "lossless-claude restore": "lcm restore",
    "lossless-claude session-end": "lcm session-end",
    "lossless-claude user-prompt": "lcm user-prompt",
    "lcm compact": "lcm compact --hook",
  };
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    for (const entry of settings.hooks[event]) {
      if (!Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (h.command && OLD_TO_NEW[h.command]) {
          h.command = OLD_TO_NEW[h.command];
        }
      }
      // Deduplicate within each hook entry after migration
      const seen = new Set<string>();
      entry.hooks = entry.hooks.filter((h: any) => {
        const key = h.command ?? "";
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }

  // Remove legacy MCP server entry
  delete settings.mcpServers["lossless-claude"];

  if (opts.intent === "remove") {
    // Remove all lcm-managed hooks from settings.json
    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) continue;
      settings.hooks[event] = settings.hooks[event]
        .map((entry: any) => {
          if (!Array.isArray(entry.hooks)) return entry;
          return {
            ...entry,
            hooks: entry.hooks.filter(
              (h: any) => !isLcmHookCommand(h.command ?? ""),
            ),
          };
        })
        .filter(
          (entry: any) =>
            !Array.isArray(entry.hooks) || entry.hooks.length > 0,
        );
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
  } else {
    // Upsert: ensure all 6 hooks exist with correct absolute paths
    const needed = requiredHooks(opts.nodePath, opts.lcmMjsPath);
    for (const { event, command } of needed) {
      if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
      // Remove stale lcm entries (old format or wrong absolute paths)
      settings.hooks[event] = settings.hooks[event]
        .map((entry: any) => {
          if (!Array.isArray(entry.hooks)) return entry;
          return {
            ...entry,
            hooks: entry.hooks.filter(
              (h: any) =>
                !isLcmHookCommand(h.command ?? "") || h.command === command,
            ),
          };
        })
        .filter(
          (entry: any) =>
            !Array.isArray(entry.hooks) || entry.hooks.length > 0,
        );
      // Add if not already present
      const alreadyPresent = settings.hooks[event].some(
        (entry: any) =>
          Array.isArray(entry.hooks) &&
          entry.hooks.some((h: any) => h.command === command),
      );
      if (!alreadyPresent) {
        settings.hooks[event].push({
          matcher: "",
          hooks: [{ type: "command", command }],
        });
      }
    }
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;

  return settings;
}
