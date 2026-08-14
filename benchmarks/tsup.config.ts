import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    runner: "benchmarks/runner.ts",
    "vault-scale-corpus": "benchmarks/vault-scale-corpus.ts",
    "vault-scale-kernel": "benchmarks/vault-scale-kernel.ts",
    "workspace-open-diagnostics": "benchmarks/workspace-open-diagnostics.ts",
  },
  outDir: ".bench-dist",
  format: ["cjs"],
  platform: "node",
  target: "node22",
  clean: true,
  splitting: false,
  sourcemap: false,
  minify: false,
});
