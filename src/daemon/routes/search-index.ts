import type { QmdClient } from "../../search/qmd-client.js";
import { sendJson, type RouteHandler } from "../server.js";
import { validateCwd } from "../validate-cwd.js";

export function createSearchIndexHandler(qmd: Pick<QmdClient, "index">): RouteHandler {
  return async (_req, res, body) => {
    let cwd: string;
    let embed: boolean;
    let timeoutMs: number | undefined;
    try {
      const input = JSON.parse(body || "{}");
      if (input.embed !== undefined && typeof input.embed !== "boolean") {
        throw new Error("embed must be a boolean");
      }
      cwd = validateCwd(input.cwd);
      embed = input.embed ?? false;
      timeoutMs = input.timeoutMs;
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000)) {
        throw new Error("timeoutMs must be an integer from 1 to 86400000");
      }
    } catch {
      sendJson(res, 400, { error: "A valid cwd, optional boolean embed and timeoutMs from 1 to 86400000 are required" });
      return;
    }
    const result = await qmd.index({ cwd, embed, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    sendJson(res, 200, { backend: "qmd", ...result });
  };
}
