import { defineConfig } from "tsup";

const trustedWorkspaceRealmModules = [
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
];

const shared = {
  outDir: "dist/main",
  format: "cjs" as const,
  platform: "node" as const,
  target: "node22",
  external: ["electron", "node:sqlite"],
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
    // The host bundle is evaluated in the trusted page realm. Most userland dependencies are
    // bundled into that realm, while CodeMirror and Lezer stay external so every import resolves
    // through the renderer-owned identity table. Node built-ins use the narrow trusted bridge.
    external: [...shared.external, ...trustedWorkspaceRealmModules],
    noExternal: [/^(?!node:|electron$|@codemirror(?:\/|$)|@lezer(?:\/|$)).+/u],
    clean: false,
  },
]);
