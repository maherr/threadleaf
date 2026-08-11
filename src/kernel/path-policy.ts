import { promises as fs } from "node:fs";
import path from "node:path";

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultPathError";
  }
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

  toVaultPath(absolutePath: string): string {
    if (!isPathInside(this.rootPath, absolutePath)) {
      throw new VaultPathError(`Path is outside the vault: ${absolutePath}`);
    }
    return path.relative(this.rootPath, absolutePath).split(path.sep).join("/");
  }

  async listMarkdownPaths(): Promise<string[]> {
    const files: string[] = [];
    await this.collectMarkdownPaths(this.rootPath, "", files);
    return files.sort((left, right) => left.localeCompare(right));
  }

  private async collectMarkdownPaths(
    directory: string,
    relativeDirectory: string,
    files: string[],
  ): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (
        entry.name === ".obsidian" ||
        entry.name === ".git" ||
        entry.name.startsWith(".threadleaf-")
      ) {
        continue;
      }

      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await this.collectMarkdownPaths(absolutePath, relativePath, files);
        continue;
      }

      if (entry.isSymbolicLink()) {
        const canonicalPath = await fs.realpath(absolutePath);
        if (!isPathInside(this.rootPath, canonicalPath)) {
          continue;
        }
        const targetStat = await fs.stat(canonicalPath);
        if (targetStat.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          files.push(relativePath);
        }
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(relativePath);
      }
    }
  }
}
