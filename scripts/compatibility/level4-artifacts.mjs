import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { level4JsonSha256, parseLevel4Json } from "../../src/shared/level4-receipt-boundary.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(`Level 4 artifact: ${message}`);
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(filePath) {
  let bytes;
  try {
    bytes = await fs.readFile(filePath);
  } catch (error) {
    fail(`cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return sha256Bytes(bytes);
}

function normalizeRelativePath(value, label = "path") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    fail(`${label} is not a portable relative path.`);
  }
  const normalized = value.normalize("NFC");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
    path.posix.normalize(normalized) !== normalized
  ) {
    fail(`${label} is not normalized or traverses a parent.`);
  }
  return normalized;
}

function comparePortablePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function modeOf(stat) {
  return stat.mode & 0o777;
}

async function readDirectoryEntries(rootPath, relativePath, entries, seenPaths) {
  let children;
  try {
    children = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    fail(
      `cannot read directory ${rootPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  children.sort((left, right) =>
    comparePortablePaths(left.name.normalize("NFC"), right.name.normalize("NFC")),
  );
  for (const child of children) {
    const childName = child.name.normalize("NFC");
    const childRelative = relativePath ? `${relativePath}/${childName}` : childName;
    const normalized = normalizeRelativePath(childRelative, "tree entry");
    if (seenPaths.has(normalized)) fail(`tree contains colliding normalized path ${normalized}.`);
    seenPaths.add(normalized);
    const childPath = path.join(rootPath, child.name);
    let stat;
    try {
      stat = await fs.lstat(childPath);
    } catch (error) {
      fail(`cannot stat ${childPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (stat.isDirectory()) {
      entries.push({ kind: "directory", path: normalized, bytes: 0, mode: modeOf(stat) });
      await readDirectoryEntries(childPath, normalized, entries, seenPaths);
    } else if (stat.isFile()) {
      let bytes;
      try {
        bytes = await fs.readFile(childPath);
      } catch (error) {
        fail(`cannot read ${childPath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      entries.push({
        kind: "file",
        path: normalized,
        bytes: bytes.length,
        mode: modeOf(stat),
        sha256: sha256Bytes(bytes),
      });
    } else if (stat.isSymbolicLink()) {
      fail(`tree contains a symbolic link at ${normalized}.`);
    } else {
      fail(`tree contains an unsupported special file at ${normalized}.`);
    }
  }
}

export async function buildTreeManifest(rootPath, { label = "tree" } = {}) {
  const absoluteRoot = path.resolve(rootPath);
  let rootStat;
  try {
    rootStat = await fs.lstat(absoluteRoot);
  } catch (error) {
    fail(`cannot stat ${absoluteRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!rootStat.isDirectory()) fail(`tree root ${absoluteRoot} is not a directory.`);
  const entries = [];
  await readDirectoryEntries(absoluteRoot, "", entries, new Set());
  entries.sort((left, right) => comparePortablePaths(left.path, right.path));
  const body = { schemaVersion: 1, label, entries };
  const treeIdentity = { schemaVersion: 1, entries };
  return { ...body, treeSha256: level4JsonSha256(treeIdentity) };
}

export function diffTreeManifests(before, after) {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort(
    comparePortablePaths,
  );
  return paths.flatMap((entryPath) => {
    const oldEntry = beforeByPath.get(entryPath);
    const newEntry = afterByPath.get(entryPath);
    if (!oldEntry)
      return [
        {
          path: entryPath,
          kind: "created",
          beforeSha256: null,
          afterSha256: newEntry.sha256 ?? null,
        },
      ];
    if (!newEntry)
      return [
        {
          path: entryPath,
          kind: "deleted",
          beforeSha256: oldEntry.sha256 ?? null,
          afterSha256: null,
        },
      ];
    if (level4JsonSha256(oldEntry) === level4JsonSha256(newEntry)) return [];
    return [
      {
        path: entryPath,
        kind: "modified",
        beforeSha256: oldEntry.sha256 ?? null,
        afterSha256: newEntry.sha256 ?? null,
      },
    ];
  });
}

export async function buildFileArtifact(filePath, { label = "artifact" } = {}) {
  const absolutePath = path.resolve(filePath);
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    fail(`cannot stat ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stat.isFile()) fail(`${label} ${absolutePath} is not a regular file.`);
  const bytes = await fs.readFile(absolutePath);
  return {
    schemaVersion: 1,
    label,
    path: absolutePath,
    bytes: bytes.length,
    sha256: sha256Bytes(bytes),
  };
}

export async function readJsonFile(filePath, label = "JSON file") {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    fail(`cannot parse ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

export async function readCanonicalJsonFile(filePath, label = "canonical JSON file") {
  let bytes;
  try {
    bytes = await fs.readFile(filePath);
  } catch (error) {
    fail(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseLevel4Json(bytes, { requireCanonical: true });
}

export async function canonicalJsonFileSha256(filePath, label = "JSON file") {
  return level4JsonSha256(await readJsonFile(filePath, label));
}

function requireDigest(value, label) {
  if (typeof value !== "string" || !sha256Pattern.test(value))
    fail(`${label} is not a lowercase SHA-256 digest.`);
  return value;
}

export async function buildPluginPackageIdentity(
  packageRoot,
  { distributionTag = "production" } = {},
) {
  const manifestPath = path.join(packageRoot, "manifest.json");
  const mainPath = path.join(packageRoot, "main.js");
  const stylesPath = path.join(packageRoot, "styles.css");
  const manifest = await readJsonFile(manifestPath, "plugin manifest");
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("plugin manifest is not an object.");
  }
  if (typeof manifest.id !== "string" || typeof manifest.version !== "string") {
    fail("plugin manifest lacks id or version.");
  }
  const packageTree = await buildTreeManifest(packageRoot, { label: "plugin-package" });
  const manifestArtifact = await buildFileArtifact(manifestPath, { label: "plugin manifest" });
  const mainArtifact = await buildFileArtifact(mainPath, { label: "plugin main" });
  let stylesSha256 = null;
  try {
    const stylesStat = await fs.lstat(stylesPath);
    if (stylesStat.isSymbolicLink() || !stylesStat.isFile())
      fail("plugin styles.css is not a regular file.");
    stylesSha256 = await sha256File(stylesPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const packageIdentity = {
    pluginId: manifest.id,
    manifestVersion: manifest.version,
    distributionTag,
    manifestSha256: manifestArtifact.sha256,
    mainSha256: mainArtifact.sha256,
    stylesSha256,
    packageTreeSha256: packageTree.treeSha256,
  };
  return {
    manifest,
    packageIdentity,
    packageIdentityDigest: level4JsonSha256(packageIdentity),
    packageTree,
  };
}

export function effectiveBuildIdentityDigest(input) {
  const body = {
    schemaVersion: 1,
    packageIdentityDigest: requireDigest(input.packageIdentityDigest, "packageIdentityDigest"),
    stagedPackageTreeSha256: requireDigest(
      input.stagedPackageTreeSha256,
      "stagedPackageTreeSha256",
    ),
    packagedApplicationArtifactSha256: requireDigest(
      input.packagedApplicationArtifactSha256,
      "packagedApplicationArtifactSha256",
    ),
    installedApplicationTreeSha256: requireDigest(
      input.installedApplicationTreeSha256,
      "installedApplicationTreeSha256",
    ),
    canonicalBuildManifestSha256: requireDigest(
      input.canonicalBuildManifestSha256,
      "canonicalBuildManifestSha256",
    ),
    relevantDistTreeSha256: requireDigest(input.relevantDistTreeSha256, "relevantDistTreeSha256"),
    electronExecutableSha256: requireDigest(
      input.electronExecutableSha256,
      "electronExecutableSha256",
    ),
  };
  return { ...body, digest: level4JsonSha256(body) };
}

export function assertDigest(value, label) {
  return requireDigest(value, label);
}
