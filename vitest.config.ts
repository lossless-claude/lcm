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
          setupFiles: ["./test/setup-dist.ts", "./test/setup-env.ts"],
          // CI machines are shared: setup-heavy tests that take 1–3 s
          // idle exceed vitest's 5 s default under load. A real hang still fails.
          // Hooks do the same setup (databases, daemons, fixtures), so they get
          // the same 20 s instead of vitest's 10 s hook default.
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        extends: false,
        root,
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          exclude: ["node_modules/**", ".claude/**"],
          setupFiles: ["./test/setup-dist.ts", "./test/setup-env.ts"],
          // E2E tests spin up real daemons backed by SQLite — must run
          // sequentially to avoid concurrent write conflicts.
          fileParallelism: false,
          // Their hooks start those daemons: the unit project's 20 s, for the same reason.
          hookTimeout: 20_000,
        },
      },
    ],
  },
});
