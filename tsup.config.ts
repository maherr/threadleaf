import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli/main.ts",
    main: "src/main/main.ts",
    preload: "src/main/preload.ts",
  },
  outDir: "dist/main",
  format: ["cjs"],
  platform: "node",
  target: "node22",
  external: ["electron"],
  clean: true,
  splitting: false,
  sourcemap: true,
});
