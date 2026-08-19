import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    runner: "benchmarks/runner.ts",
    "performance-acceptance": "benchmarks/performance-acceptance.ts",
    "navigator-tree-scale": "benchmarks/navigator-tree-scale.ts",
    "vault-scale-corpus": "benchmarks/vault-scale-corpus.ts",
    "vault-scale-kernel": "benchmarks/vault-scale-kernel.ts",
    "workspace-open-diagnostics": "benchmarks/workspace-open-diagnostics.ts",
  },
  outDir: ".bench-dist",
  format: ["cjs"],
  platform: "node",
  target: "node22",
  external: ["node:sqlite"],
  clean: true,
  splitting: false,
  sourcemap: false,
  minify: false,
});
