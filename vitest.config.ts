import { realpathSync } from "node:fs";
import os from "node:os";
import { defineConfig } from "vitest/config";

// macOS exposes its temp tree through /var while realpath resolves /private/var. Tests that
// exercise exact filesystem authority must start from one canonical spelling on every host.
const canonicalTestTemporaryDirectory = realpathSync(os.tmpdir());
process.env.TMPDIR = canonicalTestTemporaryDirectory;
if (process.platform === "win32") {
  process.env.TEMP = canonicalTestTemporaryDirectory;
  process.env.TMP = canonicalTestTemporaryDirectory;
}

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
