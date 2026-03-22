import { describe, it, expect } from "vitest";
import { loadDaemonConfig } from "../../src/daemon/config.js";

describe("loadDaemonConfig", () => {
  it("returns defaults when no config file exists", () => {
    const c = loadDaemonConfig("/nonexistent/config.json");
    expect(c.daemon.port).toBe(3737);
    expect(c.daemon.socketPath).toContain("daemon.sock");
    expect(c.llm.provider).toBe("auto");
    expect(c.llm.model).toBe("");
    expect(c.compaction.leafTokens).toBe(1000);
    expect(c.restoration.recentSummaries).toBe(3);
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
});
