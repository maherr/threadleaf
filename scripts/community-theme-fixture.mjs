import { createHash } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

const appRoot = path.resolve(new URL("..", import.meta.url).pathname);
const manifestPath = path.join(appRoot, "visual", "community-themes.v1.json");
const CACHE_FILE_LIMITS = Object.freeze({
  "theme.css": 2 * 1024 * 1024,
  "manifest.json": 64 * 1024,
  LICENSE: 512 * 1024,
});

function isContained(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function assertSafeRelativePath(relativePath, label = "path") {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Community theme ${label} must be a normalized relative path.`);
  }
}

function assertValidGithubRepository(repository, label) {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`${label} must be an exact HTTPS GitHub repository URL.`);
  }
}

function assertValidManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Community theme manifest must be an object.");
  }
  if (manifest.schemaVersion !== 1 || manifest.id !== "threadleaf-community-open-themes-v1") {
    throw new Error("Community theme manifest schema or identity is unsupported.");
  }
  if (
    manifest.cache?.defaultDirectory !== "$XDG_CACHE_HOME/threadleaf/community-themes-v1" ||
    manifest.cache.networkPolicy !== "acquisition-only" ||
    manifest.cache.runtimeNetwork !== "forbidden" ||
    manifest.cache.shippedThirdPartyAssets !== false
  ) {
    throw new Error(
      "Community theme cache policy must be acquisition-only, offline at runtime, and unbundled.",
    );
  }
  if (
    manifest.renderer?.electron !== "43.3.0" ||
    manifest.renderer?.nodeMajor !== 22 ||
    manifest.renderer?.display !== "xvfb-x11"
  ) {
    throw new Error("Community theme renderer environment is not pinned.");
  }
  if (
    manifest.fixture?.root !== "fixtures/vaults/visual-regression" ||
    !/^[a-f0-9]{64}$/u.test(manifest.fixture?.treeSha256 ?? "")
  ) {
    throw new Error("Community theme fixture tree is not pinned.");
  }
  if (
    manifest.sourceUpdate?.kind !== "manual-receipt-refresh" ||
    manifest.sourceUpdate.watcherPath !== ".obsidian/themes/<folder>/theme.css" ||
    manifest.sourceUpdate.watcherEvent !== "filesystem-event" ||
    manifest.sourceUpdate.reload !== "complete-appearance-rescan"
  ) {
    throw new Error("Community theme source-update/watcher seam drifted.");
  }
  if (!Array.isArray(manifest.themes) || manifest.themes.length < 3 || manifest.themes.length > 5) {
    throw new Error("Community theme manifest must contain a small representative set.");
  }
  const ids = new Set();
  const folders = new Set();
  for (const theme of manifest.themes) {
    if (!theme || typeof theme !== "object") throw new Error("Community theme entry is malformed.");
    if (
      !/^[a-z0-9-]+$/u.test(theme.id) ||
      ids.has(theme.id) ||
      folders.has(theme.folder) ||
      typeof theme.name !== "string" ||
      theme.name.trim() === "" ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/u.test(theme.folder) ||
      theme.folder.includes("/") ||
      theme.folder.includes("\\") ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(theme.release) ||
      theme.license !== "MIT"
    ) {
      throw new Error(
        `Community theme ${theme.id ?? "(unknown)"} has invalid name, version, folder, or license.`,
      );
    }
    ids.add(theme.id);
    folders.add(theme.folder);
    assertValidGithubRepository(theme.repository, `Community theme ${theme.id} repository`);
    if (theme.commit !== theme.commit.toLowerCase() || !/^[0-9a-f]{40}$/u.test(theme.commit)) {
      throw new Error(`Community theme ${theme.id} is not pinned to a full lowercase commit.`);
    }
    if (theme.commitUrl !== `${theme.repository}/commit/${theme.commit}`) {
      throw new Error(
        `Community theme ${theme.id} commit URL is not derived from its repository and commit.`,
      );
    }
    const repositoryPath = new URL(theme.repository).pathname.replace(/^\//u, "");
    const expectedLicenseUrl = `https://raw.githubusercontent.com/${repositoryPath}/${theme.commit}/LICENSE`;
    if (theme.licenseUrl !== expectedLicenseUrl) {
      throw new Error(`Community theme ${theme.id} license URL is not pinned to its commit.`);
    }
    if (theme.shippedThirdPartyAssets !== false) {
      throw new Error(`Community theme ${theme.id} declares shipped third-party assets.`);
    }
    if (!Array.isArray(theme.files) || theme.files.length !== 3) {
      throw new Error(
        `Community theme ${theme.id} must have exactly CSS, manifest, and license receipts.`,
      );
    }
    const filePaths = new Set();
    for (const file of theme.files) {
      assertSafeRelativePath(file.path, `${theme.id} receipt path`);
      if (filePaths.has(file.path) || !Object.hasOwn(CACHE_FILE_LIMITS, file.path)) {
        throw new Error(`Community theme ${theme.id} has an unexpected or duplicate receipt path.`);
      }
      filePaths.add(file.path);
      if (!/^[a-f0-9]{64}$/u.test(file.sha256)) {
        throw new Error(`Community theme ${theme.id}/${file.path} has no exact SHA-256 receipt.`);
      }
      const expectedUrl = `https://raw.githubusercontent.com/${repositoryPath}/${theme.commit}/${file.path}`;
      if (file.url !== expectedUrl) {
        throw new Error(
          `Community theme ${theme.id}/${file.path} URL is not pinned to its commit.`,
        );
      }
    }
    for (const required of ["theme.css", "manifest.json", "LICENSE"]) {
      if (!filePaths.has(required))
        throw new Error(`Community theme ${theme.id} is missing ${required}.`);
    }
  }
  return manifest;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function readCommunityManifest() {
  return assertValidManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")));
}

export function defaultCacheRoot() {
  const cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.resolve(
    process.env.THREADLEAF_COMMUNITY_THEME_CACHE ||
      path.join(cacheHome, "threadleaf", "community-themes-v1"),
  );
}

export function cachePath(cacheRoot, themeId, relativePath) {
  if (typeof themeId !== "string" || !/^[a-z0-9-]+$/u.test(themeId)) {
    throw new Error("Community theme cache theme id is invalid.");
  }
  assertSafeRelativePath(relativePath, "cache receipt path");
  const target = path.resolve(cacheRoot, themeId, relativePath);
  if (!isContained(path.resolve(cacheRoot), target)) {
    throw new Error(`Community theme cache path escapes its root: ${relativePath}`);
  }
  return target;
}

async function assertNoSymlinkAncestors(targetPath) {
  const resolved = path.resolve(targetPath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const entry = await fs.lstat(current);
      if (entry.isSymbolicLink()) {
        throw new Error(`Community theme cache refuses symlink path component: ${current}`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function realpathWithMissingLeaf(targetPath) {
  let current = path.resolve(targetPath);
  const suffix = [];
  while (true) {
    try {
      const canonical = await fs.realpath(current);
      return path.join(canonical, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

async function assertSafeCacheRoot(cacheRoot) {
  const resolvedRoot = path.resolve(cacheRoot);
  await assertNoSymlinkAncestors(resolvedRoot);
  const canonicalRoot = await realpathWithMissingLeaf(resolvedRoot);
  const canonicalAppRoot = await fs.realpath(appRoot);
  if (isContained(canonicalAppRoot, canonicalRoot)) {
    throw new Error("Community theme cache must be outside the Threadleaf checkout.");
  }
  return { resolvedRoot, canonicalRoot };
}

async function readRegularFile(target, label, maximumBytes) {
  await assertNoSymlinkAncestors(target);
  let handle;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`${label} is not a regular file.`);
    if (maximumBytes !== undefined && stats.size > maximumBytes) {
      const error = new Error(`${label} exceeds its ${maximumBytes} byte bound.`);
      error.code = "EFBIG";
      throw error;
    }
    return await handle.readFile();
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`${label} is a symlink.`);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readCommunityCacheFile(cacheRoot, themeId, relativePath) {
  const target = cachePath(cacheRoot, themeId, relativePath);
  await assertSafeCacheRoot(cacheRoot);
  return readRegularFile(
    target,
    `Community theme cache ${themeId}/${relativePath}`,
    CACHE_FILE_LIMITS[relativePath],
  );
}

export async function verifyCommunityCache(manifest, cacheRoot = defaultCacheRoot()) {
  assertValidManifest(manifest);
  const { resolvedRoot } = await assertSafeCacheRoot(cacheRoot);

  const receipts = [];
  const missing = [];
  for (const theme of manifest.themes ?? []) {
    for (const file of theme.files ?? []) {
      const target = cachePath(resolvedRoot, theme.id, file.path);
      try {
        const bytes = await readRegularFile(
          target,
          `Community theme cache ${theme.id}/${file.path}`,
          CACHE_FILE_LIMITS[file.path],
        );
        const actual = sha256(bytes);
        if (actual !== file.sha256) {
          missing.push(`${theme.id}/${file.path} (sha256 ${actual}, expected ${file.sha256})`);
          continue;
        }
        receipts.push({ theme: theme.id, path: file.path, sha256: actual, bytes: bytes.length });
        if (file.path === "manifest.json") {
          let packageManifest;
          try {
            packageManifest = JSON.parse(bytes.toString("utf8"));
          } catch {
            throw new Error(`Community theme ${theme.id}/manifest.json is not valid JSON.`);
          }
          if (packageManifest.name !== theme.name || packageManifest.version !== theme.release) {
            throw new Error(
              `Community theme ${theme.id}/manifest.json name/version receipt drifted: ` +
                `${packageManifest.name ?? "(missing)"}/${packageManifest.version ?? "(missing)"}.`,
            );
          }
        }
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "EFBIG") {
          missing.push(`${theme.id}/${file.path}`);
        } else {
          throw error;
        }
      }
    }
  }
  return { cacheRoot: resolvedRoot, receipts, missing, complete: missing.length === 0 };
}

export {
  appRoot,
  assertNoSymlinkAncestors,
  assertSafeCacheRoot,
  assertValidManifest,
  CACHE_FILE_LIMITS,
  manifestPath,
};
