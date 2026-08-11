import path from "node:path";
import { type LinkResolution, MetadataIndex } from "../kernel/metadata-index";
import { normalizeMarkdownNotePath } from "../kernel/note-path";
import type { VaultMutationPort, VaultReadPort, VaultTextSnapshot } from "../kernel/ports";
import type { NoteMoveBlocker, NoteMoveOutcome } from "../shared/contracts";

class SnapshotVault implements VaultReadPort {
  readonly #name: string;
  readonly #snapshots: Map<string, VaultTextSnapshot>;

  constructor(name: string, snapshots: Iterable<VaultTextSnapshot>) {
    this.#name = name;
    this.#snapshots = new Map([...snapshots].map((snapshot) => [snapshot.path, snapshot]));
  }

  getName(): string {
    return this.#name;
  }

  async listMarkdownPaths(): Promise<string[]> {
    return [...this.#snapshots.keys()].sort((left, right) => left.localeCompare(right));
  }

  async readText(relativePath: string): Promise<VaultTextSnapshot> {
    const snapshot = this.#snapshots.get(relativePath);
    if (!snapshot) {
      const error = new Error(`File does not exist: ${relativePath}`);
      Object.assign(error, { code: "ENOENT" });
      throw error;
    }
    return snapshot;
  }
}

function remapResolution(
  resolution: LinkResolution,
  sourcePath: string,
  targetPath: string,
): LinkResolution {
  const remap = (candidate: string): string => (candidate === sourcePath ? targetPath : candidate);
  if (resolution.status === "resolved" && resolution.path) {
    return { status: "resolved", path: remap(resolution.path) };
  }
  if (resolution.status === "ambiguous" && resolution.candidates) {
    return { status: "ambiguous", candidates: resolution.candidates.map(remap).sort() };
  }
  return { status: resolution.status };
}

function resolutionsEqual(left: LinkResolution, right: LinkResolution): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function renamedMarkdownPath(sourcePath: string, requestedName: string): string {
  const source = normalizeMarkdownNotePath(sourcePath);
  const name = requestedName.trim();
  if (!name || name.includes("/") || name.includes("\\")) {
    throw new Error("A renamed note requires one filename without directory separators.");
  }
  return normalizeMarkdownNotePath(path.posix.join(path.posix.dirname(source), name));
}

export function movedMarkdownPath(sourcePath: string, requestedTarget: string): string {
  const source = normalizeMarkdownNotePath(sourcePath);
  const target = requestedTarget.trim();
  if (!target) {
    throw new Error("A moved note requires a destination path.");
  }
  if (target.endsWith("/") || target.endsWith("\\")) {
    return normalizeMarkdownNotePath(
      path.posix.join(target.replaceAll("\\", "/"), path.posix.basename(source)),
    );
  }
  return normalizeMarkdownNotePath(target);
}

export async function moveMarkdownNote(
  vault: VaultMutationPort,
  requestedSourcePath: string,
  requestedTargetPath: string,
  expectedSourceRevision?: string,
): Promise<NoteMoveOutcome> {
  const sourcePath = normalizeMarkdownNotePath(requestedSourcePath);
  const targetPath = normalizeMarkdownNotePath(requestedTargetPath);
  if (sourcePath === targetPath) {
    throw new Error("Move source and destination must be different.");
  }

  const paths = await vault.listMarkdownPaths();
  if (!paths.includes(sourcePath)) {
    throw new Error(`Markdown note is not indexed in this vault: ${sourcePath}`);
  }
  if (paths.includes(targetPath)) {
    return { status: "conflict", from: sourcePath, to: targetPath, reason: "target-exists" };
  }

  const snapshots = await Promise.all(paths.map((filePath) => vault.readText(filePath)));
  const source = snapshots.find((snapshot) => snapshot.path === sourcePath);
  if (!source) {
    throw new Error(`Move preflight lost its source snapshot: ${sourcePath}`);
  }
  if (expectedSourceRevision && source.revision !== expectedSourceRevision) {
    return {
      status: "conflict",
      from: sourcePath,
      to: targetPath,
      reason: "source-revision-changed",
    };
  }
  const currentVault = new SnapshotVault(vault.getName(), snapshots);
  const projectedSnapshots = snapshots.map((snapshot) =>
    snapshot.path === sourcePath ? { ...snapshot, path: targetPath } : snapshot,
  );
  const projectedVault = new SnapshotVault(vault.getName(), projectedSnapshots);
  const [currentIndex, projectedIndex] = await Promise.all([
    MetadataIndex.build(currentVault),
    MetadataIndex.build(projectedVault),
  ]);
  const currentDocuments = new Map(
    currentIndex.snapshot().documents.map((document) => [document.path, document]),
  );
  const projectedDocuments = new Map(
    projectedIndex.snapshot().documents.map((document) => [document.path, document]),
  );
  const blockers: NoteMoveBlocker[] = [];

  for (const [documentPath, currentDocument] of currentDocuments) {
    const projectedPath = documentPath === sourcePath ? targetPath : documentPath;
    const projectedDocument = projectedDocuments.get(projectedPath);
    if (!projectedDocument || projectedDocument.links.length !== currentDocument.links.length) {
      throw new Error(`Move preflight could not compare links for ${documentPath}.`);
    }
    for (let index = 0; index < currentDocument.links.length; index += 1) {
      const currentLink = currentDocument.links[index];
      const projectedLink = projectedDocument.links[index];
      if (!currentLink || !projectedLink) {
        continue;
      }
      const expectedResolution = remapResolution(currentLink.resolution, sourcePath, targetPath);
      if (!resolutionsEqual(expectedResolution, projectedLink.resolution)) {
        blockers.push({
          documentPath,
          target: currentLink.target,
          syntax: currentLink.syntax,
          before: currentLink.resolution,
          after: projectedLink.resolution,
        });
      }
    }
  }

  if (blockers.length > 0) {
    return { status: "blocked", from: sourcePath, to: targetPath, blockers };
  }
  return vault.renameFile(sourcePath, targetPath, source.revision);
}
