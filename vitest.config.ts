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

// Linux is the supported local-first lane and runs every filesystem integration test. Unsigned
// contributor packages on macOS and Windows cannot provide Linux's no-replace publication
// primitive, and their default filesystems collapse case/Unicode aliases before Threadleaf can
// exercise its own collision policy. Keep the rest of the source suite live on those hosts, then
// prove each package with its native runtime and installer lifecycle gates.
const contributorPlatformExclusions =
  process.env.THREADLEAF_CONTRIBUTOR_PLATFORM_TESTS === "1"
    ? [
        "src/application/attachment-move.test.ts",
        "src/application/attachment-relink.test.ts",
        "src/application/workspace-runtime.test.ts",
        "src/kernel/excalidraw-roundtrip.test.ts",
        "src/main/theme-package-manager.test.ts",
        "src/runtime/obsidian-metadata-link-yaml.test.ts",
        "src/runtime/obsidian-runtime-ledger-evidence.test.ts",
      ]
    : [];

export default defineConfig({
  test: {
    environment: "node",
    // Above the bounded rejecting waits (15s) so their named rejections win
    // the race against the harness default under machine load.
    testTimeout: 20_000,
    include: ["src/**/*.test.ts", "benchmarks/**/*.test.ts"],
    exclude: contributorPlatformExclusions,
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
