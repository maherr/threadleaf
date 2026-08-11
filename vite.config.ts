import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "./",
  root: resolve(projectRoot, "src/renderer"),
  build: {
    outDir: resolve(projectRoot, "dist/renderer"),
    emptyOutDir: true,
  },
});
