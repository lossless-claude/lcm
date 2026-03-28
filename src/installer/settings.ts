export const REQUIRED_HOOKS: { event: string; command: string }[] = [
  { event: "PostToolUse", command: "lcm post-tool" },
  { event: "PreCompact", command: "lcm compact --hook" },
  { event: "SessionStart", command: "lcm restore" },
  { event: "SessionEnd", command: "lcm session-end" },
  { event: "UserPromptSubmit", command: "lcm user-prompt" },
  { event: "Stop", command: "lcm session-snapshot" },
];

export function mergeClaudeSettings(existing: any): any {
  const settings = JSON.parse(JSON.stringify(existing));
  settings.hooks = (settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)) ? settings.hooks : {};
  settings.mcpServers = (settings.mcpServers && typeof settings.mcpServers === "object" && !Array.isArray(settings.mcpServers)) ? settings.mcpServers : {};

  // Migrate old hook commands to current form
  const OLD_TO_NEW: Record<string, string> = {
    "lossless-claude compact": "lcm compact --hook",
    "lossless-claude restore": "lcm restore",
    "lossless-claude session-end": "lcm session-end",
    "lossless-claude user-prompt": "lcm user-prompt",
    // Migrate pre-#90 direct installs that registered without --hook
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
      // Deduplicate commands within each hook entry after migration
      const seen = new Set<string>();
      entry.hooks = entry.hooks.filter((h: any) => {
        const key = h.command ?? '';
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }
  // Remove legacy MCP server entries
  delete settings.mcpServers["lossless-claude"];

  // Remove lcm hooks from settings.json — plugin.json owns them.
  // Having hooks in both causes double-firing.
  for (const { event, command } of REQUIRED_HOOKS) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event]
      .map((entry: any) => {
        if (!Array.isArray(entry.hooks)) return entry;
        return {
          ...entry,
          hooks: entry.hooks.filter((h: any) => h.command !== command),
        };
      })
      .filter((entry: any) => !Array.isArray(entry.hooks) || entry.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  // MCP server is now owned by settings.json (written by lcm install / doctor)
  // Do NOT delete mcpServers["lcm"] here — it's managed separately from hooks
  // which are plugin-owned. This prevents the auto-heal loop where doctor adds
  // the MCP entry and hooks cleanup removes it.
  if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;

  return settings;
}
