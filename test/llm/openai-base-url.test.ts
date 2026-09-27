import { beforeEach, describe, expect, it, vi } from "vitest";

const { clientOptions } = vi.hoisted(() => ({ clientOptions: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: vi.fn() } };
    constructor(options: Record<string, unknown>) { clientOptions(options); }
  },
}));
import { loadDaemonConfig } from "../../src/daemon/config.js";
import { createSummarizer, resolveEffectiveProvider } from "../../src/daemon/summarizer.js";

async function clientOptionsFor(llm: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = loadDaemonConfig("/nonexistent", { llm }, {});
  await createSummarizer(resolveEffectiveProvider(config), config);
  expect(clientOptions).toHaveBeenCalledOnce();
  return clientOptions.mock.calls[0][0];
}

// An absent baseURL must reach the SDK as absent: only then does it apply its own
// default (OPENAI_BASE_URL, else the OpenAI API) instead of an empty override.
describe("the openai endpoint's baseURL", () => {
  beforeEach(() => clientOptions.mockClear());

  it("is left out of the client options when a named endpoint omits it", async () => {
    const options = await clientOptionsFor({ provider: "vendor", providers: { vendor: { type: "openai", model: "m" } } });
    expect(options).not.toHaveProperty("baseURL");
  });

  it("is left out when the flat form leaves llm.baseURL unset", async () => {
    const options = await clientOptionsFor({ provider: "openai", model: "m" });
    expect(options).not.toHaveProperty("baseURL");
  });

  it("is passed through when configured", async () => {
    const options = await clientOptionsFor({ provider: "vendor", providers: {
      vendor: { type: "openai", model: "m", baseURL: "http://127.0.0.1:9/v1" } } });
    expect(options.baseURL).toBe("http://127.0.0.1:9/v1");
  });
});
