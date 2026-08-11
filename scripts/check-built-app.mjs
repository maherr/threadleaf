import { access, readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const rendererDirectory = path.join(projectRoot, "dist", "renderer");
const indexPath = path.join(rendererDirectory, "index.html");
const html = await readFile(indexPath, "utf8");

if (html.includes('="/assets/')) {
  throw new Error("Renderer assets must be relative so Electron can load them over file://.");
}

const assetPaths = [...html.matchAll(/(?:href|src)="(\.\/assets\/[^"]+)"/g)].map(
  ([, assetPath]) => assetPath,
);

if (assetPaths.length < 2) {
  throw new Error("Built renderer must reference its JavaScript and CSS assets.");
}

await Promise.all([
  access(path.join(projectRoot, "dist", "main", "main.cjs")),
  access(path.join(projectRoot, "dist", "main", "preload.cjs")),
  ...assetPaths.map((assetPath) => access(path.resolve(rendererDirectory, assetPath))),
]);

console.log(`Verified Electron entry points and ${assetPaths.length} relative renderer assets.`);
