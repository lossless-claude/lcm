#!/usr/bin/env node
// Test the daemon's /prompt-search endpoint directly
import http from "node:http";
const query = process.argv[2] || "summarizer";
const cwd = process.argv[3] || process.cwd();
const data = JSON.stringify({ query, cwd });

const req = http.request(
  {
    hostname: "127.0.0.1",
    port: 3737,
    path: "/prompt-search",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
  },
  (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => {
      console.log(`Status: ${res.statusCode}`);
      try {
        const parsed = JSON.parse(body);
        console.log(`Hints: ${parsed.hints?.length ?? 0}`);
        if (parsed.hints?.length > 0) {
          parsed.hints.forEach((h, i) => console.log(`  ${i + 1}. ${h.slice(0, 120)}`));
        }
      } catch {
        console.log(`Raw: ${body}`);
      }
    });
  }
);
req.on("error", (e) => console.log(`Error: ${e.message}`));
req.write(data);
req.end();
