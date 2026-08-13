import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const appRoot = path.resolve(new URL("..", import.meta.url).pathname);
const manifestPath = path.join(appRoot, "visual", "community-themes.v1.json");

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function readCommunityManifest() {
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}

export function defaultCacheRoot() {
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.resolve(
    process.env.THREADLEAF_COMMUNITY_THEME_CACHE ||
      path.join(cacheHome, "threadleaf", "community-themes-v1"),
  );
}

function contained(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function cachePath(cacheRoot, themeId, relativePath) {
  const target = path.resolve(cacheRoot, themeId, relativePath);
  if (!contained(path.resolve(cacheRoot), target)) {
    throw new Error(`Community theme cache path escapes its root: ${relativePath}`);
  }
  return target;
}

export async function verifyCommunityCache(manifest, cacheRoot = defaultCacheRoot()) {
  const resolvedRoot = path.resolve(cacheRoot);
  const relativeToApp = path.relative(appRoot, resolvedRoot);
  if (
    relativeToApp === "" ||
    (!relativeToApp.startsWith(`..${path.sep}`) && relativeToApp !== "..")
  ) {
    throw new Error("Community theme cache must be outside the Threadleaf checkout.");
  }

  const receipts = [];
  const missing = [];
  for (const theme of manifest.themes ?? []) {
    for (const file of theme.files ?? []) {
      const target = cachePath(resolvedRoot, theme.id, file.path);
      try {
        const bytes = await fs.readFile(target);
        const actual = sha256(bytes);
        if (actual !== file.sha256) {
          missing.push(`${theme.id}/${file.path} (sha256 ${actual}, expected ${file.sha256})`);
          continue;
        }
        receipts.push({ theme: theme.id, path: file.path, sha256: actual, bytes: bytes.length });
      } catch (error) {
        if (error?.code === "ENOENT") {
          missing.push(`${theme.id}/${file.path}`);
        } else {
          throw error;
        }
      }
    }
  }
  return { cacheRoot: resolvedRoot, receipts, missing, complete: missing.length === 0 };
}

export { appRoot, manifestPath };
