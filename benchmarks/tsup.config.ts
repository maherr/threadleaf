import { defineConfig } from "tsup";

export default defineConfig({
  entry: { runner: "benchmarks/runner.ts" },
  outDir: ".bench-dist",
  format: ["cjs"],
  platform: "node",
  target: "node22",
  clean: true,
  splitting: false,
  sourcemap: false,
  minify: false,
});
