import { afterAll, beforeAll, expect, it, vi } from "vitest";

const { claude } = vi.hoisted(() => ({ claude: vi.fn() }));
vi.mock("../../src/llm/claude-process.js", () => ({ createClaudeProcessSummarizer: () => claude }));
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createSummarizer, resolveEffectiveProvider } from "../../src/daemon/summarizer.js";
import { completion, startChatCompletionsServer } from "../helpers/chat-completions-server.js";

let server: Awaited<ReturnType<typeof startChatCompletionsServer>>;
beforeAll(async () => { server = await startChatCompletionsServer(); });
afterAll(() => server.close());

it("moves past a process endpoint whose answer holds only whitespace, keeping its usage", async () => {
  claude.mockImplementation(async (_text: string, _aggressive: boolean, ctx: any) => {
    ctx.onUsage?.({ provider: "claude-process", model: "haiku", tokensUsed: 40 });
    return " \n ";
  });
  server.answer("local", completion("the summary"));
  const config = loadDaemonConfig("/nonexistent", { llm: { provider: "claude", fallback: ["local"], providers: {
    claude: { type: "claude-process" },
    local: { type: "openai", model: "m", baseURL: `${server.base}/local` },
  } } }, {});
  const summarize = (await createSummarizer(resolveEffectiveProvider(config), config))!;
  const onUsage = vi.fn();
  const onFallback = vi.fn();

  await expect(summarize("conversation", false, { onUsage, onFallback })).resolves.toBe("the summary");

  expect(onFallback).toHaveBeenCalledExactlyOnceWith({ reason: expect.stringContaining("summary rejected: claude"), toProvider: "local" });
  expect(onUsage.mock.calls.map(([usage]) => usage.provider)).toEqual(["claude", "local"]);
  expect(server.seen.map((request) => request.endpoint)).toEqual(["local"]);
});
