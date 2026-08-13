import { createHash } from "node:crypto";
import path from "node:path";
import { type ParsedMarkdownLink, parseMarkdownLinks } from "../kernel/markdown-links";
import type { VisibleVaultPaths } from "../kernel/path-policy";
import { hasPrivateVaultSegment, normalizeVaultPath } from "../kernel/path-policy";
import type { VaultMutationPort, VaultReadPort, VaultTextSnapshot } from "../kernel/ports";
import { DEFAULT_VAULT_ATTACHMENT_MAX_BYTES } from "./vault-attachment-service";

/** A binary move reads only enough to obtain a bounded snapshot and revision. */
export const MAX_ATTACHMENT_MOVE_BYTES = DEFAULT_VAULT_ATTACHMENT_MAX_BYTES;

export interface AttachmentLinkRewrite {
  documentPath: string;
  line: number;
  syntax: "wiki" | "markdown";
  embed: boolean;
  beforeTarget: string;
  afterTarget: string;
  sourcePath: string;
  targetPath: string;
}

export interface AttachmentMoveWriteProposal {
  path: string;
  expectedRevision: string;
  content: string;
}

export interface AttachmentMoveBlocker {
  documentPath: string;
  line: number;
  target: string;
  syntax: "wiki" | "markdown";
  reason: "ambiguous" | "unresolved" | "unsupported";
  candidates: string[];
}

export type AttachmentMovePlan =
  | { status: "conflict"; from: string; to: string; reason: string }
  | {
      status: "planned";
      from: string;
      to: string;
      sourceRevision: string;
      rewrites: AttachmentLinkRewrite[];
      blockers: AttachmentMoveBlocker[];
      writes: AttachmentMoveWriteProposal[];
      confirmationId: string | null;
    };

export type AttachmentMoveOutcome =
  | Extract<AttachmentMovePlan, { status: "conflict" }>
  | { status: "blocked"; from: string; to: string; blockers: AttachmentMoveBlocker[] }
  | {
      status: "requires-confirmation";
      from: string;
      to: string;
      confirmationId: string;
      rewrites: AttachmentLinkRewrite[];
    }
  | {
      status: "committed";
      from: string;
      to: string;
      transactionId: string;
      rewrites: AttachmentLinkRewrite[];
      writes: Array<{ path: string; revision: string }>;
    };

export interface AttachmentMoveOptions {
  confirmationId?: string;
  acceptCurrentRewrites?: boolean;
  /** Apply a previously displayed preview without rebuilding it over a changed external winner. */
  plan?: AttachmentMovePlan;
}

interface AttachmentVaultReadPort extends VaultReadPort {
  listVisiblePaths?(relativeDirectory?: string): Promise<VisibleVaultPaths>;
}

interface LinkResolution {
  status: "resolved" | "unresolved" | "ambiguous";
  path?: string;
  candidates?: string[];
}

interface PlannedCandidate {
  link: ParsedMarkdownLink;
  resolution: LinkResolution;
  snapshot: VaultTextSnapshot;
  rewritten: string;
  rewrite: AttachmentLinkRewrite;
}

function normalizedKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function decodeTarget(rawTarget: string): string | null {
  const trimmed = rawTarget.trim();
  const unwrapped =
    trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  try {
    return decodeURIComponent(unwrapped).replaceAll("\\", "/");
  } catch {
    return null;
  }
}

function isExternalTarget(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith("//");
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
  if (value === "." || value === "..") return value;
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function replacementTarget(
  syntax: "wiki" | "markdown",
  documentPath: string,
  targetPath: string,
): string {
  if (syntax === "wiki") return encodeWikiTarget(targetPath);
  const relative = path.posix.relative(path.posix.dirname(documentPath), targetPath);
  const encoded = relative.split("/").map(encodeMarkdownSegment).join("/");
  return encoded.includes("/") ? encoded : `./${encoded}`;
}

function isAttachmentPath(filePath: string): boolean {
  return !filePath.toLocaleLowerCase("en-US").endsWith(".md");
}

async function collectVisibleFiles(vault: AttachmentVaultReadPort): Promise<string[]> {
  if (!vault.listVisiblePaths) return vault.listMarkdownPaths();
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const listing = await vault.listVisiblePaths?.(directory);
    if (!listing?.exists) return;
    files.push(...listing.files);
    for (const folder of listing.folders) await visit(folder);
  };
  await visit("");
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

function matchingCandidates(
  sourcePath: string,
  rawTarget: string,
  visibleFiles: readonly string[],
): string[] {
  const decoded = decodeTarget(rawTarget);
  if (!decoded?.trim() || isExternalTarget(decoded)) return [];
  const rooted = decoded.startsWith("/");
  const withoutRoot = decoded.replace(/^\/+/, "");
  let candidate: string;
  try {
    candidate = normalizeVaultPath(
      rooted ? withoutRoot : path.posix.join(path.posix.dirname(sourcePath), withoutRoot),
    );
  } catch {
    return [];
  }
  const foldedCandidate = normalizedKey(candidate);
  const exact = visibleFiles.filter((filePath) => normalizedKey(filePath) === foldedCandidate);
  if (exact.length > 0) return exact;
  if (!decoded.includes("/")) {
    const foldedName = normalizedKey(path.posix.basename(withoutRoot));
    return visibleFiles.filter(
      (filePath) => normalizedKey(path.posix.basename(filePath)) === foldedName,
    );
  }
  return [];
}

function resolveAttachmentLink(
  documentPath: string,
  link: ParsedMarkdownLink,
  visibleFiles: readonly string[],
): LinkResolution {
  if (isExternalTarget(link.target)) return { status: "unresolved" };
  const candidates = matchingCandidates(documentPath, link.target, visibleFiles).filter(
    isAttachmentPath,
  );
  if (candidates.length === 1 && candidates[0]) return { status: "resolved", path: candidates[0] };
  if (candidates.length > 1) return { status: "ambiguous", candidates: candidates.sort() };
  return { status: "unresolved" };
}

function rewriteContent(content: string, candidates: readonly PlannedCandidate[]): string {
  let result = content;
  for (const candidate of [...candidates].sort(
    (left, right) => right.link.targetStart - left.link.targetStart,
  )) {
    result = `${result.slice(0, candidate.link.targetStart)}${candidate.rewrite.afterTarget}${result.slice(candidate.link.targetEnd)}`;
  }
  return result;
}

function confirmationIdFor(
  plan: Omit<Extract<AttachmentMovePlan, { status: "planned" }>, "confirmationId">,
): string {
  const payload = {
    version: 1,
    from: plan.from,
    to: plan.to,
    sourceRevision: plan.sourceRevision,
    rewrites: plan.rewrites,
    writes: plan.writes.map((write) => ({
      path: write.path,
      expectedRevision: write.expectedRevision,
      contentRevision: createHash("sha256").update(write.content, "utf8").digest("hex"),
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

/** Plan a non-note attachment move without ever decoding its bytes as text. */
export async function planBinaryAttachmentMove(
  vault: AttachmentVaultReadPort & {
    readBinary(
      relativePath: string,
      maxBytes: number,
    ): Promise<
      | {
          status: "ready";
          snapshot: { path: string; bytes: Buffer; revision: string; size: number };
        }
      | { status: "too-large"; path: string; size: number }
    >;
  },
  requestedSourcePath: string,
  requestedTargetPath: string,
  expectedSourceRevision?: string,
): Promise<AttachmentMovePlan> {
  let sourcePath = normalizeVaultPath(requestedSourcePath);
  const targetPath = normalizeVaultPath(requestedTargetPath);
  if (!isAttachmentPath(sourcePath) || !isAttachmentPath(targetPath)) {
    throw new Error("Attachment moves require non-Markdown source and destination files.");
  }
  if (hasPrivateVaultSegment(sourcePath) || hasPrivateVaultSegment(targetPath)) {
    throw new Error("Attachment moves cannot target private application paths.");
  }
  if (sourcePath === targetPath)
    throw new Error("Attachment move source and destination must differ.");
  const visibleFiles = await collectVisibleFiles(vault);
  const folded = visibleFiles.map(normalizedKey);
  const visibleSourcePath = visibleFiles.find(
    (candidate) => normalizedKey(candidate) === normalizedKey(sourcePath),
  );
  if (!visibleSourcePath) {
    throw new Error(`Attachment is not present in the visible vault: ${sourcePath}`);
  }
  // Keep the on-disk spelling for the kernel call while resolving user/link
  // paths case-insensitively and by NFC, as the metadata index does.
  sourcePath = visibleSourcePath;
  if (folded.includes(normalizedKey(targetPath))) {
    return { status: "conflict", from: sourcePath, to: targetPath, reason: "target-exists" };
  }
  const sourceResult = await vault.readBinary(sourcePath, MAX_ATTACHMENT_MOVE_BYTES);
  if (sourceResult.status !== "ready")
    throw new Error("Attachment source exceeds the bounded mutation read limit.");
  if (expectedSourceRevision && sourceResult.snapshot.revision !== expectedSourceRevision) {
    return {
      status: "conflict",
      from: sourcePath,
      to: targetPath,
      reason: "source-revision-changed",
    };
  }

  const markdownPaths = await vault.listMarkdownPaths();
  const rewrites: AttachmentLinkRewrite[] = [];
  const writes: AttachmentMoveWriteProposal[] = [];
  for (const documentPath of markdownPaths) {
    const snapshot = await vault.readText(documentPath);
    const candidates: PlannedCandidate[] = [];
    for (const link of parseMarkdownLinks(snapshot.content)) {
      const resolution = resolveAttachmentLink(documentPath, link, visibleFiles);
      if (resolution.status !== "resolved" || resolution.path !== sourcePath) {
        if (
          resolution.status === "ambiguous" &&
          resolution.candidates?.some(
            (candidate) => normalizedKey(candidate) === normalizedKey(sourcePath),
          )
        ) {
          rewrites.push({
            documentPath,
            line: link.line,
            syntax: link.syntax,
            embed: link.embed,
            beforeTarget: link.target,
            afterTarget: "",
            sourcePath,
            targetPath,
          });
        }
        continue;
      }
      const afterTarget = replacementTarget(link.syntax, documentPath, targetPath);
      const rewrite: AttachmentLinkRewrite = {
        documentPath,
        line: link.line,
        syntax: link.syntax,
        embed: link.embed,
        beforeTarget: snapshot.content.slice(link.targetStart, link.targetEnd),
        afterTarget,
        sourcePath,
        targetPath,
      };
      candidates.push({ link, resolution, snapshot, rewritten: "", rewrite });
    }
    if (candidates.length > 0) {
      const content = rewriteContent(snapshot.content, candidates);
      writes.push({ path: documentPath, expectedRevision: snapshot.revision, content });
      for (const candidate of candidates) {
        const index = rewrites.findIndex(
          (rewrite) =>
            rewrite.documentPath === documentPath &&
            rewrite.line === candidate.link.line &&
            rewrite.beforeTarget === candidate.rewrite.beforeTarget,
        );
        if (index >= 0) rewrites[index] = candidate.rewrite;
        else rewrites.push(candidate.rewrite);
      }
    }
  }
  const blockers = rewrites
    .filter((rewrite) => rewrite.afterTarget === "")
    .map((rewrite) => ({
      documentPath: rewrite.documentPath,
      line: rewrite.line,
      target: rewrite.beforeTarget,
      syntax: rewrite.syntax,
      reason: "ambiguous" as const,
      candidates: visibleFiles.filter(
        (candidate) =>
          normalizedKey(path.posix.basename(candidate)) ===
          normalizedKey(path.posix.basename(sourcePath)),
      ),
    }));
  const plannedWithoutId = {
    status: "planned" as const,
    from: sourcePath,
    to: targetPath,
    sourceRevision: sourceResult.snapshot.revision,
    rewrites: rewrites.filter((rewrite) => rewrite.afterTarget !== ""),
    blockers,
    writes,
    confirmationId: null,
  };
  const confirmationId = writes.length > 0 ? confirmationIdFor(plannedWithoutId) : null;
  return { ...plannedWithoutId, confirmationId };
}

export async function moveBinaryAttachment(
  vault: VaultMutationPort &
    AttachmentVaultReadPort & {
      readBinary(
        relativePath: string,
        maxBytes: number,
      ): Promise<
        | {
            status: "ready";
            snapshot: { path: string; bytes: Buffer; revision: string; size: number };
          }
        | { status: "too-large"; path: string; size: number }
      >;
    },
  requestedSourcePath: string,
  requestedTargetPath: string,
  expectedSourceRevision?: string,
  options: AttachmentMoveOptions = {},
): Promise<AttachmentMoveOutcome> {
  const plan =
    options.plan ??
    (await planBinaryAttachmentMove(
      vault,
      requestedSourcePath,
      requestedTargetPath,
      expectedSourceRevision,
    ));
  if (plan.status === "conflict") return plan;
  if (plan.blockers.length > 0)
    return { status: "blocked", from: plan.from, to: plan.to, blockers: plan.blockers };
  if (
    plan.writes.length > 0 &&
    !options.acceptCurrentRewrites &&
    options.confirmationId !== plan.confirmationId
  ) {
    if (!plan.confirmationId)
      throw new Error("Attachment rewrite plan lost its confirmation identity.");
    return {
      status: "requires-confirmation",
      from: plan.from,
      to: plan.to,
      confirmationId: plan.confirmationId,
      rewrites: plan.rewrites,
    };
  }
  const result =
    plan.writes.length > 0
      ? await vault.moveWithWrites({
          sourcePath: plan.from,
          targetPath: plan.to,
          expectedSourceRevision: plan.sourceRevision,
          writes: plan.writes,
        })
      : await vault.renameFile(plan.from, plan.to, plan.sourceRevision);
  if (result.status === "conflict") {
    return { status: "conflict", from: result.from, to: result.to, reason: result.reason };
  }
  const revisions: Array<{ path: string; revision: string }> =
    plan.writes.length > 0 && "writes" in result
      ? (result.writes as Array<{ path: string; revision: string }>)
      : [];
  return {
    status: "committed",
    from: result.from,
    to: result.to,
    transactionId: result.transactionId,
    rewrites: plan.rewrites,
    writes: revisions,
  };
}

export function renamedAttachmentPath(sourcePath: string, requestedName: string): string {
  const source = normalizeVaultPath(sourcePath);
  const name = requestedName.trim();
  if (!name || name.includes("/") || name.includes("\\")) {
    throw new Error("A renamed attachment requires one filename without directory separators.");
  }
  return normalizeVaultPath(path.posix.join(path.posix.dirname(source), name));
}

export function movedAttachmentPath(sourcePath: string, requestedTarget: string): string {
  const source = normalizeVaultPath(sourcePath);
  const target = requestedTarget.trim();
  if (!target) throw new Error("A moved attachment requires a destination path.");
  if (target.endsWith("/") || target.endsWith("\\"))
    return normalizeVaultPath(
      path.posix.join(target.replaceAll("\\", "/"), path.posix.basename(source)),
    );
  return normalizeVaultPath(target);
}

export const planVaultAttachmentMove = planBinaryAttachmentMove;
export const moveVaultAttachment = moveBinaryAttachment;
export const planAttachmentMove = planBinaryAttachmentMove;
export const moveAttachment = moveBinaryAttachment;
