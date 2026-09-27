import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One request an OpenAI-compatible endpoint received. */
export type SeenRequest = { endpoint: string; authorization?: string; body: Record<string, any> };
export type Reply = { status: number; body: unknown };

/** A chat completion answer, as an OpenAI-compatible server sends it. */
export function completion(content: string, finishReason = "stop", model = "served-model"): Reply {
  return {
    status: 200,
    body: {
      id: "cmpl", object: "chat.completion", created: 0, model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 },
    },
  };
}

export function httpError(status: number, message = `status ${status}`): Reply {
  return { status, body: { error: { message, type: "invalid_request_error" } } };
}

/**
 * Several OpenAI-compatible endpoints on one local port, told apart by the first
 * path segment: `${base}/deepseek` and `${base}/openrouter` are two endpoints.
 * Each endpoint answers with its `answer` function; every request is recorded.
 */
export async function startChatCompletionsServer() {
  const seen: SeenRequest[] = [];
  const answers = new Map<string, (request: SeenRequest) => Reply>();
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const endpoint = (req.url ?? "").split("/")[1] ?? "";
      const request: SeenRequest = { endpoint, authorization: req.headers.authorization, body: JSON.parse(raw || "{}") };
      seen.push(request);
      const reply = answers.get(endpoint)?.(request) ?? httpError(404, `no endpoint ${endpoint}`);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    seen,
    answer(endpoint: string, reply: Reply | ((request: SeenRequest) => Reply)) {
      answers.set(endpoint, typeof reply === "function" ? reply : () => reply);
    },
    reset() { seen.length = 0; answers.clear(); },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
