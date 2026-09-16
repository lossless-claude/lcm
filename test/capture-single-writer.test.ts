import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = join(import.meta.dirname, "..", "src", "daemon", "routes");

/**
 * Transcript content reaches `messages` through `src/capture.ts` and nowhere
 * else (#503). A route that inserted messages itself would decide on its own
 * what "already stored" means and which sibling rows accompany a message.
 */
describe("routes never insert messages themselves", () => {
  it("no file under src/daemon/routes/ calls createMessagesBulk or createMessage", () => {
    const offenders = readdirSync(ROUTES_DIR)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => /\bcreateMessage(?:sBulk)?\(/.test(readFileSync(join(ROUTES_DIR, name), "utf-8")));
    expect(offenders).toEqual([]);
  });
});
