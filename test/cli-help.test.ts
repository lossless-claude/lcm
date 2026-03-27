import { describe, it, expect, vi, afterEach } from "vitest";
import { printHelp } from "../src/cli-help.js";

describe("printHelp — full reference", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("writes to stdout and includes header", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp();
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm — lossless context management for Claude Code");
    expect(text).toContain("Usage: lcm <command> [options]");
  });

  it("lists all groups", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp();
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("Setup");
    expect(text).toContain("Runtime");
    expect(text).toContain("Memory");
    expect(text).toContain("Connectors");
    expect(text).toContain("Sensitive");
    expect(text).toContain("Hooks (internal)");
    expect(text).toContain("post-tool");
  });

  it("includes version and help flags", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp();
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("-V, --version");
    expect(text).toContain("--help");
  });
});

describe("printHelp — per-command detail", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("prints compact command help", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("compact");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm compact");
    expect(text).toContain("--all");
    expect(text).toContain("--dry-run");
    expect(text).toContain("--replay");
    expect(text).toContain("Examples:");
  });

  it("prints sensitive command help with purge warning", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("sensitive");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("IRREVERSIBLY");
    expect(text).toContain("--global");
  });

  it("routes unknown command to stderr + full help, not silent fallthrough", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("not-a-real-command");
    const errText = err.mock.calls.map(c => c[0]).join("");
    const outText = out.mock.calls.map(c => c[0]).join("");
    expect(errText).toContain("Unknown command: not-a-real-command");
    expect(outText).toContain("lcm — lossless context management for Claude Code");
  });

  it("prints hook command help (restore)", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("restore");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm restore");
    expect(text).toContain("SessionStart");
  });

  it("prints hook command help (post-tool)", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("post-tool");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm post-tool");
    expect(text).toContain("PostToolUse");
  });

  it("prints mcp command help", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    printHelp("mcp");
    const text = out.mock.calls.map(c => c[0]).join("");
    expect(text).toContain("lcm mcp");
    expect(text).toContain("MCP server");
  });
});
