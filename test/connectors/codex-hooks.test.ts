import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  diagnoseConnector,
  installConnector,
  listConnectors,
  removeConnector,
} from "../../src/connectors/installer.js";
import { buildCodexHookCommand } from "../../src/connectors/codex-hooks.js";

let tmpDir: string;

const commandOptions = {
  nodePath: "/opt/LCM Runtime/node",
  cliPath: "/opt/LCM Package/dist/bin/lcm.js",
};

function hooksPath(): string {
  return join(tmpDir, ".codex", "hooks.json");
}

function readConfig(): any {
  return JSON.parse(readFileSync(hooksPath(), "utf-8"));
}

function writeConfig(value: unknown): void {
  mkdirSync(dirname(hooksPath()), { recursive: true });
  writeFileSync(hooksPath(), typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function managedHandlers(config: any, event: string): any[] {
  return (config.hooks[event] ?? [])
    .flatMap((group: any) => group.hooks ?? [])
    .filter((handler: any) => handler.statusMessage?.startsWith("LCM lifecycle:"));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lcm-codex-hooks-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Codex hooks connector installation", () => {
  it("installs all native lifecycle events with their matchers and deadlines", () => {
    const result = installConnector("codex", undefined, tmpDir, commandOptions);
    const config = readConfig();

    expect(result.path).toBe(hooksPath());
    expect(result.requiresRestart).toBe(true);
    expect(result.notice).toContain("/hooks");
    expect(Object.keys(config.hooks)).toEqual(expect.arrayContaining([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "Interrupt",
      "SessionEnd",
      "PreCompact",
    ]));
    expect(config.hooks.SessionStart.at(-1).matcher).toBe("startup|resume|clear|compact");
    expect(config.hooks.SessionEnd.at(-1).matcher).toBe("other");
    expect(config.hooks.PreCompact.at(-1).matcher).toBe("manual|auto");
    expect(config.hooks.UserPromptSubmit.at(-1)).not.toHaveProperty("matcher");
    expect(managedHandlers(config, "SessionStart")[0].timeout).toBe(25);
    expect(managedHandlers(config, "UserPromptSubmit")[0].timeout).toBe(20);
    expect(managedHandlers(config, "Interrupt")[0].timeout).toBe(3);
    expect(managedHandlers(config, "SessionEnd")[0].timeout).toBe(3);
    expect(managedHandlers(config, "PreCompact")[0].timeout).toBe(130);
  });

  it("writes a shell-safe absolute command for runtime paths containing spaces", () => {
    installConnector("codex", "hooks", tmpDir, commandOptions);
    const config = readConfig();
    const commands = Object.keys(config.hooks)
      .flatMap(event => managedHandlers(config, event))
      .map(handler => handler.command);

    expect(buildCodexHookCommand(commandOptions)).toBe(
      "'/opt/LCM Runtime/node' '/opt/LCM Package/dist/bin/lcm.js' codex-hook",
    );
    expect(new Set(commands)).toEqual(new Set([buildCodexHookCommand(commandOptions)]));
  });

  it("preserves unrelated config and hooks across install and reinstall", () => {
    const unrelatedSessionStart = {
      matcher: "startup",
      hooks: [{ type: "command", command: "other-session-hook" }],
    };
    const unrelatedPostTool = {
      matcher: "Bash",
      hooks: [{ type: "command", command: "other-tool-hook" }],
    };
    writeConfig({
      description: "Keep this",
      custom: { keep: true },
      hooks: {
        SessionStart: [unrelatedSessionStart],
        PostToolUse: [unrelatedPostTool],
      },
    });

    installConnector("codex", "hooks", tmpDir, {
      nodePath: "/old/node",
      cliPath: "/old/lcm.js",
    });
    installConnector("codex", "hooks", tmpDir, commandOptions);
    const config = readConfig();

    expect(config.description).toBe("Keep this");
    expect(config.custom).toEqual({ keep: true });
    expect(config.hooks.PostToolUse).toEqual([unrelatedPostTool]);
    expect(config.hooks.SessionStart[0]).toEqual(unrelatedSessionStart);
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "Interrupt", "SessionEnd", "PreCompact"]) {
      expect(managedHandlers(config, event)).toHaveLength(1);
      expect(managedHandlers(config, event)[0].command).toBe(buildCodexHookCommand(commandOptions));
    }
  });

  it("refuses to overwrite malformed JSON or event shapes", () => {
    writeConfig("{not-json");
    expect(() => installConnector("codex", "hooks", tmpDir, commandOptions)).toThrow("not valid JSON");
    expect(readFileSync(hooksPath(), "utf-8")).toBe("{not-json");

    writeConfig({ hooks: { SessionStart: { keep: true } } });
    const before = readFileSync(hooksPath(), "utf-8");
    expect(() => installConnector("codex", "hooks", tmpDir, commandOptions)).toThrow("hooks.SessionStart");
    expect(readFileSync(hooksPath(), "utf-8")).toBe(before);
  });
});

describe("Codex hooks connector removal", () => {
  it("removes only managed handlers and preserves unrelated hooks", () => {
    const unrelated = {
      type: "command",
      command: "keep-me",
      statusMessage: "LCM lifecycle: user-owned custom hook",
    };
    const wrongEvent = {
      type: "command",
      command: "keep-this-too",
      statusMessage: "LCM lifecycle: restoring context",
    };
    installConnector("codex", "hooks", tmpDir, commandOptions);
    const config = readConfig();
    config.description = "Keep this too";
    config.hooks.Stop[0].hooks.unshift(unrelated, wrongEvent);
    config.hooks.PostToolUse = [{ matcher: "Bash", hooks: [unrelated] }];
    writeConfig(config);

    expect(removeConnector("codex", "hooks", tmpDir)).toBe(true);
    const remaining = readConfig();
    expect(remaining.description).toBe("Keep this too");
    expect(remaining.hooks.Stop).toEqual([{ hooks: [unrelated, wrongEvent] }]);
    expect(remaining.hooks.PostToolUse).toEqual([{ matcher: "Bash", hooks: [unrelated] }]);
    expect(remaining.hooks.SessionStart).toBeUndefined();
  });

  it("deletes a hooks.json created solely for LCM", () => {
    installConnector("codex", "hooks", tmpDir, commandOptions);
    expect(removeConnector("codex", "hooks", tmpDir)).toBe(true);
    expect(existsSync(hooksPath())).toBe(false);
  });
});

describe("Codex hooks connector diagnostics", () => {
  it("separates installed configuration from unknown Codex trust and activation", () => {
    installConnector("codex", "hooks", tmpDir, commandOptions);
    const diagnosis = diagnoseConnector("codex", "hooks", tmpDir, commandOptions);

    expect(diagnosis.status).toBe("installed");
    expect(diagnosis.installed).toBe(true);
    expect(diagnosis.complete).toBe(true);
    expect(diagnosis.active).toBeNull();
    expect(diagnosis.trust).toBe("unknown");
    expect(diagnosis.issues).toEqual([]);
    expect(diagnosis.message).toContain("/hooks");
    expect(listConnectors(tmpDir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "codex", type: "hooks", path: hooksPath() }),
    ]));
  });

  it("reports a partial installation when a managed handler is missing", () => {
    installConnector("codex", "hooks", tmpDir, commandOptions);
    const config = readConfig();
    delete config.hooks.PreCompact;
    writeConfig(config);

    const diagnosis = diagnoseConnector("codex", "hooks", tmpDir, commandOptions);
    expect(diagnosis.status).toBe("partial");
    expect(diagnosis.installed).toBe(true);
    expect(diagnosis.complete).toBe(false);
    expect(diagnosis.active).toBeNull();
    expect(diagnosis.trust).toBe("unknown");
    expect(diagnosis.issues).toContain("PreCompact: managed hook is missing");
  });

  it("reports not installed without implying a trust decision", () => {
    const diagnosis = diagnoseConnector("codex", "hooks", tmpDir, commandOptions);
    expect(diagnosis.status).toBe("not-installed");
    expect(diagnosis.installed).toBe(false);
    expect(diagnosis.complete).toBe(false);
    expect(diagnosis.active).toBe(false);
    expect(diagnosis.trust).toBe("not-applicable");
  });
});
