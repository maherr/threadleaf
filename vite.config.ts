import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const rendererRoot = resolve(projectRoot, "src/renderer");

const trustedIndexPlugin: Plugin = {
  name: "threadleaf-trusted-index",
  enforce: "post" as const,
  generateBundle(_options, bundle) {
    const index = bundle["index.html"];
    if (
      !index ||
      typeof index !== "object" ||
      !("type" in index) ||
      index.type !== "asset" ||
      !("source" in index) ||
      typeof index.source !== "string"
    ) {
      throw new Error("Threadleaf trusted renderer could not find the transformed index.html.");
    }
    this.emitFile({
      type: "asset",
      fileName: "index-trusted.html",
      source: index.source.replace(
        "script-src 'self';",
        "script-src 'self' 'unsafe-eval'; worker-src 'self' blob:;",
      ),
    });
  },
};

export default defineConfig({
  base: "./",
  root: rendererRoot,
  plugins: [trustedIndexPlugin],
  build: {
    outDir: resolve(projectRoot, "dist/renderer"),
    emptyOutDir: true,
  },
});
