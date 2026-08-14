import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function modeFromStat(stat) {
  return stat.mode & 0o777;
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function treeHash(entries) {
  const lines = entries
    .map(
      (entry) =>
        `${entry.kind}\0${entry.path}\0${entry.bytes}\0${entry.sha256 ?? ""}\0${entry.mode}\n`,
    )
    .join("");
  return sha256(Buffer.from(lines, "utf8"));
}

async function collectPaths(rootPath, { captureFile = () => true } = {}) {
  const entries = [];
  async function visit(currentPath, relativePath) {
    const children = await fs.readdir(currentPath, { withFileTypes: true });
    children.sort((left, right) => compareNames(left.name, right.name));
    for (const child of children) {
      const childPath = path.join(currentPath, child.name);
      const childRelative = relativePath ? path.join(relativePath, child.name) : child.name;
      const normalized = childRelative.split(path.sep).join("/");
      const stat = await fs.lstat(childPath);
      if (child.isDirectory()) {
        entries.push({ kind: "directory", path: normalized, bytes: 0, mode: modeFromStat(stat) });
        await visit(childPath, normalized);
      } else if (child.isFile()) {
        if (captureFile(normalized)) {
          const bytes = await fs.readFile(childPath);
          entries.push({
            kind: "file",
            path: normalized,
            bytes: bytes.length,
            sha256: sha256(bytes),
            mode: modeFromStat(stat),
          });
        } else {
          entries.push({
            kind: "file",
            path: normalized,
            bytes: stat.size,
            mode: modeFromStat(stat),
          });
        }
      } else if (child.isSymbolicLink()) {
        const target = await fs.readlink(childPath);
        entries.push({
          kind: "symlink",
          path: normalized,
          bytes: Buffer.byteLength(target),
          target,
          sha256: sha256(Buffer.from(target, "utf8")),
          mode: modeFromStat(stat),
        });
      } else {
        throw new Error(`Unsupported filesystem entry in manifest: ${normalized}`);
      }
    }
  }
  await visit(rootPath, "");
  return entries;
}

export async function snapshotTree(rootPath, { label = "tree" } = {}) {
  const entries = await collectPaths(rootPath);
  return {
    schemaVersion: 1,
    label,
    root: path.basename(rootPath),
    entries,
    treeSha256: treeHash(entries),
  };
}

export async function writeManifest(filePath, manifest) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

export function diffManifests(before, after) {
  const beforeByPath = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.entries.map((entry) => [entry.path, entry]));
  const paths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  const added = [];
  const removed = [];
  const changed = [];
  for (const entryPath of [...paths].sort(compareNames)) {
    const oldEntry = beforeByPath.get(entryPath);
    const newEntry = afterByPath.get(entryPath);
    if (!oldEntry && newEntry) {
      added.push(newEntry);
    } else if (oldEntry && !newEntry) {
      removed.push(oldEntry);
    } else if (oldEntry && newEntry && JSON.stringify(oldEntry) !== JSON.stringify(newEntry)) {
      changed.push({ path: entryPath, before: oldEntry, after: newEntry });
    }
  }
  return {
    added,
    removed,
    changed,
    equal: added.length === 0 && removed.length === 0 && changed.length === 0,
  };
}

const capturedProfileFiles = new Set([
  "obsidian.json",
  "Local State",
  "Preferences",
  "Default/Preferences",
  "Default/Secure Preferences",
]);

const ephemeralProfilePrefixes = [
  "Cache/",
  "Code Cache/",
  "Cookies",
  "Crashpad/",
  "DIPS",
  "DawnGraphiteCache/",
  "DawnWebGPUCache/",
  "DevToolsActivePort",
  "Dictionaries/",
  "GPUCache/",
  "IndexedDB/",
  "Local Storage/",
  "Network Persistent State",
  "Session Storage/",
  "Shared Dictionary/",
  "Trust Tokens",
  "WebStorage/",
  "blob_storage/",
  "id",
  "obsidian.log",
  "Singleton",
  "Default/Cache/",
  "Default/Code Cache/",
  "Default/GPUCache/",
  "Default/DawnGraphiteCache/",
  "Default/Service Worker/CacheStorage/",
  "Default/Service Worker/ScriptCache/",
  "Default/Session Storage/",
  "Default/Shared Dictionary/",
  "Default/blob_storage/",
  "Default/Network/",
  "Default/Crashpad/",
  "Crashpad/",
];

function isEphemeralProfilePath(entryPath) {
  return ephemeralProfilePrefixes.some((prefix) => {
    const directory = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return entryPath === directory || entryPath === prefix || entryPath.startsWith(prefix);
  });
}

function isKnownProfileDirectory(entryPath, capturedFiles = capturedProfileFiles) {
  if (!entryPath) return true;
  const prefixes = [
    ...[...capturedFiles].map((filePath) => filePath.split("/")),
    ...ephemeralProfilePrefixes.map((prefix) => prefix.replace(/\/$/u, "").split("/")),
  ];
  return prefixes.some((parts) => parts.join("/").startsWith(`${entryPath}/`));
}

function profilePolicy(pathValue, kind = "file", capturedFiles = capturedProfileFiles) {
  if (capturedFiles.has(pathValue)) return "captured";
  if (isEphemeralProfilePath(pathValue)) return "ephemeral";
  if (kind === "directory" && isKnownProfileDirectory(pathValue, capturedFiles))
    return "structural";
  return "unexpected";
}

export const PROFILE_ALLOWLIST = {
  schemaVersion: 1,
  capturedFiles: [...capturedProfileFiles].sort(compareNames),
  ephemeralPrefixes: [...ephemeralProfilePrefixes].sort(compareNames),
  rationale: "Fresh profile settings are hashed; cache and singleton paths are metadata-only.",
};

export async function snapshotAllowlistedProfile(
  rootPath,
  { label = "profile", extraCapturedFiles = [] } = {},
) {
  const capturedFiles = new Set([...capturedProfileFiles, ...extraCapturedFiles]);
  const entries = await collectPaths(rootPath, {
    captureFile: (entryPath) => profilePolicy(entryPath, "file", capturedFiles) === "captured",
  });
  const captured = [];
  const ephemeral = [];
  const unexpected = [];
  for (const entry of entries) {
    const policy = profilePolicy(entry.path, entry.kind, capturedFiles);
    if (policy === "captured") {
      captured.push(entry);
    } else if (policy === "ephemeral" || policy === "structural") {
      ephemeral.push({
        path: entry.path,
        kind: entry.kind,
        bytes: entry.bytes,
        mode: entry.mode,
      });
    } else {
      unexpected.push({
        path: entry.path,
        kind: entry.kind,
        bytes: entry.bytes,
        mode: entry.mode,
      });
    }
  }
  return {
    schemaVersion: 1,
    label,
    root: path.basename(rootPath),
    allowlist: { ...PROFILE_ALLOWLIST, capturedFiles: [...capturedFiles].sort(compareNames) },
    captured,
    ephemeral,
    unexpected,
    safe: unexpected.length === 0,
  };
}

export function assertExactManifest(before, after, label) {
  const diff = diffManifests(before, after);
  assert(diff.equal, `${label} changed unexpectedly: ${JSON.stringify(diff)}`);
  return diff;
}

export function assertProfileAllowlist(snapshot, label) {
  assert(
    snapshot.safe,
    `${label} wrote non-allowlisted profile paths: ${JSON.stringify(snapshot.unexpected)}`,
  );
}

export function manifestTreeHash(manifest) {
  return treeHash(manifest.entries);
}
