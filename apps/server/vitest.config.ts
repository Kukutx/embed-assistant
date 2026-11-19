import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // API test files share one Postgres database, so they run one after another.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
