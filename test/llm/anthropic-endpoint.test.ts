import { afterAll, beforeAll, expect, it } from "vitest";
import { createAnthropicSummarizer } from "../../src/llm/anthropic.js";
import { startChatCompletionsServer } from "../helpers/chat-completions-server.js";

let server: Awaited<ReturnType<typeof startChatCompletionsServer>>;
beforeAll(async () => { server = await startChatCompletionsServer(); });
afterAll(() => server.close());

it("sends the endpoint body to the configured baseURL, under the fields it generates", async () => {
  server.answer("anthropic", { status: 200, body: {
    id: "msg", type: "message", role: "assistant", model: "claude-test", stop_reason: "end_turn",
    content: [{ type: "text", text: "the summary" }], usage: { input_tokens: 10, output_tokens: 5 },
  } });
  const summarize = createAnthropicSummarizer({
    model: "claude-test", apiKey: "sk-ant", baseURL: `${server.base}/anthropic`,
    body: { thinking: { type: "disabled" }, model: "from-body", max_tokens: 1, system: "from-body", messages: [] },
  });

  await expect(summarize("conversation", false, {})).resolves.toBe("the summary");

  expect(server.seen).toHaveLength(1);
  const sent = server.seen[0].body;
  expect(sent.thinking).toEqual({ type: "disabled" });
  expect(sent.model).toBe("claude-test");
  expect(sent.max_tokens).toBeGreaterThanOrEqual(1024);
  expect(sent.system).not.toBe("from-body");
  expect(sent.messages).toHaveLength(1);
  expect(sent.messages[0].content).toContain("conversation");
});
