import { beforeEach, expect, it, vi } from "vitest";
import { configuredQuestionGenerator } from "../../src/bench.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createSummarizer, resolveEffectiveProvider } from "../../src/daemon/summarizer.js";

vi.mock("../../src/daemon/config.js", () => ({ loadDaemonConfig: vi.fn() }));
vi.mock("../../src/daemon/summarizer.js", () => ({ createSummarizer: vi.fn(), resolveEffectiveProvider: vi.fn() }));

beforeEach(() => { vi.resetAllMocks(); });

it("uses the configured provider and endpoint for generation", async () => {
  const config = { llm: { provider: "openai", baseURL: "http://local.test/v1", model: "configured-model" } };
  vi.mocked(loadDaemonConfig).mockReturnValue(config as ReturnType<typeof loadDaemonConfig>);
  vi.mocked(resolveEffectiveProvider).mockReturnValue("openai");
  const summarize = vi.fn().mockResolvedValue("Why did the daemon use a local database?");
  vi.mocked(createSummarizer).mockResolvedValue(summarize);
  const generate = await configuredQuestionGenerator();
  expect(await generate("We chose SQLite for the daemon.")).toBe("Why did the daemon use a local database?");
  expect(createSummarizer).toHaveBeenCalledWith("openai", config);
  expect(summarize.mock.calls[0][0]).toContain("We chose SQLite for the daemon.");
  expect(summarize.mock.calls[0][2].taskPrompt).toContain("return only the question");
});

it("rejects a disabled provider instead of switching generators", async () => {
  vi.mocked(loadDaemonConfig).mockReturnValue({ llm: { provider: "disabled" } } as ReturnType<typeof loadDaemonConfig>);
  vi.mocked(resolveEffectiveProvider).mockReturnValue("disabled");
  vi.mocked(createSummarizer).mockResolvedValue(null);
  await expect(configuredQuestionGenerator()).rejects.toThrow("enabled summarizer");
});
