import { expect, it, vi } from "vitest";
import { buildSummaryPrompt, buildSummaryPromptWithSystem } from "../../src/llm/prompt.js";
import { buildClaudeArgs } from "../../src/llm/claude-process.js";
import { createOpenAISummarizer } from "../../src/llm/openai.js";
import { createAnthropicSummarizer } from "../../src/llm/anthropic.js";

const taskPrompt = "Return one specific recall question only.";
const source = "We chose SQLite for the daemon.";

it("process providers receive the alternate task without compaction instructions", () => {
  expect(buildSummaryPrompt(source, false, { taskPrompt })).toBe(source);
  expect(buildSummaryPromptWithSystem(source, false, { taskPrompt })).toBe(`${taskPrompt}\n\n${source}`);
  const args = buildClaudeArgs("test-model", taskPrompt);
  expect(args[args.indexOf("--system-prompt") + 1]).toBe(taskPrompt);
});

it("OpenAI-compatible requests contain only the alternate task and source", async () => {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: "Why did we choose SQLite?" } }] });
  const generate = createOpenAISummarizer({ model: "configured", baseURL: "http://local.test/v1", _clientOverride: { chat: { completions: { create } } } });
  await generate(source, false, { taskPrompt });
  expect(create.mock.calls[0][0].messages).toEqual([{ role: "user", content: `${taskPrompt}\n\n${source}` }]);
});

it("Anthropic uses the alternate system prompt on both initial and retry requests", async () => {
  const create = vi.fn().mockResolvedValueOnce({ content: [] }).mockResolvedValueOnce({ content: [{ type: "text", text: "Why did we choose SQLite?" }] });
  const generate = createAnthropicSummarizer({ model: "configured", apiKey: "test", _clientOverride: { messages: { create } } });
  await generate(source, false, { taskPrompt });
  expect(create).toHaveBeenCalledTimes(2);
  for (const [request] of create.mock.calls) {
    expect(request.system).toBe(taskPrompt);
    expect(request.messages).toEqual([{ role: "user", content: source }]);
  }
});
