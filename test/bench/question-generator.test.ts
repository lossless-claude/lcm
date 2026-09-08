import { beforeEach, expect, it, vi } from "vitest";
import { configuredLanguageDetector, configuredQuestionGenerator, parseLanguageTag } from "../../src/bench.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createSummarizer, resolveEffectiveProvider } from "../../src/daemon/summarizer.js";

vi.mock("../../src/daemon/config.js", () => ({ loadDaemonConfig: vi.fn() }));
vi.mock("../../src/daemon/summarizer.js", () => ({ createSummarizer: vi.fn(), resolveEffectiveProvider: vi.fn() }));

beforeEach(() => { vi.resetAllMocks(); });

function mockProvider(reply: string) {
  const config = { llm: { provider: "openai", baseURL: "http://local.test/v1", model: "configured-model" } };
  vi.mocked(loadDaemonConfig).mockReturnValue(config as ReturnType<typeof loadDaemonConfig>);
  vi.mocked(resolveEffectiveProvider).mockReturnValue("openai");
  const summarize = vi.fn().mockResolvedValue(reply);
  vi.mocked(createSummarizer).mockResolvedValue(summarize);
  return { config, summarize };
}

it("uses the configured provider and endpoint for generation", async () => {
  const { config, summarize } = mockProvider("Why did the daemon use a local database?");
  const generate = await configuredQuestionGenerator("en");
  expect(await generate("We chose SQLite for the daemon.")).toBe("Why did the daemon use a local database?");
  expect(createSummarizer).toHaveBeenCalledWith("openai", config);
  expect(summarize.mock.calls[0][0]).toContain("We chose SQLite for the daemon.");
  expect(summarize.mock.calls[0][2].taskPrompt).toContain("return only the question");
});

it("tells the generator which language to write in, whatever the prompt's language", async () => {
  const { summarize } = mockProvider("Por que o daemon usou um banco local?");
  const generate = await configuredQuestionGenerator("pt-BR");
  await generate("We chose SQLite for the daemon.");
  const taskPrompt = summarize.mock.calls[0][2].taskPrompt as string;
  expect(taskPrompt).toContain('language tagged "pt-BR"');
  expect(taskPrompt).toMatch(/even when the supplied prompt is written in another language/);
});

it("rejects a disabled provider instead of switching generators", async () => {
  vi.mocked(loadDaemonConfig).mockReturnValue({ llm: { provider: "disabled" } } as ReturnType<typeof loadDaemonConfig>);
  vi.mocked(resolveEffectiveProvider).mockReturnValue("disabled");
  vi.mocked(createSummarizer).mockResolvedValue(null);
  await expect(configuredQuestionGenerator("en")).rejects.toThrow("enabled summarizer");
});

it("reads the corpus language from a numbered sample of human turns", async () => {
  const { summarize } = mockProvider("pt-BR\n");
  const detect = await configuredLanguageDetector();
  expect(await detect(["Bora revisar o daemon?", "O teste quebrou de novo."])).toBe("pt-BR");
  expect(summarize.mock.calls[0][0]).toContain("1. Bora revisar o daemon?");
  expect(summarize.mock.calls[0][0]).toContain("2. O teste quebrou de novo.");
  expect(summarize.mock.calls[0][2].taskPrompt).toContain("BCP 47");
});

it("treats a detector reply that is not a bare tag as unsure", async () => {
  expect(parseLanguageTag(" `pt-BR` ")).toBe("pt-BR");
  expect(parseLanguageTag("en.")).toBe("en");
  expect(parseLanguageTag("PT_br")).toBe("pt-BR");
  expect(parseLanguageTag("The person writes in Portuguese.")).toBeNull();
  expect(parseLanguageTag("")).toBeNull();
  mockProvider("Portuguese, Brazilian variant.");
  const detect = await configuredLanguageDetector();
  expect(await detect(["Bora revisar o daemon?"])).toBeNull();
});
