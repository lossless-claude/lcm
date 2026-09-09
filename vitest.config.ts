import { defineConfig } from "vitest/config";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  cacheDir: join(tmpdir(), "vitest-lcm-cache"),
  test: {
    projects: [
      {
        extends: false,
        root,
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/e2e/**", "node_modules/**", ".claude/**"],
          setupFiles: ["./test/setup-env.ts"],
        },
      },
      {
        extends: false,
        root,
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          exclude: ["node_modules/**", ".claude/**"],
          setupFiles: ["./test/setup-env.ts"],
          // E2E tests spin up real daemons backed by SQLite — must run
          // sequentially to avoid concurrent write conflicts.
          fileParallelism: false,
        },
      },
    ],
  },
});
