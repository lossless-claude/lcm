import { expect, it, vi } from "vitest";
import { createAnthropicSummarizer } from "../../src/llm/anthropic.js";
import { createOpenAISummarizer } from "../../src/llm/openai.js";

const adapters = [
  { provider: "openai", reason: "length", create: (text: string, outputTokens?: number) => createOpenAISummarizer({
    model: "configured-model", label: "endpoint", _clientOverride: { chat: { completions: { create: async () => ({
      model: "served-model", choices: [{ finish_reason: "length", message: { content: text } }],
      ...(outputTokens === undefined ? {} : { usage: { prompt_tokens: 100, completion_tokens: outputTokens } }),
    }) } } },
  }) },
  { provider: "anthropic", reason: "max_tokens", create: (text: string, outputTokens?: number) => createAnthropicSummarizer({
    model: "configured-model", label: "endpoint", apiKey: "test", _clientOverride: { messages: { create: async () => ({
      model: "served-model", stop_reason: "max_tokens", content: [{ type: "text", text }],
      ...(outputTokens === undefined ? {} : { usage: { input_tokens: 100, output_tokens: outputTokens } }),
    }) } },
  }) },
];

it.each(adapters)("$provider reports a looping cut without retaining input or output text", async ({ reason, create }) => {
  const text = "PRIVATE answer phrase repeating forever ".repeat(100);
  const onCut = vi.fn();
  const summarize = create(text, 2_000);

  await expect(summarize("PRIVATE source content", false, { maxOutputTokens: 2_048, onCut }))
    .rejects.toMatchObject({ name: "SummaryRejectedError", reason });

  expect(onCut).toHaveBeenCalledExactlyOnceWith({
    provider: "endpoint", model: "served-model", reason, maxOutputTokens: 2_048,
    outputTokens: 2_000, tailRepetition: expect.any(Number),
  });
  expect(onCut.mock.calls[0][0].tailRepetition).toBeGreaterThan(0.9);
  expect(JSON.stringify(onCut.mock.calls)).not.toMatch(/PRIVATE|phrase|content|forever/);
});

it.each(adapters)("$provider leaves unreported output tokens unknown and measures the tail", async ({ create }) => {
  const text = "prefix prefix prefix prefix ".repeat(500)
    + Array.from({ length: 300 }, (_, i) => `unique-${i}`).join(" ");
  const onCut = vi.fn();

  await expect(create(text)("source", false, { onCut })).rejects.toHaveProperty("name", "SummaryRejectedError");

  expect(onCut).toHaveBeenCalledOnce();
  expect(onCut.mock.calls[0][0]).toMatchObject({ outputTokens: undefined, tailRepetition: 0 });
});
