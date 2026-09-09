import { describe, it, expect } from "vitest";
import pkg from "../package.json";

describe("package.json", () => {
  it("has correct name", () => expect(pkg.name).toBe("@lossless-claude/lcm"));
  it("has bin entry", () => expect(pkg.bin).toHaveProperty("lcm"));
  it("has anthropic sdk as optional peer dep", () => expect(pkg.peerDependencies).toHaveProperty("@anthropic-ai/sdk"));
  it("has mcp server sdk v2", () => expect(pkg.dependencies).toHaveProperty("@modelcontextprotocol/server", "^2.0.0"));
  it("does not have pi-ai", () => expect(pkg.dependencies).not.toHaveProperty("@mariozechner/pi-ai"));
  it("does not have pi-agent-core", () => expect(pkg.dependencies).not.toHaveProperty("@mariozechner/pi-agent-core"));

  it("does not use prepack (breaks npm install from git without node_modules)", () => {
    expect(pkg.scripts).not.toHaveProperty("prepack");
  });

  it("uses prepublishOnly for build (only runs during npm publish)", () => {
    expect(pkg.scripts).toHaveProperty("prepublishOnly", "npm run build");
  });

  it("ships mcp.mjs as a fallback MCP entrypoint", () => {
    expect(pkg.files).toContain("mcp.mjs");
  });
});
