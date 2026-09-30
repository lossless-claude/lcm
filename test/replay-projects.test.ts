import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runReplayProjects } from "../src/replay-projects.js";

it("serializes path aliases of one project while another project runs concurrently", async () => {
  const root = mkdtempSync(join(tmpdir(), "lcm-replay-alias-"));
  const cwd = join(root, "project");
  const alias = join(root, "alias");
  const other = join(root, "other");
  mkdirSync(cwd);
  mkdirSync(other);
  symlinkSync(cwd, alias, "dir");
  const items = [{ cwd, sessionId: "first" }, { cwd: alias, sessionId: "second" }, { cwd: other, sessionId: "other" }];
  const gate = Promise.withResolvers<void>();
  const groups: typeof items[] = [];
  const finished: string[] = [];
  const run = runReplayProjects(items, (item) => item.cwd, 2, async (ordered) => {
    groups.push(ordered);
    await gate.promise;
    finished.push(...ordered.map((item) => item.sessionId));
  });
  try {
    expect(groups.map((ordered) => ordered[0].sessionId)).toEqual(["first", "other"]);
    expect(groups[0].map((item) => item.sessionId)).toEqual(["first", "second"]);
    gate.resolve();
    await run;
    expect(finished.indexOf("first")).toBeLessThan(finished.indexOf("second"));
  } finally {
    gate.resolve();
    await run;
    rmSync(root, { recursive: true, force: true });
  }
});
