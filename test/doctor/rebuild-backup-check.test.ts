import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLcmPaths } from "../../src/lcm-paths.js";
import { checkRebuildBackups } from "../../src/doctor/rebuild-backup-check.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("checkRebuildBackups", () => {
  it("warns when a project keeps more than one backup, with count, size and a removal hint", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-backup-doctor-"));
    roots.push(root);
    const paths = createLcmPaths(root);
    const first = join(paths.projectsDir, "first");
    const second = join(paths.projectsDir, "second");
    mkdirSync(first, { recursive: true });
    mkdirSync(second);
    writeFileSync(join(first, "db.sqlite.bak-rebuild-2026-01-01T00-00-00-000Z"), "1234");
    writeFileSync(join(first, "db.sqlite.bak-rebuild-2026-01-02T00-00-00-000Z"), "123456");
    writeFileSync(join(second, "db.sqlite.bak-rebuild-2026-01-03T00-00-00-000Z"), "12");
    writeFileSync(join(second, "db.sqlite.backup"), "ignore");

    const result = checkRebuildBackups(paths);
    expect(result.status).toBe("warn");
    expect(result.message).toContain(`${first}: 2 backups, 0.0 MB`);
    expect(result.message).toContain(`${second}: 1 backup, 0.0 MB`);
    expect(result.message).toContain("db.sqlite.bak-rebuild-*");
    expect(result.message).toContain("Remove");
  });

  it("passes while each project keeps only the one backup retention leaves", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-backup-doctor-"));
    roots.push(root);
    const paths = createLcmPaths(root);
    const only = join(paths.projectsDir, "only");
    mkdirSync(only, { recursive: true });
    writeFileSync(join(only, "db.sqlite.bak-rebuild-2026-01-03T00-00-00-000Z"), "x".repeat(2_500_000));
    const result = checkRebuildBackups(paths);
    expect(result.status).toBe("pass");
    expect(result.message).toContain(`${only}: 1 backup, 2.5 MB`);
  });

  it("passes when no rebuild backups exist", () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-backup-doctor-"));
    roots.push(root);
    expect(checkRebuildBackups(createLcmPaths(root)).status).toBe("pass");
  });
});
