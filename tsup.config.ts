import { defineConfig } from "tsup";

const shared = {
  outDir: "dist/main",
  format: "cjs" as const,
  platform: "node" as const,
  target: "node22",
  external: ["electron"],
  splitting: false,
  sourcemap: true,
};

export default defineConfig([
  {
    ...shared,
    entry: {
      cli: "src/cli/main.ts",
      corpus: "src/corpus/main.ts",
      main: "src/main/main.ts",
      "native-extension": "src/native-extension/index.ts",
      "native-extension-sdk": "src/native-extension/sdk.ts",
      "private-state-lock": "src/private-state-lock/index.ts",
      "plugin-inspection": "src/main/plugin-package-inspection.ts",
      "plugin-renderer": "src/plugin-renderer/renderer.ts",
      preload: "src/main/preload.ts",
    },
    clean: true,
  },
  {
    ...shared,
    entry: { "trusted-plugin-host": "src/main/trusted-plugin-host.ts" },
    // The host bundle is evaluated in the trusted page realm. Bundle userland dependencies so
    // class instances and rule registries are constructed in that realm instead of crossing the
    // isolated preload bridge as proxied objects. Node built-ins stay external and use the
    // narrow trusted bridge.
    noExternal: [/^(?!node:|electron$).+/u],
    clean: false,
  },
]);
