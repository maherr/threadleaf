import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli/main.ts",
    corpus: "src/corpus/main.ts",
    main: "src/main/main.ts",
    "native-extension": "src/native-extension/index.ts",
    "native-extension-sdk": "src/native-extension/sdk.ts",
    "plugin-inspection": "src/main/plugin-package-inspection.ts",
    "plugin-renderer": "src/plugin-renderer/renderer.ts",
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
