import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

it("opens every writable project handle through the configured connection factory", () => {
  const offenders = readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".ts"))
    .flatMap(entry => {
      const path = join(entry.parentPath, entry.name);
      if (path === join(root, "src", "db", "connection.ts")) return [];
      return readFileSync(path, "utf8").split("\n").flatMap((line, index) =>
        /new DatabaseSync\(/.test(line) && !/readOnly: true|groupIndexPath\(paths\)|["']:memory:["']/.test(line)
          ? [`${relative(root, path)}:${index + 1}`] : []);
    });
  expect(offenders).toEqual([]);
});
