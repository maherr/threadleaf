import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Above the bounded rejecting waits (15s) so their named rejections win
    // the race against the harness default under machine load.
    testTimeout: 20_000,
    include: ["src/**/*.test.ts", "benchmarks/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
