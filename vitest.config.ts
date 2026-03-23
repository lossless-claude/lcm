import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".claude/**"],
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/e2e/**", "node_modules/**", ".claude/**"],
        },
      },
      {
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.ts"],
          exclude: ["node_modules/**", ".claude/**"],
          // E2E tests spin up real daemons backed by SQLite — must run
          // sequentially to avoid concurrent write conflicts.
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
        },
      },
    ],
  },
});
