import { type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import { syncDirectory } from "./durability";
import type { VaultDirectoryCreateResult } from "./ports";

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultPathError";
  }
}

export interface VisibleVaultPaths {
  directory: string;
  exists: boolean;
  files: string[];
  folders: string[];
}

export interface WorkspaceDocumentPaths {
  markdownPaths: string[];
  canvasPaths: string[];
}

interface VaultWalkEntry {
  entry: Dirent;
  absolutePath: string;
  relativePath: string;
}

const directoryReadConcurrency = 32;

/**
 * Walk ordinary vault directories with a bounded number of `readdir` calls.
 *
 * Results are sorted once by each public caller, so per-directory ordering is
 * not observable. The queue never follows a symlink and excludes hidden and
 * private entries before descent, preserving the same authority boundary as
 * the former depth-first walker while avoiding one serial syscall per folder.
 */
async function walkVisibleVaultEntries(
  startDirectory: string,
  relativeDirectory: string,
  visit: (candidate: VaultWalkEntry) => void | Promise<void>,
): Promise<void> {
  const directories = [{ absolutePath: startDirectory, relativePath: relativeDirectory }];
  for (let cursor = 0; cursor < directories.length; ) {
    const batch = directories.slice(cursor, cursor + directoryReadConcurrency);
    cursor += batch.length;
    const listings = await Promise.all(
      batch.map(async (directory) => ({
        ...directory,
        entries: await fs.readdir(directory.absolutePath, { withFileTypes: true }),
      })),
    );
    for (const directory of listings) {
      for (const entry of directory.entries) {
        if (isPrivateVaultEntry(entry.name) || isHiddenVaultEntry(entry.name)) continue;
        const relativePath = directory.relativePath
          ? `${directory.relativePath}/${entry.name}`
          : entry.name;
        const absolutePath = path.join(directory.absolutePath, entry.name);
        if (entry.isDirectory()) {
          directories.push({ absolutePath, relativePath });
        }
        await visit({ entry, absolutePath, relativePath });
      }
    }
  }
}

function isPrivateVaultEntry(name: string): boolean {
  const foldedName = name.toLocaleLowerCase("en-US");
  return (
    foldedName === ".obsidian" ||
    foldedName === ".git" ||
    foldedName === ".trash" ||
    foldedName.startsWith(".threadleaf-")
  );
}

function isHiddenVaultEntry(name: string): boolean {
  return name.startsWith(".");
}

export function hasPrivateVaultSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some(isPrivateVaultEntry);
}

export function hasHiddenVaultSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some(isHiddenVaultEntry);
}

export function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function normalizeVaultPath(input: string): string {
  if (input.length === 0 || input.includes("\0")) {
    throw new VaultPathError("Vault paths must be non-empty and contain no null bytes.");
  }
  if (path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new VaultPathError(`Vault paths must be relative: ${input}`);
  }

  const portable = input.replaceAll("\\", "/");
  if (portable.endsWith("/")) {
    throw new VaultPathError(`Vault path is not a file path: ${input}`);
  }
  if (portable.split("/").includes("..")) {
    throw new VaultPathError(`Vault path traversal is not allowed: ${input}`);
  }

  const normalized = path.posix.normalize(portable).replace(/^\.\//, "");
  if (normalized === "." || normalized.startsWith("../")) {
    throw new VaultPathError(`Vault path is not a file path: ${input}`);
  }
  return normalized;
}

/** Case- and NFC-folded identity used for visible-vault path occupancy checks. */
export function normalizedVaultPathIdentity(input: string): string {
  return normalizeVaultPath(input).normalize("NFC").toLocaleLowerCase("en-US");
}

export function normalizeVaultDirectoryPath(input: string): string {
  if (input === "" || input === ".") {
    return "";
  }
  if (input.includes("\0") || path.posix.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new VaultPathError(`Vault directory paths must be relative: ${input}`);
  }
  const portable = input.replaceAll("\\", "/").replace(/\/+$/, "");
  if (portable.split("/").includes("..")) {
    throw new VaultPathError(`Vault path traversal is not allowed: ${input}`);
  }
  const normalized = path.posix.normalize(portable).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new VaultPathError(`Vault directory path escapes the vault: ${input}`);
  }
  return normalized === "." ? "" : normalized;
}

export async function canonicalizePotentialPath(input: string): Promise<string> {
  let current = path.resolve(input);
  const missingSegments: string[] = [];

  while (true) {
    try {
      const canonicalAncestor = await fs.realpath(current);
      return path.join(canonicalAncestor, ...missingSegments.reverse());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new VaultPathError(`Could not resolve a parent for path: ${input}`);
      }
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

async function lstatOrNull(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export class VaultPathPolicy {
  readonly rootPath: string;

  private constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  static async open(rootPath: string): Promise<VaultPathPolicy> {
    const canonicalRoot = await fs.realpath(path.resolve(rootPath));
    const stat = await fs.stat(canonicalRoot);
    if (!stat.isDirectory()) {
      throw new VaultPathError(`Vault root is not a directory: ${rootPath}`);
    }
    return new VaultPathPolicy(canonicalRoot);
  }

  getName(): string {
    return path.basename(this.rootPath);
  }

  resolveLexical(relativePath: string): string {
    const normalized = normalizeVaultPath(relativePath);
    const absolutePath = path.resolve(this.rootPath, ...normalized.split("/"));
    if (!isPathInside(this.rootPath, absolutePath)) {
      throw new VaultPathError(`Path escapes the vault: ${relativePath}`);
    }
    return absolutePath;
  }

  async resolveForRead(relativePath: string): Promise<string> {
    const lexicalPath = this.resolveLexical(relativePath);
    const canonicalPath = await fs.realpath(lexicalPath);
    if (!isPathInside(this.rootPath, canonicalPath)) {
      throw new VaultPathError(`Path resolves outside the vault: ${relativePath}`);
    }
    return canonicalPath;
  }

  async resolveForWrite(relativePath: string, createParents = false): Promise<string> {
    const normalized = normalizeVaultPath(relativePath);
    const segments = normalized.split("/");
    const fileName = segments.pop();
    if (!fileName) {
      throw new VaultPathError(`Vault path is not a file path: ${relativePath}`);
    }

    let currentDirectory = this.rootPath;
    for (const segment of segments) {
      currentDirectory = path.join(currentDirectory, segment);
      let stat = await lstatOrNull(currentDirectory);
      if (!stat && createParents) {
        await fs.mkdir(currentDirectory);
        stat = await fs.lstat(currentDirectory);
      }
      if (!stat) {
        throw new VaultPathError(`Parent directory does not exist: ${relativePath}`);
      }
      if (stat.isSymbolicLink()) {
        throw new VaultPathError(`Writes through symbolic links are not allowed: ${relativePath}`);
      }
      if (!stat.isDirectory()) {
        throw new VaultPathError(`Parent path is not a directory: ${relativePath}`);
      }
    }

    const canonicalParent = await fs.realpath(currentDirectory);
    if (path.resolve(canonicalParent) !== path.resolve(currentDirectory)) {
      throw new VaultPathError(`Writes through symbolic links are not allowed: ${relativePath}`);
    }

    const absolutePath = path.join(currentDirectory, fileName);
    const targetStat = await lstatOrNull(absolutePath);
    if (targetStat?.isSymbolicLink()) {
      throw new VaultPathError(`Writes through symbolic links are not allowed: ${relativePath}`);
    }
    if (targetStat?.isDirectory()) {
      throw new VaultPathError(`Vault file path points to a directory: ${relativePath}`);
    }
    return absolutePath;
  }

  async createDirectory(relativeDirectory: string): Promise<VaultDirectoryCreateResult> {
    const normalized = normalizeVaultDirectoryPath(relativeDirectory);
    if (normalized === "") {
      return { path: "", created: false };
    }
    if (hasPrivateVaultSegment(normalized)) {
      throw new VaultPathError(
        `Vault directories cannot use private application paths: ${normalized}`,
      );
    }

    let currentDirectory = this.rootPath;
    let created = false;
    for (const segment of normalized.split("/")) {
      const parentDirectory = currentDirectory;
      currentDirectory = path.join(parentDirectory, segment);
      let stat = await lstatOrNull(currentDirectory);
      if (!stat) {
        try {
          await fs.mkdir(currentDirectory);
          await syncDirectory(parentDirectory);
          created = true;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
            throw error;
          }
        }
        stat = await fs.lstat(currentDirectory);
      }
      if (stat.isSymbolicLink()) {
        throw new VaultPathError(
          `Directory creation through symbolic links is not allowed: ${relativeDirectory}`,
        );
      }
      if (!stat.isDirectory()) {
        throw new VaultPathError(`Vault directory path is not a directory: ${relativeDirectory}`);
      }
      const canonicalDirectory = await fs.realpath(currentDirectory);
      if (
        path.resolve(canonicalDirectory) !== path.resolve(currentDirectory) ||
        !isPathInside(this.rootPath, canonicalDirectory)
      ) {
        throw new VaultPathError(
          `Directory creation through symbolic links is not allowed: ${relativeDirectory}`,
        );
      }
    }
    return { path: normalized, created };
  }

  toVaultPath(absolutePath: string): string {
    if (!isPathInside(this.rootPath, absolutePath)) {
      throw new VaultPathError(`Path is outside the vault: ${absolutePath}`);
    }
    return path.relative(this.rootPath, absolutePath).split(path.sep).join("/");
  }

  async listMarkdownPaths(relativeDirectory = ""): Promise<string[]> {
    return (await this.listWorkspaceDocumentPaths(relativeDirectory)).markdownPaths;
  }

  async listWorkspaceDocumentPaths(relativeDirectory = ""): Promise<WorkspaceDocumentPaths> {
    const normalizedDirectory = normalizeVaultDirectoryPath(relativeDirectory);
    if ((await this.lexicalDirectoryPathKind(normalizedDirectory)) !== "plain") {
      return { markdownPaths: [], canvasPaths: [] };
    }
    const startDirectory = normalizedDirectory
      ? path.resolve(this.rootPath, ...normalizedDirectory.split("/"))
      : this.rootPath;
    const lexicalStat = await lstatOrNull(startDirectory);
    if (!lexicalStat || (normalizedDirectory !== "" && lexicalStat.isSymbolicLink())) {
      return { markdownPaths: [], canvasPaths: [] };
    }
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await fs.realpath(startDirectory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { markdownPaths: [], canvasPaths: [] };
      }
      throw error;
    }
    if (path.resolve(canonicalDirectory) !== path.resolve(startDirectory)) {
      return { markdownPaths: [], canvasPaths: [] };
    }
    if (!isPathInside(this.rootPath, canonicalDirectory)) {
      throw new VaultPathError(`Directory resolves outside the vault: ${relativeDirectory}`);
    }
    const stat = await fs.stat(canonicalDirectory);
    if (!stat.isDirectory()) {
      throw new VaultPathError(`Vault directory path is not a directory: ${relativeDirectory}`);
    }
    const markdownPaths: string[] = [];
    const canvasPaths: string[] = [];
    await this.collectWorkspaceDocumentPaths(
      canonicalDirectory,
      normalizedDirectory,
      markdownPaths,
      canvasPaths,
    );
    return {
      markdownPaths: markdownPaths.sort((left, right) => left.localeCompare(right)),
      canvasPaths: canvasPaths.sort((left, right) => left.localeCompare(right)),
    };
  }

  async listVisiblePaths(relativeDirectory = ""): Promise<VisibleVaultPaths> {
    const normalizedDirectory = normalizeVaultDirectoryPath(relativeDirectory);
    if (hasPrivateVaultSegment(normalizedDirectory) || hasHiddenVaultSegment(normalizedDirectory)) {
      return { directory: normalizedDirectory, exists: false, files: [], folders: [] };
    }
    if ((await this.lexicalDirectoryPathKind(normalizedDirectory)) !== "plain") {
      return { directory: normalizedDirectory, exists: false, files: [], folders: [] };
    }
    const startDirectory = normalizedDirectory
      ? path.resolve(this.rootPath, ...normalizedDirectory.split("/"))
      : this.rootPath;
    const lexicalStat = await lstatOrNull(startDirectory);
    if (!lexicalStat || (normalizedDirectory !== "" && lexicalStat.isSymbolicLink())) {
      return { directory: normalizedDirectory, exists: false, files: [], folders: [] };
    }
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await fs.realpath(startDirectory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { directory: normalizedDirectory, exists: false, files: [], folders: [] };
      }
      throw error;
    }
    if (path.resolve(canonicalDirectory) !== path.resolve(startDirectory)) {
      return { directory: normalizedDirectory, exists: false, files: [], folders: [] };
    }
    if (!isPathInside(this.rootPath, canonicalDirectory)) {
      throw new VaultPathError(`Directory resolves outside the vault: ${relativeDirectory}`);
    }
    if (
      hasPrivateVaultSegment(path.relative(this.rootPath, canonicalDirectory)) ||
      hasHiddenVaultSegment(path.relative(this.rootPath, canonicalDirectory))
    ) {
      return { directory: normalizedDirectory, exists: false, files: [], folders: [] };
    }
    const stat = await fs.stat(canonicalDirectory);
    if (!stat.isDirectory()) {
      throw new VaultPathError(`Vault directory path is not a directory: ${relativeDirectory}`);
    }
    const files: string[] = [];
    const folders: string[] = [];
    await this.collectVisiblePaths(canonicalDirectory, normalizedDirectory, files, folders);
    return {
      directory: normalizedDirectory,
      exists: true,
      files: files.sort((left, right) => left.localeCompare(right)),
      folders: folders.sort((left, right) => left.localeCompare(right)),
    };
  }

  /**
   * List one explorer level without walking any descendant directory.
   *
   * The full visible census remains available for global file operations, but
   * expanding one folder must cost one directory read rather than one vault
   * walk. Symlink and hidden/private-path rules are identical to the recursive
   * listing, including allowing contained file symlinks without following a
   * directory symlink.
   */
  async listVisibleChildren(relativeDirectory = ""): Promise<VisibleVaultPaths> {
    const normalizedDirectory = normalizeVaultDirectoryPath(relativeDirectory);
    if (hasPrivateVaultSegment(normalizedDirectory) || hasHiddenVaultSegment(normalizedDirectory)) {
      return { directory: normalizedDirectory, exists: false, files: [], folders: [] };
    }
    if ((await this.lexicalDirectoryPathKind(normalizedDirectory)) !== "plain") {
      return { directory: normalizedDirectory, exists: false, files: [], folders: [] };
    }
    const startDirectory = normalizedDirectory
      ? path.resolve(this.rootPath, ...normalizedDirectory.split("/"))
      : this.rootPath;
    const lexicalStat = await lstatOrNull(startDirectory);
    if (!lexicalStat || (normalizedDirectory !== "" && lexicalStat.isSymbolicLink())) {
      return { directory: normalizedDirectory, exists: false, files: [], folders: [] };
    }
    let canonicalDirectory: string;
    try {
      canonicalDirectory = await fs.realpath(startDirectory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { directory: normalizedDirectory, exists: false, files: [], folders: [] };
      }
      throw error;
    }
    if (
      path.resolve(canonicalDirectory) !== path.resolve(startDirectory) ||
      !isPathInside(this.rootPath, canonicalDirectory)
    ) {
      return { directory: normalizedDirectory, exists: false, files: [], folders: [] };
    }
    const stat = await fs.stat(canonicalDirectory);
    if (!stat.isDirectory()) {
      throw new VaultPathError(`Vault directory path is not a directory: ${relativeDirectory}`);
    }

    const files: string[] = [];
    const folders: string[] = [];
    const entries = await fs.readdir(canonicalDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (isPrivateVaultEntry(entry.name) || isHiddenVaultEntry(entry.name)) continue;
      const relativePath = normalizedDirectory
        ? `${normalizedDirectory}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        folders.push(relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const absolutePath = path.join(canonicalDirectory, entry.name);
        let canonicalPath: string;
        try {
          canonicalPath = await fs.realpath(absolutePath);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
        if (
          !isPathInside(this.rootPath, canonicalPath) ||
          hasPrivateVaultSegment(path.relative(this.rootPath, canonicalPath)) ||
          hasHiddenVaultSegment(path.relative(this.rootPath, canonicalPath))
        ) {
          continue;
        }
        if ((await fs.stat(canonicalPath)).isFile()) files.push(relativePath);
        continue;
      }
      if (entry.isFile()) files.push(relativePath);
    }
    return {
      directory: normalizedDirectory,
      exists: true,
      files: files.sort((left, right) => left.localeCompare(right)),
      folders: folders.sort((left, right) => left.localeCompare(right)),
    };
  }

  private async lexicalDirectoryPathKind(
    normalizedDirectory: string,
  ): Promise<"plain" | "missing" | "symlink"> {
    let currentDirectory = this.rootPath;
    for (const segment of normalizedDirectory ? normalizedDirectory.split("/") : []) {
      currentDirectory = path.join(currentDirectory, segment);
      const stat = await lstatOrNull(currentDirectory);
      if (!stat) return "missing";
      if (stat.isSymbolicLink()) return "symlink";
    }
    return "plain";
  }

  /**
   * Internal mutation-only namespace occupancy scan. Unlike visible-path
   * discovery, this deliberately records every safe lexical entry name so a
   * case/NFC alias cannot be hidden behind a dangling, outside, directory, or
   * special-file symlink. It never follows a symlink while descending.
   */
  async listNamespaceClaimants(): Promise<string[]> {
    const claimants: string[] = [];
    await this.collectNamespaceClaimants(this.rootPath, "", claimants);
    return claimants.sort((left, right) => left.localeCompare(right));
  }

  private async collectWorkspaceDocumentPaths(
    directory: string,
    relativeDirectory: string,
    markdownPaths: string[],
    canvasPaths: string[],
  ): Promise<void> {
    await walkVisibleVaultEntries(
      directory,
      relativeDirectory,
      async ({ entry, absolutePath, relativePath }) => {
        if (entry.isDirectory()) return;
        if (entry.isSymbolicLink()) {
          let canonicalPath: string;
          try {
            canonicalPath = await fs.realpath(absolutePath);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
              return;
            }
            throw error;
          }
          if (
            !isPathInside(this.rootPath, canonicalPath) ||
            hasPrivateVaultSegment(path.relative(this.rootPath, canonicalPath)) ||
            hasHiddenVaultSegment(path.relative(this.rootPath, canonicalPath))
          ) {
            return;
          }
          const targetStat = await fs.stat(canonicalPath);
          if (targetStat.isFile()) {
            const foldedName = entry.name.toLocaleLowerCase("en-US");
            if (foldedName.endsWith(".md")) markdownPaths.push(relativePath);
            if (foldedName.endsWith(".canvas")) canvasPaths.push(relativePath);
          }
          return;
        }

        if (entry.isFile()) {
          const foldedName = entry.name.toLocaleLowerCase("en-US");
          if (foldedName.endsWith(".md")) markdownPaths.push(relativePath);
          if (foldedName.endsWith(".canvas")) canvasPaths.push(relativePath);
        }
      },
    );
  }

  private async collectNamespaceClaimants(
    directory: string,
    relativeDirectory: string,
    claimants: string[],
  ): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (isPrivateVaultEntry(entry.name) || isHiddenVaultEntry(entry.name)) {
        continue;
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      claimants.push(relativePath);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      const current = await lstatOrNull(absolutePath);
      if (!current || current.isSymbolicLink() || !current.isDirectory()) {
        continue;
      }
      await this.collectNamespaceClaimants(absolutePath, relativePath, claimants);
    }
  }

  private async collectVisiblePaths(
    directory: string,
    relativeDirectory: string,
    files: string[],
    folders: string[],
  ): Promise<void> {
    await walkVisibleVaultEntries(
      directory,
      relativeDirectory,
      async ({ entry, absolutePath, relativePath }) => {
        if (entry.isDirectory()) {
          folders.push(relativePath);
          return;
        }
        if (entry.isSymbolicLink()) {
          let canonicalPath: string;
          try {
            canonicalPath = await fs.realpath(absolutePath);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
              return;
            }
            throw error;
          }
          if (
            !isPathInside(this.rootPath, canonicalPath) ||
            hasPrivateVaultSegment(path.relative(this.rootPath, canonicalPath)) ||
            hasHiddenVaultSegment(path.relative(this.rootPath, canonicalPath))
          ) {
            return;
          }
          const targetStat = await fs.stat(canonicalPath);
          if (targetStat.isFile()) {
            files.push(relativePath);
          }
          return;
        }
        if (entry.isFile()) {
          files.push(relativePath);
        }
      },
    );
  }
}
