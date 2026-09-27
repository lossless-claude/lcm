import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadDaemonConfig } from "../../src/daemon/config.js";

const dir = mkdtempSync(join(tmpdir(), "lcm-provider-config-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Loads `llm` from a real config file, parsed the way the daemon parses it. */
function load(llmJson: string, env: Record<string, string> = { DS: "sk-ds", OR: "sk-or" }) {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, `{ "llm": ${llmJson} }`);
  return loadDaemonConfig(path, undefined, env);
}

const DEEPSEEK = `"deepseek": { "type": "openai", "model": "deepseek-chat", "baseURL": "https://api.deepseek.com", "apiKey": "\${DS}" }`;
const OPENROUTER = `"openrouter": { "type": "openai", "model": "vendor/flash", "baseURL": "https://openrouter.ai/api/v1", "apiKey": "\${OR}" }`;

function withBody(body: string): string {
  return `{ "provider": "deepseek", "providers": { "deepseek": { "type": "openai", "model": "m", "body": ${body} } } }`;
}

describe("llm.providers", () => {
  it("loads named endpoints with their own expanded keys and an ordered fallback", () => {
    const config = load(`{ "provider": "session", "fallback": ["deepseek", "openrouter"], "providers": { ${DEEPSEEK}, ${OPENROUTER} } }`);
    expect(config.llm.provider).toBe("session");
    expect(config.llm.fallback).toEqual(["deepseek", "openrouter"]);
    expect(config.llm.providers).toMatchObject({ deepseek: { apiKey: "sk-ds" }, openrouter: { apiKey: "sk-or" } });
  });

  it.each(["model", "messages", "system", "stream", "stream_options", "max_tokens", "max_completion_tokens",
    "n", "tools", "tool_choice", "response_format", "usage"])("rejects %s in a body: lcm generates it", (field) => {
    expect(() => load(withBody(`{ "${field}": 1 }`))).toThrow(new RegExp(`llm\\.providers\\.deepseek\\.body\\.${field}`));
  });

  it.each([
    ["at the top", `{ "__proto__": { "polluted": true } }`],
    ["nested", `{ "extra": { "constructor": { "prototype": {} } } }`],
    ["inside an array", `{ "extra": [ { "__proto__": {} } ] }`],
  ])("rejects a prototype key %s of a body", (_where, body) => {
    expect(() => load(withBody(body))).toThrow(/prototype key/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("rejects a body that is not a JSON object", () => {
    expect(() => load(withBody(`[1]`))).toThrow(/body must be a JSON object/);
  });

  it("rejects connection fields on a process endpoint", () => {
    expect(() => load(`{ "provider": "claude", "providers": { "claude": { "type": "claude-process", "apiKey": "x" } } }`))
      .toThrow(/llm\.providers\.claude\.apiKey does not apply to claude-process/);
  });

  it("rejects an unknown endpoint field, pointing at body", () => {
    expect(() => load(`{ "provider": "deepseek", "providers": { "deepseek": { "type": "openai", "model": "m", "temperature": 0 } } }`))
      .toThrow(/temperature.*body/);
  });

  it.each([
    ["model", `"model": "m"`],
    ["baseURL", `"baseURL": "https://x"`],
    ["apiKey", `"apiKey": "k"`],
    ["reasoning", `"reasoning": { "effort": "minimal" }`],
    ["fallbackProvider", `"fallbackProvider": "openai"`],
  ])("rejects the flat llm.%s next to llm.providers", (field, json) => {
    expect(() => load(`{ "provider": "deepseek", ${json}, "providers": { ${DEEPSEEK} } }`)).toThrow(new RegExp(`llm\\.${field}`));
  });

  it("rejects a fallback naming no endpoint, a repeated link and a reserved endpoint name", () => {
    expect(() => load(`{ "provider": "deepseek", "fallback": ["missing"], "providers": { ${DEEPSEEK} } }`)).toThrow(/"missing"/);
    expect(() => load(`{ "provider": "deepseek", "fallback": ["deepseek"], "providers": { ${DEEPSEEK} } }`)).toThrow(/more than once/);
    expect(() => load(`{ "provider": "openai", "providers": { "openai": { "type": "openai", "model": "m" } } }`)).toThrow(/reserved/);
  });

  it("rejects a key referencing an unset environment variable", () => {
    expect(() => load(`{ "provider": "deepseek", "providers": { ${DEEPSEEK} } }`, {})).toThrow(/DS.*not set/);
  });

  it("rejects llm.fallback without llm.providers", () => {
    expect(() => load(`{ "provider": "openai", "fallback": ["openrouter"] }`)).toThrow(/llm\.fallback needs llm\.providers/);
  });
});

describe("LCM_SUMMARY_PROVIDER with llm.providers", () => {
  const llm = `{ "provider": "deepseek", "providers": { ${DEEPSEEK}, ${OPENROUTER} } }`;

  it("accepts an endpoint name and the built-in session, auto and disabled", () => {
    for (const value of ["openrouter", "session", "auto", "disabled"]) {
      expect(load(llm, { DS: "a", OR: "b", LCM_SUMMARY_PROVIDER: value }).llm.provider).toBe(value);
    }
  });

  it("resolves a provider type only when one endpoint has it", () => {
    const single = `{ "providers": { ${DEEPSEEK}, "claude": { "type": "claude-process" } } }`;
    expect(load(single, { DS: "a", LCM_SUMMARY_PROVIDER: "openai" }).llm.provider).toBe("deepseek");
    expect(() => load(llm, { DS: "a", OR: "b", LCM_SUMMARY_PROVIDER: "openai" })).toThrow(/2 endpoints/);
  });

  it("rejects a name that is neither an endpoint nor built in", () => {
    expect(() => load(llm, { DS: "a", OR: "b", LCM_SUMMARY_PROVIDER: "nope" })).toThrow(/LCM_SUMMARY_PROVIDER/);
  });
});
