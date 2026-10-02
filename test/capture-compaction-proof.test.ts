import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it } from "vitest";
import { SessionCapture } from "../src/capture.js";
import { WorkerStore } from "../src/store/worker-store.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ScrubEngine } from "../src/scrub.js";

// This test file's composition root owns an isolated real store.
const db = new DatabaseSync(":memory:");
runLcmMigrations(db);
const capture = new SessionCapture(db, "proof", new ScrubEngine([], []));
afterAll(() => db.close());

  it("does not verify Capture when a copied worker claim refuses the write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lcm-refused-proof-"));
    try {
      new WorkerStore(db).recordIssuedJob("issued");
      const path = join(dir, "s1.jsonl");
      writeFileSync(path, [
        { uuid: "claim", message: { role: "assistant", content: [{ type: "tool_use", id: "call", name: "lcm_summarize_claim", input: {} }] } },
        { uuid: "result", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: JSON.stringify({ job: { id: "issued", prompt: "private", system: "private" } }) }] } },
      ].map(r => JSON.stringify(r)).join("\n") + "\n");
      const result = await capture.captureTranscript({ sessionId: "s1", cwd: dir, transcriptPath: path,
        requireComplete: true, captureThroughUuid: "result" });
      expect(result?.verification?.verified).toBe(false);
      expect(await capture.conversationStore.getSessionMessages("s1")).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
