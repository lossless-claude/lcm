import { runBench } from "../src/bench.js";
const file = process.argv[2];
const r = await runBench({ cwd: process.cwd(), benchFile: file, k: 5, json: true });
if (r.exitCode !== 0) { console.log("ERR", r.stdout.slice(0, 200)); process.exit(1); }
const rep = JSON.parse(r.stdout) as { total: number; searchHitRate: number; p95LatencyMs: number };
console.log(`${rep.searchHitRate.toFixed(3)}  n=${rep.total}  p95=${rep.p95LatencyMs}ms`);
