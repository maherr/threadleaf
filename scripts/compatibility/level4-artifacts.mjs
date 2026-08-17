import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
  return value;
}

function portableCollisionKey(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
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
  children.sort((left, right) => {
    const normalized = comparePortablePaths(
      left.name.normalize("NFC"),
      right.name.normalize("NFC"),
    );
    return normalized || comparePortablePaths(left.name, right.name);
  });
  for (const child of children) {
    const childName = child.name;
    const childRelative = relativePath ? `${relativePath}/${childName}` : childName;
    const normalized = normalizeRelativePath(childRelative, "tree entry");
    const collisionKey = portableCollisionKey(normalized);
    if (seenPaths.has(collisionKey)) fail(`tree contains colliding normalized path ${normalized}.`);
    seenPaths.add(collisionKey);
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

export async function readAuthorityJsonFile(
  filePath,
  label = "authority JSON file",
  { requireCanonical = false } = {},
) {
  let bytes;
  try {
    bytes = await fs.readFile(filePath);
  } catch (error) {
    fail(`cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseLevel4Json(bytes, { requireCanonical });
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
  return level4JsonSha256(await readAuthorityJsonFile(filePath, label));
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
  const manifest = await readAuthorityJsonFile(manifestPath, "plugin manifest");
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

const executableClosureRoots = [
  "scripts/compatibility/level4-controller.mjs",
  "scripts/compatibility/level4-verifier.mjs",
];

function closurePath(rootPath, filePath) {
  const relative = path.relative(rootPath, filePath).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || relative === ".." || path.isAbsolute(relative))
    fail(`executable closure escapes its repository root: ${filePath}`);
  return relative;
}

async function resolveClosureImport(specifier, importerPath, rootPath) {
  if (specifier.startsWith("node:")) return null;
  if (specifier.startsWith(".")) {
    const base = path.resolve(path.dirname(importerPath), specifier);
    const candidates = path.extname(base)
      ? [base]
      : [
          base,
          `${base}.mjs`,
          `${base}.js`,
          `${base}.cjs`,
          `${base}.json`,
          path.join(base, "index.mjs"),
        ];
    for (const candidate of candidates) {
      try {
        await fs.stat(candidate);
        return candidate;
      } catch {}
    }
    fail(`executable closure import ${specifier} from ${importerPath} is missing.`);
  }
  try {
    const resolved = createRequire(pathToFileURL(importerPath).href).resolve(specifier);
    const relative = closurePath(rootPath, resolved);
    if (relative.includes(".pnpm/")) return resolved;
    return resolved;
  } catch (error) {
    fail(
      `executable closure import ${specifier} from ${importerPath} could not be resolved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function importedSpecifiers(source, filePath) {
  const result = [];
  const pattern =
    /\b(?:import|export)\s+(?:[^"'`]*?\sfrom\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  for (const match of source.matchAll(pattern)) result.push(match[1] ?? match[2]);
  if (/\b(?:import|export)\s+(?:[^"'`]*?\sfrom\s+)?(?:[^"'`\s]|$)/u.test(source)) {
    // The supported closure is deliberately static. Dynamic or computed imports cannot be
    // trusted by a declarative manifest and must be made explicit before they can enter it.
    const unsupported = source.match(/\b(?:import|export)\s+(?:[^"'`]*?\sfrom\s+)?([^"'`\s;]+)/u);
    if (unsupported?.[1]?.startsWith("(")) {
      fail(`executable closure contains a non-literal import in ${filePath}.`);
    }
  }
  return result;
}

async function resolveClosureFile(rootPath, importerPath, specifier) {
  const resolved = await resolveClosureImport(specifier, importerPath, rootPath);
  if (resolved === null) return null;
  let realPath;
  try {
    realPath = await fs.realpath(resolved);
  } catch (error) {
    fail(
      `executable closure file ${resolved} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  closurePath(rootPath, realPath);
  return realPath;
}

export async function buildExecutableClosureManifest({
  rootPath,
  trustedClosure = undefined,
} = {}) {
  const repositoryRoot = path.resolve(rootPath ?? process.cwd());
  const visited = new Map();
  const visit = async (filePath) => {
    const realPath = await fs.realpath(filePath).catch((error) => {
      fail(
        `executable closure root ${filePath} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const relative = closurePath(repositoryRoot, realPath);
    if (visited.has(relative)) return;
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) fail(`executable closure entry ${relative} is not a regular file.`);
    const bytes = await fs.readFile(realPath);
    const entry = { path: relative, bytes: bytes.length, sha256: sha256Bytes(bytes) };
    visited.set(relative, entry);
    const source = bytes.toString("utf8");
    for (const specifier of importedSpecifiers(source, relative)) {
      const dependency = await resolveClosureFile(repositoryRoot, realPath, specifier);
      if (dependency !== null) await visit(dependency);
    }
  };
  for (const root of executableClosureRoots) await visit(path.join(repositoryRoot, root));
  const entries = [...visited.values()].sort((left, right) =>
    comparePortablePaths(left.path, right.path),
  );
  const closure = { schemaVersion: 1, roots: [...executableClosureRoots], entries };
  const closureSha256 = level4JsonSha256(closure);
  if (trustedClosure !== undefined) {
    if (level4JsonSha256(trustedClosure) !== closureSha256)
      fail("trusted executable closure is missing, extra, or changed reachable code.");
  }
  return { ...closure, closureSha256 };
}

export async function validateCanonicalBuildManifest(
  manifestPath,
  { installedApplicationTreePath, requiredInstalledPaths = [], expected },
) {
  const manifest = await readAuthorityJsonFile(manifestPath, "canonical build manifest", {
    requireCanonical: true,
  });
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join(",") !==
      "applicationId,architecture,entries,platform,requiredInstalledPaths,schemaVersion,version"
  ) {
    fail("canonical build manifest has an unsupported schema.");
  }
  const platform = expected.platform.split("-")[0];
  if (
    manifest.schemaVersion !== 1 ||
    manifest.applicationId !== "org.threadleaf.Threadleaf" ||
    manifest.version !== expected.threadleafVersion ||
    manifest.platform !== platform ||
    manifest.architecture !== expected.architecture
  ) {
    fail("canonical build manifest identity is stale or arbitrary.");
  }
  if (!Array.isArray(manifest.requiredInstalledPaths) || !Array.isArray(manifest.entries))
    fail("canonical build manifest inventory is malformed.");
  const expectedRequired = [...requiredInstalledPaths].sort(comparePortablePaths);
  const actualRequired = [...manifest.requiredInstalledPaths].sort(comparePortablePaths);
  if (JSON.stringify(actualRequired) !== JSON.stringify(expectedRequired))
    fail("canonical build manifest required installed paths differ from verifier inputs.");
  if (new Set(actualRequired).size !== actualRequired.length)
    fail("canonical build manifest required installed paths contain duplicates.");
  const installed = await buildTreeManifest(installedApplicationTreePath, {
    label: "installed application",
  });
  const expectedEntries = installed.entries;
  if (level4JsonSha256(manifest.entries) !== level4JsonSha256(expectedEntries))
    fail("canonical build manifest is not the exact installed executable/resource inventory.");
  for (const requiredPath of actualRequired) {
    if (!expectedEntries.some((entry) => entry.kind === "file" && entry.path === requiredPath))
      fail(`canonical build manifest omits required installed file ${requiredPath}.`);
  }
  return {
    manifest,
    installed,
    sha256: level4JsonSha256(manifest),
  };
}
