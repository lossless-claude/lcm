#!/usr/bin/env node
// src/hooks/probe-sessionstart.ts
// Probe hook: appends SessionStart stdin to ~/.lossless-claude/sessionstart-probe.jsonl
// Install temporarily to verify source field values (especially "compact")
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf-8");
  const dir = join(homedir(), ".lossless-claude");
  mkdirSync(dir, { recursive: true });
  const entry = `${new Date().toISOString()} ${raw}\n`;
  appendFileSync(join(dir, "sessionstart-probe.jsonl"), entry);
  process.exit(0);
});
