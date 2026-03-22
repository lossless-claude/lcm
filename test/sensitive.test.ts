import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Mutable ref updated in beforeEach — lets the vi.mock factory redirect projectDir
// into the per-test temp dir so no writes touch the real ~/.lossless-claude/.
const _projectBase = vi.hoisted(() => ({ current: "" }));

vi.mock("../src/daemon/project.js", async () => {
  const { createHash: hash } = await import("node:crypto");
  const { join: j } = await import("node:path");
  return {
    projectDir: (cwd: string) => j(_projectBase.current, "projects", hash("sha256").update(cwd).digest("hex")),
    projectId: (cwd: string) => hash("sha256").update(cwd).digest("hex"),
    projectDbPath: (cwd: string) => j(_projectBase.current, "projects", hash("sha256").update(cwd).digest("hex"), "db.sqlite"),
    projectMetaPath: (cwd: string) => j(_projectBase.current, "projects", hash("sha256").update(cwd).digest("hex"), "meta.json"),
    ensureProjectDir: () => {},
  };
});

import { handleSensitive } from "../src/sensitive.js";
import { BUILT_IN_PATTERNS } from "../src/scrub.js";

describe("lcm sensitive", () => {
  let tempBase: string;
  let cwd: string;
  let configPath: string;
  let pDir: string;

  beforeEach(() => {
    tempBase = join(tmpdir(), `lcm-sensitive-${Math.random().toString(36).slice(2)}`);
    _projectBase.current = tempBase;
    cwd = join(tempBase, "project");
    mkdirSync(cwd, { recursive: true });
    configPath = join(tempBase, "config.json");

    const hash = createHash("sha256").update(cwd).digest("hex");
    pDir = join(tempBase, "projects", hash);
    mkdirSync(pDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true });
  });

  // --- list ---

  it("list: shows built-in patterns with [built-in] label", async () => {
    const r = await handleSensitive(["list"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    for (const p of BUILT_IN_PATTERNS) {
      expect(r.stdout).toContain(`[built-in]  ${p}`);
    }
  });

  it("list: shows project patterns with [user] label when file exists", async () => {
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "MY_SECRET_TOKEN_.*\n");
    const r = await handleSensitive(["list"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[user]      MY_SECRET_TOKEN_.*");
  });

  it("list: shows (none) when no project patterns", async () => {
    const r = await handleSensitive(["list"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("(none)");
  });

  it("list: shows global user patterns from config.json", async () => {
    writeFileSync(configPath, JSON.stringify({ security: { sensitivePatterns: ["CORP_TOKEN_.*"] } }, null, 2));
    const r = await handleSensitive(["list"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[user]      CORP_TOKEN_.*");
  });

  // --- add ---

  it("add: appends pattern to project file", async () => {
    const r = await handleSensitive(["add", "MY_API_KEY_.*"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Added project pattern: MY_API_KEY_.*");
    const content = readFileSync(join(pDir, "sensitive-patterns.txt"), "utf-8");
    expect(content).toContain("MY_API_KEY_.*");
  });

  it("add: is idempotent — does not duplicate pattern", async () => {
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "MY_API_KEY_.*\n");
    const r = await handleSensitive(["add", "MY_API_KEY_.*"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("already present");
    const content = readFileSync(join(pDir, "sensitive-patterns.txt"), "utf-8");
    const lines = content.split("\n").filter(Boolean);
    expect(lines.filter(l => l === "MY_API_KEY_.*")).toHaveLength(1);
  });

  it("add --global: appends to config.json sensitivePatterns", async () => {
    writeFileSync(configPath, JSON.stringify({ security: { sensitivePatterns: [] } }, null, 2));
    const r = await handleSensitive(["add", "--global", "CORP_SECRET_.*"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Added global pattern: CORP_SECRET_.*");
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(cfg.security.sensitivePatterns).toContain("CORP_SECRET_.*");
  });

  it("add --global: is idempotent — does not duplicate", async () => {
    writeFileSync(configPath, JSON.stringify({ security: { sensitivePatterns: ["CORP_SECRET_.*"] } }, null, 2));
    const r = await handleSensitive(["add", "--global", "CORP_SECRET_.*"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("already present");
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(cfg.security.sensitivePatterns.filter((p: string) => p === "CORP_SECRET_.*")).toHaveLength(1);
  });

  // --- remove ---

  it("remove: removes exact match from project file", async () => {
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "PAT_A\nPAT_B\n");
    const r = await handleSensitive(["remove", "PAT_A"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Removed project pattern: PAT_A");
    const content = readFileSync(join(pDir, "sensitive-patterns.txt"), "utf-8");
    expect(content).not.toContain("PAT_A");
    expect(content).toContain("PAT_B");
  });

  it("remove: prints error when pattern not found", async () => {
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "PAT_B\n");
    const r = await handleSensitive(["remove", "PAT_A"], cwd, configPath);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Pattern not found");
  });

  // --- test ---

  it("test: shows [REDACTED] for matching input", async () => {
    const r = await handleSensitive(["test", "sk-abcdefghijklmnopqrstuv"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("[REDACTED]");
  });

  it("test: shows original for non-matching input", async () => {
    const r = await handleSensitive(["test", "hello world"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("No patterns matched");
    expect(r.stdout).toContain("hello world");
  });

  // --- purge ---

  it("purge: requires --yes — exits 1 without it", async () => {
    const r = await handleSensitive(["purge"], cwd, configPath);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("--yes");
  });

  it("purge --yes: deletes project dir", async () => {
    writeFileSync(join(pDir, "sensitive-patterns.txt"), "FOO\n");
    expect(existsSync(pDir)).toBe(true);
    const r = await handleSensitive(["purge", "--yes"], cwd, configPath);
    expect(r.exitCode).toBe(0);
    expect(existsSync(pDir)).toBe(false);
  });
});
