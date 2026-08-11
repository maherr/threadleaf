import path from "node:path";
import { parseMarkdownLinks } from "../kernel/markdown-links";
import { type LinkResolution, MetadataIndex } from "../kernel/metadata-index";
import { normalizeMarkdownNotePath } from "../kernel/note-path";
import type { VaultMutationPort, VaultReadPort, VaultTextSnapshot } from "../kernel/ports";
import type { NoteMoveBlocker, NoteMoveOutcome } from "../shared/contracts";

export interface NoteMoveRewrite {
  documentPath: string;
  resultPath: string;
  line: number;
  syntax: "wiki" | "markdown";
  beforeTarget: string;
  afterTarget: string;
  before: LinkResolution;
  after: LinkResolution;
}

export interface NoteMoveWriteProposal {
  path: string;
  resultPath: string;
  expectedRevision: string;
  content: string;
}

export type NoteMovePlan =
  | { status: "conflict"; from: string; to: string; reason: string }
  | {
      status: "planned";
      from: string;
      to: string;
      sourceRevision: string;
      blockers: NoteMoveBlocker[];
      rewrites: NoteMoveRewrite[];
      writes: NoteMoveWriteProposal[];
    };

interface InternalRewrite {
  key: string;
  start: number;
  end: number;
  rewrite: NoteMoveRewrite;
}

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

function withoutMarkdownExtension(value: string): string {
  return value.toLocaleLowerCase("en-US").endsWith(".md") ? value.slice(0, -3) : value;
}

function encodeWikiTarget(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("#", "%23")
    .replaceAll("^", "%5E")
    .replaceAll("|", "%7C")
    .replaceAll("[", "%5B")
    .replaceAll("]", "%5D");
}

function encodeMarkdownSegment(value: string): string {
  if (value === "." || value === "..") {
    return value;
  }
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function replacementTarget(
  syntax: "wiki" | "markdown",
  resultPath: string,
  resolvedTargetPath: string,
): string {
  if (syntax === "wiki") {
    return encodeWikiTarget(withoutMarkdownExtension(resolvedTargetPath));
  }
  const relative = path.posix.relative(path.posix.dirname(resultPath), resolvedTargetPath);
  const encoded = relative.split("/").map(encodeMarkdownSegment).join("/");
  return encoded.includes("/") ? encoded : `./${encoded}`;
}

function blockerFor(
  documentPath: string,
  target: string,
  syntax: "wiki" | "markdown",
  before: LinkResolution,
  after: LinkResolution,
): NoteMoveBlocker {
  return { documentPath, target, syntax, before, after };
}

function applyRewrites(content: string, rewrites: readonly InternalRewrite[]): string {
  let result = content;
  for (const candidate of [...rewrites].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, candidate.start)}${candidate.rewrite.afterTarget}${result.slice(candidate.end)}`;
  }
  return result;
}

export async function planMarkdownNoteMove(
  vault: VaultReadPort,
  requestedSourcePath: string,
  requestedTargetPath: string,
  expectedSourceRevision?: string,
): Promise<NoteMovePlan> {
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
  const snapshotsByPath = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot]));
  const source = snapshotsByPath.get(sourcePath);
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
  const initiallyProjectedSnapshots = snapshots.map((snapshot) =>
    snapshot.path === sourcePath ? { ...snapshot, path: targetPath } : snapshot,
  );
  const initiallyProjectedVault = new SnapshotVault(vault.getName(), initiallyProjectedSnapshots);
  const [currentIndex, initiallyProjectedIndex] = await Promise.all([
    MetadataIndex.build(currentVault),
    MetadataIndex.build(initiallyProjectedVault),
  ]);
  const currentDocuments = new Map(
    currentIndex.snapshot().documents.map((document) => [document.path, document]),
  );
  const initiallyProjectedDocuments = new Map(
    initiallyProjectedIndex.snapshot().documents.map((document) => [document.path, document]),
  );
  const expectedByOccurrence = new Map<string, LinkResolution>();
  const blockersByOccurrence = new Map<string, NoteMoveBlocker>();
  const candidates: InternalRewrite[] = [];

  for (const [documentPath, currentDocument] of currentDocuments) {
    const snapshot = snapshotsByPath.get(documentPath);
    if (!snapshot) {
      throw new Error(`Move preflight lost the document snapshot for ${documentPath}.`);
    }
    const parsedLinks = parseMarkdownLinks(snapshot.content);
    const resultPath = documentPath === sourcePath ? targetPath : documentPath;
    const initiallyProjectedDocument = initiallyProjectedDocuments.get(resultPath);
    if (
      !initiallyProjectedDocument ||
      initiallyProjectedDocument.links.length !== currentDocument.links.length ||
      parsedLinks.length !== currentDocument.links.length
    ) {
      throw new Error(`Move preflight could not compare links for ${documentPath}.`);
    }

    for (let index = 0; index < currentDocument.links.length; index += 1) {
      const key = `${documentPath}\0${index}`;
      const currentLink = currentDocument.links[index];
      const initiallyProjectedLink = initiallyProjectedDocument.links[index];
      const parsedLink = parsedLinks[index];
      if (!currentLink || !initiallyProjectedLink || !parsedLink) {
        throw new Error(`Move preflight lost link ${index + 1} in ${documentPath}.`);
      }
      const expectedResolution = remapResolution(currentLink.resolution, sourcePath, targetPath);
      expectedByOccurrence.set(key, expectedResolution);
      if (resolutionsEqual(expectedResolution, initiallyProjectedLink.resolution)) {
        continue;
      }
      if (currentLink.resolution.status !== "resolved" || !currentLink.resolution.path) {
        blockersByOccurrence.set(
          key,
          blockerFor(
            documentPath,
            currentLink.target,
            currentLink.syntax,
            currentLink.resolution,
            initiallyProjectedLink.resolution,
          ),
        );
        continue;
      }
      const resolvedTargetPath =
        currentLink.resolution.path === sourcePath ? targetPath : currentLink.resolution.path;
      candidates.push({
        key,
        start: parsedLink.targetStart,
        end: parsedLink.targetEnd,
        rewrite: {
          documentPath,
          resultPath,
          line: parsedLink.line,
          syntax: currentLink.syntax,
          beforeTarget: snapshot.content.slice(parsedLink.targetStart, parsedLink.targetEnd),
          afterTarget: replacementTarget(currentLink.syntax, resultPath, resolvedTargetPath),
          before: currentLink.resolution,
          after: initiallyProjectedLink.resolution,
        },
      });
    }
  }

  const candidatesByPath = new Map<string, InternalRewrite[]>();
  for (const candidate of candidates) {
    const entries = candidatesByPath.get(candidate.rewrite.documentPath) ?? [];
    entries.push(candidate);
    candidatesByPath.set(candidate.rewrite.documentPath, entries);
  }

  const applicable: InternalRewrite[] = [];
  for (const [documentPath, entries] of candidatesByPath) {
    const sorted = [...entries].sort((left, right) => left.start - right.start);
    const overlapping = new Set<string>();
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous && current && current.start < previous.end) {
        overlapping.add(previous.key);
        overlapping.add(current.key);
      }
    }
    for (const candidate of sorted) {
      if (!overlapping.has(candidate.key)) {
        applicable.push(candidate);
        continue;
      }
      blockersByOccurrence.set(
        candidate.key,
        blockerFor(
          documentPath,
          candidate.rewrite.beforeTarget,
          candidate.rewrite.syntax,
          candidate.rewrite.before,
          candidate.rewrite.after,
        ),
      );
    }
  }

  const applicableByPath = new Map<string, InternalRewrite[]>();
  for (const candidate of applicable) {
    const entries = applicableByPath.get(candidate.rewrite.documentPath) ?? [];
    entries.push(candidate);
    applicableByPath.set(candidate.rewrite.documentPath, entries);
  }
  const rewrittenContent = new Map<string, string>();
  for (const [documentPath, entries] of applicableByPath) {
    const snapshot = snapshotsByPath.get(documentPath);
    if (!snapshot) {
      throw new Error(`Move rewrite lost the document snapshot for ${documentPath}.`);
    }
    rewrittenContent.set(documentPath, applyRewrites(snapshot.content, entries));
  }

  const finalProjectedSnapshots = snapshots.map((snapshot) => {
    const content = rewrittenContent.get(snapshot.path) ?? snapshot.content;
    const resultPath = snapshot.path === sourcePath ? targetPath : snapshot.path;
    return {
      ...snapshot,
      path: resultPath,
      content,
      size: Buffer.byteLength(content),
    };
  });
  const finalIndex = await MetadataIndex.build(
    new SnapshotVault(vault.getName(), finalProjectedSnapshots),
  );
  const finalDocuments = new Map(
    finalIndex.snapshot().documents.map((document) => [document.path, document]),
  );
  for (const [documentPath, currentDocument] of currentDocuments) {
    const resultPath = documentPath === sourcePath ? targetPath : documentPath;
    const finalDocument = finalDocuments.get(resultPath);
    if (!finalDocument || finalDocument.links.length !== currentDocument.links.length) {
      throw new Error(`Move rewrite validation could not compare links for ${documentPath}.`);
    }
    for (let index = 0; index < currentDocument.links.length; index += 1) {
      const key = `${documentPath}\0${index}`;
      const currentLink = currentDocument.links[index];
      const finalLink = finalDocument.links[index];
      const expectedResolution = expectedByOccurrence.get(key);
      if (!currentLink || !finalLink || !expectedResolution) {
        throw new Error(`Move rewrite validation lost link ${index + 1} in ${documentPath}.`);
      }
      if (!resolutionsEqual(expectedResolution, finalLink.resolution)) {
        blockersByOccurrence.set(
          key,
          blockerFor(
            documentPath,
            currentLink.target,
            currentLink.syntax,
            currentLink.resolution,
            finalLink.resolution,
          ),
        );
      }
    }
  }

  const rewrites = applicable
    .map((candidate) => candidate.rewrite)
    .sort(
      (left, right) =>
        left.documentPath.localeCompare(right.documentPath) || left.line - right.line,
    );
  const writes = [...rewrittenContent.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([documentPath, content]) => {
      const snapshot = snapshotsByPath.get(documentPath);
      if (!snapshot) {
        throw new Error(`Move write plan lost the document snapshot for ${documentPath}.`);
      }
      return {
        path: documentPath,
        resultPath: documentPath === sourcePath ? targetPath : documentPath,
        expectedRevision: snapshot.revision,
        content,
      };
    });
  return {
    status: "planned",
    from: sourcePath,
    to: targetPath,
    sourceRevision: source.revision,
    blockers: [...blockersByOccurrence.values()],
    rewrites,
    writes,
  };
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
  const plan = await planMarkdownNoteMove(
    vault,
    requestedSourcePath,
    requestedTargetPath,
    expectedSourceRevision,
  );
  if (plan.status === "conflict") {
    return plan;
  }
  const rewriteBlockers = plan.rewrites.map((rewrite) =>
    blockerFor(
      rewrite.documentPath,
      rewrite.beforeTarget,
      rewrite.syntax,
      rewrite.before,
      rewrite.after,
    ),
  );
  const blockers = [...plan.blockers, ...rewriteBlockers];
  if (blockers.length > 0) {
    return { status: "blocked", from: plan.from, to: plan.to, blockers };
  }
  return vault.renameFile(plan.from, plan.to, plan.sourceRevision);
}
