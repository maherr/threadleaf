import { createHash } from "node:crypto";
import path from "node:path";
import { parseMarkdownLinks } from "../kernel/markdown-links";
import {
  type LinkResolution,
  MetadataIndex,
  type MetadataIndexSnapshot,
  VaultLinkResolver,
} from "../kernel/metadata-index";
import { normalizeMarkdownNotePath } from "../kernel/note-path";
import type { VaultMutationPort, VaultReadPort, VaultTextSnapshot } from "../kernel/ports";
import type { NoteMoveBlocker, NoteMoveOutcome, NoteMoveRewritePreview } from "../shared/contracts";
import type { AutomaticLinkUpdatePolicy, WorkspaceLinkStyle } from "../shared/workspace-settings";

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

export interface NoteMoveOptions {
  confirmationId?: string;
  acceptCurrentRewrites?: boolean;
  indexSnapshot?: MetadataIndexSnapshot;
  automaticLinkUpdates?: AutomaticLinkUpdatePolicy;
  linkStyle?: WorkspaceLinkStyle;
}

interface InternalRewrite {
  key: string;
  replacementStart: number;
  replacementEnd: number;
  replacementText: string;
  rewrite: NoteMoveRewrite;
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

function renderedLink(
  parsedLink: ReturnType<typeof parseMarkdownLinks>[number],
  style: WorkspaceLinkStyle,
  resultPath: string,
  resolvedTargetPath: string,
): {
  target: string;
  syntax: "wiki" | "markdown";
  replacementStart: number;
  replacementEnd: number;
  replacementText: string;
} {
  const requestedSyntax = style === "wikilink" ? "wiki" : "markdown";
  if (style === "preserve" || parsedLink.syntax === requestedSyntax) {
    const target = replacementTarget(parsedLink.syntax, resultPath, resolvedTargetPath);
    return {
      target,
      syntax: parsedLink.syntax,
      replacementStart: parsedLink.targetStart,
      replacementEnd: parsedLink.targetEnd,
      replacementText: replacementTarget(parsedLink.syntax, resultPath, resolvedTargetPath),
    };
  }

  const target = replacementTarget(requestedSyntax, resultPath, resolvedTargetPath);
  const subpath = parsedLink.subpath ?? "";
  if (requestedSyntax === "wiki") {
    const alias = parsedLink.alias ? `|${parsedLink.alias}` : "";
    return {
      target,
      syntax: "wiki",
      replacementStart: parsedLink.position,
      replacementEnd: parsedLink.end,
      replacementText: `${parsedLink.embed ? "!" : ""}[[${target}${subpath}${alias}]]`,
    };
  }

  const markdownLabel =
    parsedLink.alias ?? withoutMarkdownExtension(path.posix.basename(resolvedTargetPath));
  return {
    target,
    syntax: "markdown",
    replacementStart: parsedLink.position,
    replacementEnd: parsedLink.end,
    replacementText: `${parsedLink.embed ? "!" : ""}[${markdownLabel}](${target}${subpath})`,
  };
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
  for (const candidate of [...rewrites].sort(
    (left, right) => right.replacementStart - left.replacementStart,
  )) {
    result = `${result.slice(0, candidate.replacementStart)}${candidate.replacementText}${result.slice(candidate.replacementEnd)}`;
  }
  return result;
}

function rewritePreview(rewrite: NoteMoveRewrite): NoteMoveRewritePreview {
  return {
    documentPath: rewrite.documentPath,
    resultPath: rewrite.resultPath,
    line: rewrite.line,
    syntax: rewrite.syntax,
    beforeTarget: rewrite.beforeTarget,
    afterTarget: rewrite.afterTarget,
  };
}

function confirmationIdFor(plan: Extract<NoteMovePlan, { status: "planned" }>): string {
  const payload = {
    version: 1,
    from: plan.from,
    to: plan.to,
    sourceRevision: plan.sourceRevision,
    rewrites: plan.rewrites.map(rewritePreview),
    writes: plan.writes.map((write) => ({
      path: write.path,
      resultPath: write.resultPath,
      expectedRevision: write.expectedRevision,
      contentRevision: createHash("sha256").update(write.content, "utf8").digest("hex"),
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

export async function planMarkdownNoteMove(
  vault: VaultReadPort,
  requestedSourcePath: string,
  requestedTargetPath: string,
  expectedSourceRevision?: string,
  suppliedIndex?: MetadataIndexSnapshot,
  options: Pick<NoteMoveOptions, "automaticLinkUpdates" | "linkStyle"> = {},
): Promise<NoteMovePlan> {
  const sourcePath = normalizeMarkdownNotePath(requestedSourcePath);
  const targetPath = normalizeMarkdownNotePath(requestedTargetPath);
  if (sourcePath === targetPath) {
    throw new Error("Move source and destination must be different.");
  }

  const currentIndex = suppliedIndex ?? (await MetadataIndex.build(vault)).snapshot();
  const paths = currentIndex.documents.map((document) => document.path);
  if (!paths.includes(sourcePath)) {
    throw new Error(`Markdown note is not indexed in this vault: ${sourcePath}`);
  }
  if (paths.includes(targetPath)) {
    return { status: "conflict", from: sourcePath, to: targetPath, reason: "target-exists" };
  }

  const currentDocuments = new Map(
    currentIndex.documents.map((document) => [document.path, document]),
  );
  const source = await vault.readText(sourcePath);
  if (expectedSourceRevision && source.revision !== expectedSourceRevision) {
    return {
      status: "conflict",
      from: sourcePath,
      to: targetPath,
      reason: "source-revision-changed",
    };
  }
  if (currentDocuments.get(sourcePath)?.revision !== source.revision) {
    throw new Error(
      "The vault index changed while preparing this move. Wait for indexing and retry.",
    );
  }

  if (options.automaticLinkUpdates === "never") {
    return {
      status: "planned",
      from: sourcePath,
      to: targetPath,
      sourceRevision: source.revision,
      blockers: [],
      rewrites: [],
      writes: [],
    };
  }

  const projectedPaths = paths.map((filePath) => (filePath === sourcePath ? targetPath : filePath));
  const projectedResolver = new VaultLinkResolver(projectedPaths);
  const expectedByOccurrence = new Map<string, LinkResolution>();
  const blockersByOccurrence = new Map<string, NoteMoveBlocker>();
  const candidateIndexesByPath = new Map<string, number[]>();

  for (const [documentPath, currentDocument] of currentDocuments) {
    const resultPath = documentPath === sourcePath ? targetPath : documentPath;
    for (let index = 0; index < currentDocument.links.length; index += 1) {
      const key = `${documentPath}\0${index}`;
      const currentLink = currentDocument.links[index];
      if (!currentLink) {
        throw new Error(`Move preflight lost link ${index + 1} in ${documentPath}.`);
      }
      const expectedResolution = remapResolution(currentLink.resolution, sourcePath, targetPath);
      expectedByOccurrence.set(key, expectedResolution);
      const projectedResolution = projectedResolver.resolve(resultPath, currentLink.target);
      if (resolutionsEqual(expectedResolution, projectedResolution)) {
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
            projectedResolution,
          ),
        );
        continue;
      }
      const candidateIndexes = candidateIndexesByPath.get(documentPath) ?? [];
      candidateIndexes.push(index);
      candidateIndexesByPath.set(documentPath, candidateIndexes);
    }
  }

  const snapshotsByPath = new Map<string, VaultTextSnapshot>([[sourcePath, source]]);
  const candidatesByPath = new Map<string, InternalRewrite[]>();
  for (const [documentPath, indexes] of candidateIndexesByPath) {
    const currentDocument = currentDocuments.get(documentPath);
    if (!currentDocument) {
      throw new Error(`Move preflight lost indexed metadata for ${documentPath}.`);
    }
    const snapshot = snapshotsByPath.get(documentPath) ?? (await vault.readText(documentPath));
    snapshotsByPath.set(documentPath, snapshot);
    if (snapshot.revision !== currentDocument.revision) {
      throw new Error(
        "The vault index changed while preparing this move. Wait for indexing and retry.",
      );
    }
    const parsedLinks = parseMarkdownLinks(snapshot.content);
    if (parsedLinks.length !== currentDocument.links.length) {
      throw new Error(`Move preflight could not compare links for ${documentPath}.`);
    }
    const resultPath = documentPath === sourcePath ? targetPath : documentPath;
    const entries: InternalRewrite[] = [];
    for (const index of indexes) {
      const key = `${documentPath}\0${index}`;
      const currentLink = currentDocument.links[index];
      const parsedLink = parsedLinks[index];
      if (
        !currentLink ||
        !parsedLink ||
        currentLink.syntax !== parsedLink.syntax ||
        currentLink.target !== parsedLink.target
      ) {
        throw new Error(`Move preflight lost link ${index + 1} in ${documentPath}.`);
      }
      const resolvedTargetPath =
        currentLink.resolution.path === sourcePath ? targetPath : currentLink.resolution.path;
      if (!resolvedTargetPath) {
        throw new Error(`Move preflight lost a resolved target in ${documentPath}.`);
      }
      const rendered = renderedLink(
        parsedLink,
        options.linkStyle ?? "preserve",
        resultPath,
        resolvedTargetPath,
      );
      entries.push({
        key,
        replacementStart: rendered.replacementStart,
        replacementEnd: rendered.replacementEnd,
        replacementText: rendered.replacementText,
        rewrite: {
          documentPath,
          resultPath,
          line: parsedLink.line,
          syntax: rendered.syntax,
          beforeTarget: snapshot.content.slice(parsedLink.targetStart, parsedLink.targetEnd),
          afterTarget: rendered.target,
          before: currentLink.resolution,
          after: projectedResolver.resolve(
            resultPath,
            (options.linkStyle ?? "preserve") === "preserve" ? currentLink.target : rendered.target,
          ),
        },
      });
    }
    candidatesByPath.set(documentPath, entries);
  }

  const applicable: InternalRewrite[] = [];
  for (const [documentPath, entries] of candidatesByPath) {
    const sorted = [...entries].sort(
      (left, right) => left.replacementStart - right.replacementStart,
    );
    const overlapping = new Set<string>();
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous && current && current.replacementStart < previous.replacementEnd) {
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

  const applicableByKey = new Map(applicable.map((candidate) => [candidate.key, candidate]));
  for (const [documentPath, currentDocument] of currentDocuments) {
    const resultPath = documentPath === sourcePath ? targetPath : documentPath;
    for (let index = 0; index < currentDocument.links.length; index += 1) {
      const key = `${documentPath}\0${index}`;
      const currentLink = currentDocument.links[index];
      const expectedResolution = expectedByOccurrence.get(key);
      if (!currentLink || !expectedResolution) {
        throw new Error(`Move rewrite validation lost link ${index + 1} in ${documentPath}.`);
      }
      const replacement = applicableByKey.get(key);
      const finalTarget = replacement
        ? (parseMarkdownLinks(
            replacement.rewrite.syntax === "wiki"
              ? `[[${replacement.rewrite.afterTarget}]]`
              : `[link](${replacement.rewrite.afterTarget})`,
          )[0]?.target ?? replacement.rewrite.afterTarget)
        : currentLink.target;
      const finalResolution = projectedResolver.resolve(resultPath, finalTarget);
      if (!resolutionsEqual(expectedResolution, finalResolution)) {
        blockersByOccurrence.set(
          key,
          blockerFor(
            documentPath,
            currentLink.target,
            currentLink.syntax,
            currentLink.resolution,
            finalResolution,
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
  options: NoteMoveOptions = {},
): Promise<NoteMoveOutcome> {
  const plan = await planMarkdownNoteMove(
    vault,
    requestedSourcePath,
    requestedTargetPath,
    expectedSourceRevision,
    options.indexSnapshot,
    options,
  );
  if (plan.status === "conflict") {
    return plan;
  }
  if (plan.blockers.length > 0) {
    return { status: "blocked", from: plan.from, to: plan.to, blockers: plan.blockers };
  }
  const rewrites = plan.rewrites.map(rewritePreview);
  if (plan.writes.length > 0) {
    const confirmationId = confirmationIdFor(plan);
    if (
      !options.acceptCurrentRewrites &&
      options.automaticLinkUpdates !== "always" &&
      options.confirmationId !== confirmationId
    ) {
      return {
        status: "requires-confirmation",
        from: plan.from,
        to: plan.to,
        confirmationId,
        rewrites,
      };
    }
    const result = await vault.moveWithWrites({
      sourcePath: plan.from,
      targetPath: plan.to,
      expectedSourceRevision: plan.sourceRevision,
      writes: plan.writes.map((write) => ({
        path: write.path,
        content: write.content,
        expectedRevision: write.expectedRevision,
      })),
    });
    if (result.status === "conflict") {
      return {
        status: "conflict",
        from: result.from,
        to: result.to,
        reason: result.reason,
        ...(result.conflictPaths.length > 0 ? { conflictPaths: result.conflictPaths } : {}),
      };
    }
    const revisionByPath = new Map(result.writes.map((write) => [write.path, write.revision]));
    return {
      status: "committed",
      from: result.from,
      to: result.to,
      transactionId: result.transactionId,
      rewrites,
      writes: plan.writes.map((write) => {
        const revision = revisionByPath.get(write.path);
        if (!revision) {
          throw new Error(`Compound move result lost the revision for ${write.path}.`);
        }
        return {
          path: write.path,
          resultPath: write.resultPath,
          revision,
        };
      }),
    };
  }
  const result = await vault.renameFile(plan.from, plan.to, plan.sourceRevision);
  if (result.status === "conflict") {
    return result;
  }
  return { ...result, rewrites: [], writes: [] };
}
