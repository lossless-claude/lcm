import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mergeClaudeSettings,
  resolveBinaryPath,
  install,
  ensureLcmMd,
  REQUIRED_HOOKS,
  type ServiceDeps,
} from "../../installer/install.js";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeSpawn(status = 0, stdout = "") {
  return vi.fn().mockReturnValue({ status, stdout, stderr: "", pid: 1, output: [], signal: null });
}

function makeDeps(overrides: Partial<ServiceDeps> = {}): ServiceDeps {
  return {
    spawnSync: makeSpawn(),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    promptUser: vi.fn().mockResolvedValue("1"), // default: option 1
    ensureDaemon: vi.fn().mockResolvedValue({ connected: true }),
    runDoctor: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ─── mergeClaudeSettings ────────────────────────────────────────────────────

describe("mergeClaudeSettings", () => {
  it("removes managed hooks and mcpServers from empty settings", () => {
    const r = mergeClaudeSettings({});
    expect(r).toEqual({});
  });

  it("removes all 4 required hooks when already present", () => {
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "lcm restore" }] }],
        SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: "lcm session-end" }] }],
        UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "lcm user-prompt" }] }],
      },
      mcpServers: {
        lcm: { command: "lcm", args: ["mcp"] },
      },
    };
    const r = mergeClaudeSettings(existing);
    expect(r.hooks).toBeUndefined();
    // mcpServers.lcm is now owned by settings.json and preserved
    expect(r.mcpServers).toEqual({ lcm: { command: "lcm", args: ["mcp"] } });
  });

  it("REQUIRED_HOOKS contains exactly 5 expected events", () => {
    expect(REQUIRED_HOOKS.map(h => h.event).sort()).toEqual([
      "PreCompact", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit",
    ]);
  });

  it("removes any of the 5 hooks if already present", () => {
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }],
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "lcm restore" }] }],
        SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: "lcm session-end" }] }],
        UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "lcm user-prompt" }] }],
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "lcm session-snapshot" }] }],
      },
    };
    const r = mergeClaudeSettings(existing);
    expect(r.hooks).toBeUndefined();
  });

  it("preserves unrelated hooks", () => {
    const r = mergeClaudeSettings({ hooks: { PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }] } });
    expect(r.hooks.PreCompact).toHaveLength(1);
    expect(r.hooks.PreCompact[0].hooks[0].command).toBe("other");
  });

  it("removes managed hooks without leaving duplicates behind", () => {
    const r = mergeClaudeSettings({ hooks: { PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lcm compact --hook" }] }] } });
    expect(r.hooks).toBeUndefined();
  });

  it("removes only matching managed sub-hooks from a mixed entry", () => {
    const r = mergeClaudeSettings({
      hooks: {
        PreCompact: [{
          matcher: "",
          hooks: [
            { type: "command", command: "other" },
            { type: "command", command: "lcm compact --hook" },
          ],
        }],
      },
    });

    expect(r.hooks.PreCompact).toEqual([{
      matcher: "",
      hooks: [{ type: "command", command: "other" }],
    }]);
  });

  it("migrates legacy lossless-claude hooks to lcm before removing them", () => {
    const existing = {
      hooks: {
        PreCompact: [{ matcher: "", hooks: [{ type: "command", command: "lossless-claude compact" }] }],
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "lossless-claude restore" }] }],
        PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other" }] }],
      },
      mcpServers: {
        "lossless-claude": { command: "lossless-claude", args: ["mcp"] },
        other: { command: "other", args: ["mcp"] },
      }
    };
    const result = mergeClaudeSettings(existing);
    for (const { event, command } of REQUIRED_HOOKS) {
      const entries = result.hooks?.[event] ?? [];
      const commands = entries.flatMap((e: any) => e.hooks.map((h: any) => h.command));
      expect(commands).not.toContain(command);
      expect(commands).not.toContain(command.replace(/^lcm /, "lossless-claude "));
    }
    expect(result.hooks?.PostToolUse).toEqual([{ matcher: "", hooks: [{ type: "command", command: "other" }] }]);
    expect(result.mcpServers["lossless-claude"]).toBeUndefined();
    expect(result.mcpServers["lcm"]).toBeUndefined();
    expect(result.mcpServers.other).toEqual({ command: "other", args: ["mcp"] });
  });
});

// ─── resolveBinaryPath ──────────────────────────────────────────────────────

describe("resolveBinaryPath", () => {
  it("returns path from which when available", () => {
    const spawnMock = makeSpawn(0, "/usr/local/bin/lcm\n");
    const deps = {
      spawnSync: spawnMock,
      existsSync: vi.fn().mockReturnValue(false),
    };
    expect(resolveBinaryPath(deps)).toBe("/usr/local/bin/lcm");
    expect(spawnMock).toHaveBeenCalledWith("sh", ["-c", "command -v lcm"], expect.anything());
  });

  it("falls back to ~/.npm-global/bin when which fails", () => {
    const npmGlobal = join(homedir(), ".npm-global", "bin", "lcm");
    const deps = {
      spawnSync: makeSpawn(1, ""),
      existsSync: vi.fn().mockImplementation((p: string) => p === npmGlobal),
    };
    expect(resolveBinaryPath(deps)).toBe(npmGlobal);
  });

  it("returns bare binary name when nothing found", () => {
    const deps = {
      spawnSync: makeSpawn(1, ""),
      existsSync: vi.fn().mockReturnValue(false),
    };
    expect(resolveBinaryPath(deps)).toBe("lcm");
  });
});

// ─── install ────────────────────────────────────────────────────────────────

describe("install", () => {
  it("core install works with zero external dependencies", async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    const deps = makeDeps({ existsSync: vi.fn().mockReturnValue(false) });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(install(deps)).resolves.not.toThrow();
    // No setup.sh, no cipher, no qdrant
    const bashCalls = (deps.spawnSync as ReturnType<typeof vi.fn>).mock.calls.filter((c: any[]) => c[0] === "bash");
    expect(bashCalls).toHaveLength(0);
    warnSpy.mockRestore();
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it("writes config.json with provider=auto and empty apiKey in non-TTY mode", async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    const writeFileMock = vi.fn();
    const deps = makeDeps({ existsSync: vi.fn().mockReturnValue(false), writeFileSync: writeFileMock });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();
    const configWriteCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
    expect(configWriteCall).toBeDefined();
    const written = JSON.parse(configWriteCall![1]);
    expect(written.llm.provider).toBe("auto");
    expect(written.llm.apiKey).toBe("");
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  });
});

// ─── install dry-run ─────────────────────────────────────────────────────────

describe("install with DryRunServiceDeps", () => {
  it("prints [dry-run] lines and writes no real files", async () => {
    const { DryRunServiceDeps } = await import("../../installer/dry-run-deps.js");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(install(new DryRunServiceDeps())).resolves.not.toThrow();

    const dryRunLines = logSpy.mock.calls
      .flatMap((c: any[]) => c)
      .filter((s: any) => typeof s === "string" && s.includes("[dry-run]"));

    expect(dryRunLines.some((l: string) => l.includes("would write:"))).toBe(true);
    expect(dryRunLines.some((l: string) => l.includes("settings.json"))).toBe(true);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ─── summarizer picker ───────────────────────────────────────────────────────

describe("summarizer picker", () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalIsTTY = process.stdin.isTTY;

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalApiKey;
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, writable: true });
  });

  it("option 1 (native CLI default): writes provider=auto to config.json", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    const writeFileMock = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: writeFileMock,
      promptUser: vi.fn().mockResolvedValueOnce("1"),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();
    const configCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
    expect(configCall).toBeDefined();
    const written = JSON.parse(configCall![1]);
    expect(written.llm.provider).toBe("auto");
    expect(written.llm.apiKey).toBeFalsy();
  });

  it("option 2 (Anthropic API): writes provider=anthropic and apiKey literal to config.json", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    const writeFileMock = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: writeFileMock,
      promptUser: vi.fn().mockResolvedValueOnce("2"),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();
    const configCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
    expect(configCall).toBeDefined();
    const written = JSON.parse(configCall![1]);
    expect(written.llm.provider).toBe("anthropic");
    expect(written.llm.apiKey).toBe("${ANTHROPIC_API_KEY}");
    expect(written.llm.model).toBe("claude-haiku-4-5-20251001");
  });

  it("option 3 (custom server): prompts for URL and model, writes provider=openai", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    const writeFileMock = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: writeFileMock,
      promptUser: vi.fn()
        .mockResolvedValueOnce("3")                           // picker: option 3
        .mockResolvedValueOnce("http://192.168.1.5:8080/v1") // URL prompt
        .mockResolvedValueOnce("my-model"),                   // model prompt
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();
    const configCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
    expect(configCall).toBeDefined();
    const written = JSON.parse(configCall![1]);
    expect(written.llm.provider).toBe("openai");
    expect(written.llm.baseURL).toBe("http://192.168.1.5:8080/v1");
    expect(written.llm.model).toBe("my-model");
  });

  it("invalid input re-prompts once then defaults to option 1 (auto)", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
    const writeFileMock = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: writeFileMock,
      promptUser: vi.fn()
        .mockResolvedValueOnce("9")   // invalid
        .mockResolvedValueOnce("9"),  // invalid again → default to 1
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();
    const configCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
    const written = JSON.parse(configCall![1]);
    expect(written.llm.provider).toBe("auto");
  });

  it("non-TTY (process.stdin.isTTY is false): skips picker and defaults to auto", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true });
    const writeFileMock = vi.fn();
    const promptUserMock = vi.fn();
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: writeFileMock,
      promptUser: promptUserMock,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();
    expect(promptUserMock).not.toHaveBeenCalled(); // picker was skipped
    const configCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
    const written = JSON.parse(configCall![1]);
    expect(written.llm.provider).toBe("auto");
    expect(written.llm.apiKey).toBe("");
  });
});

// ─── MCP registration ────────────────────────────────────────────────────────

describe("install — MCP registration", () => {
  it("writes mcpServers.lcm to settings.json", async () => {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    let written = "";
    const deps = makeDeps({
      existsSync: vi.fn().mockReturnValue(false),
      writeFileSync: vi.fn().mockImplementation((path: string, data: string) => {
        if (path === settingsPath) written = data;
      }),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    warnSpy.mockRestore();

    const settings = JSON.parse(written);
    expect(settings.mcpServers?.lcm).toBeDefined();
    expect(settings.mcpServers.lcm.args).toContain("mcp");
    expect(typeof settings.mcpServers.lcm.command).toBe("string");
    expect(settings.mcpServers.lcm.command.length).toBeGreaterThan(0);
  });
});

// ─── ensureLcmMd ────────────────────────────────────────────────────────────

describe("ensureLcmMd", () => {
  const CONTENT = "# lcm test content\n";
  const BLOCK = `<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->`;

  function makeDepsForLcm(claudeMdContent?: string) {
    const files = new Map<string, string>();
    if (claudeMdContent !== undefined) {
      files.set("/home/.claude/CLAUDE.md", claudeMdContent);
    }
    const written = new Map<string, string>();
    return {
      deps: {
        existsSync: (p: string) => files.has(p),
        readFileSync: (p: string) => files.get(p) ?? "",
        writeFileSync: (p: string, content: string) => { written.set(p, content); files.set(p, content); },
        mkdirSync: vi.fn(),
      },
      written,
    };
  }

  it("writes lcm.md and creates CLAUDE.md with managed block when neither exists", () => {
    const { deps, written } = makeDepsForLcm();
    const result = ensureLcmMd(deps, CONTENT, "/home");
    expect(result.lcmMdWritten).toBe(true);
    expect(result.claudeMdPatched).toBe(true);
    expect(written.get("/home/.claude/lcm.md")).toBe(CONTENT);
    expect(written.get("/home/.claude/CLAUDE.md")).toContain(BLOCK);
  });

  it("appends managed block when CLAUDE.md exists without it", () => {
    const { deps, written } = makeDepsForLcm("@RTK.md\n");
    const result = ensureLcmMd(deps, CONTENT, "/home");
    expect(result.claudeMdPatched).toBe(true);
    const claudeMd = written.get("/home/.claude/CLAUDE.md")!;
    expect(claudeMd).toContain("@RTK.md");
    expect(claudeMd).toContain(BLOCK);
  });

  it("does not rewrite CLAUDE.md when managed block is already correct", () => {
    const existing = `@RTK.md\n<!-- lcm:start -->\n<!-- Claude Code include: @lcm.md -->\n<!-- lcm:end -->\n@other.md\n`;
    const { deps, written } = makeDepsForLcm(existing);
    const result = ensureLcmMd(deps, CONTENT, "/home");
    expect(result.claudeMdPatched).toBe(false);
    expect(written.has("/home/.claude/CLAUDE.md")).toBe(false); // no write needed
  });

  it("updates managed block when its content changes", () => {
    const existing = `@RTK.md\n<!-- lcm:start -->\n@old.md\n<!-- lcm:end -->\n@other.md\n`;
    const { deps, written } = makeDepsForLcm(existing);
    const result = ensureLcmMd(deps, CONTENT, "/home");
    const claudeMd = written.get("/home/.claude/CLAUDE.md")!;
    expect(result.claudeMdPatched).toBe(true);
    expect(claudeMd).toContain("@RTK.md");
    expect(claudeMd).toContain("@other.md");
    expect(claudeMd).toContain(BLOCK);
    expect(claudeMd.indexOf("<!-- lcm:start -->")).toBe(claudeMd.lastIndexOf("<!-- lcm:start -->")); // only one block
  });

  it("always overwrites lcm.md to keep content current", () => {
    const { deps, written } = makeDepsForLcm();
    ensureLcmMd(deps, CONTENT, "/home");
    expect(written.get("/home/.claude/lcm.md")).toBe(CONTENT);
  });
});
