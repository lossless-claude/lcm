import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDaemonConfig, deepMerge } from "../../src/daemon/config.js";

describe("loadDaemonConfig", () => {
  it("returns defaults when no config file exists", () => {
    const c = loadDaemonConfig("/nonexistent/config.json");
    expect(c.daemon.port).toBe(3737);
    expect(c.daemon.socketPath).toContain("daemon.sock");
    expect(c.llm.provider).toBe("auto");
    expect(c.llm.model).toBe("");
    expect(c.restoration.recentSummaries).toBe(3);
    expect(c.restoration.recallUsageBoost).toBe(0.75);
    expect(c.restoration.surfacingCooldownWindow).toBe(2);
    expect(c.restoration.maxInjectedMemoryBytes).toBe(2048);
    expect(c.restoration.reservedForLearningInstruction).toBe(1024);
    expect(c.restoration.maxInjectedMemoryItems).toBe(3);
    expect(c.restoration.dedupMinPrefix).toBe(64);
    expect(c.version).toBe(1);
  });

  it("merges partial config over defaults", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", { daemon: { port: 4000 } });
    expect(c.daemon.port).toBe(4000);
    expect(c.daemon.socketPath).toContain("daemon.sock");
  });

  it("interpolates ${ANTHROPIC_API_KEY} from env", () => {
    const c = loadDaemonConfig("/nonexistent", { llm: { apiKey: "${ANTHROPIC_API_KEY}" } }, { ANTHROPIC_API_KEY: "sk-test" });
    expect(c.llm.apiKey).toBe("sk-test");
  });

  it("falls back to env var when apiKey not set and provider is anthropic", () => {
    const c = loadDaemonConfig("/nonexistent", { llm: { provider: "anthropic" } }, { ANTHROPIC_API_KEY: "sk-env" });
    expect(c.llm.apiKey).toBe("sk-env");
  });

  it("merges provider and baseURL from file config", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", {
      llm: { provider: "openai", baseURL: "http://localhost:11435/v1", model: "qwen2.5:14b" }
    });
    expect(c.llm.provider).toBe("openai");
    expect(c.llm.baseURL).toBe("http://localhost:11435/v1");
    expect(c.llm.model).toBe("qwen2.5:14b");
  });

  it("defaults llm.reasoning to undefined and merges it from overrides", () => {
    expect(loadDaemonConfig("/nonexistent/config.json").llm.reasoning).toBeUndefined();
    const c = loadDaemonConfig("/nonexistent/config.json", {
      llm: { provider: "openai", reasoning: { effort: "minimal" } }
    });
    expect(c.llm.reasoning).toEqual({ effort: "minimal" });
  });

  it("accepts an empty llm.reasoning object", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", { llm: { reasoning: {} } });
    expect(c.llm.reasoning).toEqual({});
  });

  it.each([
    ["a string", "minimal"],
    ["an array", [1, 2]],
    ["null", null],
    ["a number", 3],
  ])("rejects llm.reasoning when it is %s", (_label, value) => {
    expect(() => loadDaemonConfig("/nonexistent/config.json", { llm: { reasoning: value } }))
      .toThrow(/llm\.reasoning must be a JSON object/);
  });

  it("accepts codex-process as a provider from file config", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", {
      llm: { provider: "codex-process" }
    });
    expect(c.llm.provider).toBe("codex-process");
  });

  it("does NOT inject ANTHROPIC_API_KEY when provider is openai", () => {
    const c = loadDaemonConfig("/nonexistent", { llm: { provider: "openai" } }, { ANTHROPIC_API_KEY: "sk-leaked" });
    expect(c.llm.apiKey).toBe("");
  });

  it("still injects ANTHROPIC_API_KEY when provider is anthropic", () => {
    const c = loadDaemonConfig("/nonexistent", { llm: { provider: "anthropic" } }, { ANTHROPIC_API_KEY: "sk-env" });
    expect(c.llm.apiKey).toBe("sk-env");
  });

  it("throws when provider resolves to 'anthropic' and apiKey is missing", () => {
    expect(() =>
      loadDaemonConfig("/nonexistent", { llm: { provider: "anthropic", apiKey: "" } }, {})
    ).toThrow("LCM_SUMMARY_API_KEY is required");
  });

  it("does not throw for 'anthropic' when apiKey is provided", () => {
    expect(() =>
      loadDaemonConfig("/nonexistent", { llm: { provider: "anthropic", apiKey: "sk-test" } }, {})
    ).not.toThrow();
  });

  it("does not throw for 'anthropic' when ANTHROPIC_API_KEY env var is set", () => {
    expect(() =>
      loadDaemonConfig("/nonexistent", { llm: { provider: "anthropic" } }, { ANTHROPIC_API_KEY: "sk-env" })
    ).not.toThrow();
  });

  it("LCM_SUMMARY_PROVIDER env var overrides config provider", () => {
    const c = loadDaemonConfig(
      "/nonexistent",
      { llm: { provider: "claude-process" } },
      { LCM_SUMMARY_PROVIDER: "openai" }
    );
    expect(c.llm.provider).toBe("openai");
  });

  it("accepts LCM_SUMMARY_PROVIDER=auto", () => {
    const c = loadDaemonConfig("/nonexistent", {}, { LCM_SUMMARY_PROVIDER: "auto" });
    expect(c.llm.provider).toBe("auto");
  });

  it("accepts session and fallbackProvider from a config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-session-config-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, JSON.stringify({ llm: { provider: "session", fallbackProvider: "openai" } }));
      const config = loadDaemonConfig(path, {}, {});
      expect(config.llm.provider).toBe("session");
      expect(config.llm.fallbackProvider).toBe("openai");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts LCM_SUMMARY_PROVIDER=session over the configured provider", () => {
    const config = loadDaemonConfig("/nonexistent", { llm: { provider: "openai" } }, { LCM_SUMMARY_PROVIDER: "session" });
    expect(config.llm.provider).toBe("session");
    expect(config.llm.fallbackProvider).toBeUndefined();
  });

  it.each(["auto", "claude-process", "codex-process", "copilot-process", "anthropic", "openai", "disabled"])(
    "accepts %s as a session fallback", (fallbackProvider) => {
      const config = loadDaemonConfig("/nonexistent", { llm: { provider: "session", fallbackProvider, apiKey: "sk-test" } }, {});
      expect(config.llm.fallbackProvider).toBe(fallbackProvider);
    },
  );

  it.each(["session", "ollama", "", null, 3, {}, []])("rejects invalid session fallback %j", (fallbackProvider) => {
    expect(() => loadDaemonConfig("/nonexistent", { llm: { provider: "session", fallbackProvider } }, {}))
      .toThrow("Invalid llm.fallbackProvider");
  });

  it("loads Anthropic credentials for an active session fallback", () => {
    const config = loadDaemonConfig("/nonexistent", { llm: { provider: "session", fallbackProvider: "anthropic" } }, { ANTHROPIC_API_KEY: "sk-env" });
    expect(config.llm.apiKey).toBe("sk-env");
  });

  it("requires credentials for an active Anthropic session fallback", () => {
    expect(() => loadDaemonConfig("/nonexistent", { llm: { provider: "session", fallbackProvider: "anthropic" } }, {}))
      .toThrow("LCM_SUMMARY_API_KEY is required");
  });

  it("does not inject Anthropic credentials for an inactive fallback", () => {
    const config = loadDaemonConfig("/nonexistent", { llm: { provider: "openai", fallbackProvider: "anthropic" } }, { ANTHROPIC_API_KEY: "sk-env" });
    expect(config.llm.apiKey).toBe("");
  });

  it("accepts copilot-process as a provider from file config", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", {
      llm: { provider: "copilot-process" }
    });
    expect(c.llm.provider).toBe("copilot-process");
  });

  it("accepts LCM_SUMMARY_PROVIDER=codex-process", () => {
    const c = loadDaemonConfig("/nonexistent", {}, { LCM_SUMMARY_PROVIDER: "codex-process" });
    expect(c.llm.provider).toBe("codex-process");
  });

  it("LCM_SUMMARY_PROVIDER=anthropic overrides provider with apiKey", () => {
    const c = loadDaemonConfig(
      "/nonexistent",
      { llm: { apiKey: "sk-test" } },
      { LCM_SUMMARY_PROVIDER: "anthropic" }
    );
    expect(c.llm.provider).toBe("anthropic");
  });

  it("throws when LCM_SUMMARY_PROVIDER is set to an invalid value", () => {
    expect(() =>
      loadDaemonConfig("/nonexistent", {}, { LCM_SUMMARY_PROVIDER: "ollama" })
    ).toThrow('Invalid LCM_SUMMARY_PROVIDER="ollama"');
  });

  it("includes autoCompactMinTokens default of 10000", () => {
    const c = loadDaemonConfig("/nonexistent/config.json");
    expect(c.compaction.autoCompactMinTokens).toBe(10000);
  });

  it("allows overriding autoCompactMinTokens", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", {
      compaction: { autoCompactMinTokens: 5000 },
    });
    expect(c.compaction.autoCompactMinTokens).toBe(5000);
  });

  it("allows disabling auto-compact with autoCompactMinTokens: 0", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", {
      compaction: { autoCompactMinTokens: 0 },
    });
    expect(c.compaction.autoCompactMinTokens).toBe(0);
  });

  it("still loads a config file that sets the removed leafTokens and maxDepth", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", {
      compaction: { leafTokens: 500, maxDepth: 9 },
    } as never);
    expect(c.compaction.autoCompactMinTokens).toBe(10000);
  });

  it("defaults security.sensitivePatterns to empty array", () => {
    const config = loadDaemonConfig("/nonexistent/config.json");
    expect(config.security).toEqual({ sensitivePatterns: [] });
  });

  it("merges user-defined sensitivePatterns from config file", () => {
    const c = loadDaemonConfig("/nonexistent/config.json", {
      security: { sensitivePatterns: ["MY_TOKEN_.*"] },
    });
    expect(c.security.sensitivePatterns).toEqual(["MY_TOKEN_.*"]);
  });

  it("loads hooks config with defaults", () => {
    const config = loadDaemonConfig("/nonexistent");
    expect(config.hooks).toEqual({
      snapshotIntervalSec: 60,
      disableAutoCompact: false,
    });
  });

  it("merges user-provided hooks config", () => {
    const config = loadDaemonConfig("/nonexistent", {
      hooks: { snapshotIntervalSec: 30 },
    });
    expect(config.hooks.snapshotIntervalSec).toBe(30);
    expect(config.hooks.disableAutoCompact).toBe(false);
  });

  it("allows overriding prompt hint budget settings", () => {
    const config = loadDaemonConfig("/nonexistent", {
      restoration: {
        promptHintsByteBudget: 3072,
        promptHintsReservedForLearningInstruction: 1400,
        promptHintsMaxEmitted: 5,
        promptHintsDedupMinPrefix: 80,
      },
    });
    expect(config.restoration.maxInjectedMemoryBytes).toBe(3072);
    expect(config.restoration.reservedForLearningInstruction).toBe(1400);
    expect(config.restoration.maxInjectedMemoryItems).toBe(5);
    expect(config.restoration.dedupMinPrefix).toBe(80);
  });

  it("prefers new config name over old name when both are present", () => {
    const config = loadDaemonConfig("/nonexistent", {
      restoration: {
        maxInjectedMemoryBytes: 4096,
        promptHintsByteBudget: 2048,
      },
    });
    expect(config.restoration.maxInjectedMemoryBytes).toBe(4096);
  });
});

describe("deepMerge", () => {
  it("rejects prototype pollution keys", () => {
    const source = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"name": "pwned"}}');
    const result = deepMerge({ a: 1 } as Record<string, unknown>, source);
    expect((({}) as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(false);
  });

  it("merges normal keys correctly", () => {
    const result = deepMerge({ a: 1, b: { c: 2 } } as Record<string, unknown>, { b: { d: 3 } } as Record<string, unknown>);
    expect(result.a).toBe(1);
    expect((result.b as any).c).toBe(2);
    expect((result.b as any).d).toBe(3);
  });
});
