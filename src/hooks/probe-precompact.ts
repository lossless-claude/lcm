#!/usr/bin/env node
// src/hooks/probe-precompact.ts
// Probe hook: dumps PreCompact stdin to ~/.lossless-claude/precompact-probe.json
// Install temporarily in ~/.claude/settings.json to verify hook input schema
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { lcmHome } from "../lcm-home.js";

const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => {
  const raw = Buffer.concat(chunks).toString("utf-8");
  const dir = lcmHome();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "precompact-probe.json"), raw);
  process.exit(0); // exit 0 = allow native compaction
});
