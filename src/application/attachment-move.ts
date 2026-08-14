import { createHash } from "node:crypto";
import path from "node:path";
import {
  maskMarkdownCodeAndComments,
  type ParsedMarkdownLink,
  type ParsedMarkdownReferenceDefinitionCandidate,
  parseMarkdownDestinationTarget,
  parseMarkdownLinks,
  parseMarkdownReferenceDefinitionCandidates,
  parseMarkdownReferenceUsages,
} from "../kernel/markdown-links";
import { VaultLinkResolver } from "../kernel/metadata-index";
import type { VisibleVaultPaths } from "../kernel/path-policy";
import {
  hasPrivateVaultSegment,
  normalizedVaultPathIdentity,
  normalizeVaultPath,
} from "../kernel/path-policy";
import type {
  VaultMarkdownCorpus,
  VaultMutationPort,
  VaultReadPort,
  VaultTextSnapshot,
} from "../kernel/ports";
import {
  DEFAULT_VAULT_ATTACHMENT_MAX_BYTES,
  type ParsedVaultAttachmentTarget,
  parseVaultAttachmentTarget,
} from "./vault-attachment-service";

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

export interface AttachmentMoveMarkdownCorpus {
  /** Exact lexical Markdown paths included in the preview. */
  markdownPaths: string[];
  /** Revisions for every path, including notes with no rewritten link. */
  markdownRevisions: Array<{ path: string; revision: string }>;
  /** The metadata/index generation observed while the preview was built. */
  generation: number | null;
  /** The kernel-authoritative receipt passed into the mutation boundary. */
  kernel: VaultMarkdownCorpus;
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
  | {
      status: "conflict";
      from: string;
      to: string;
      reason: string;
      conflictPaths?: string[];
    }
  | {
      status: "planned";
      from: string;
      to: string;
      sourceRevision: string;
      rewrites: AttachmentLinkRewrite[];
      blockers: AttachmentMoveBlocker[];
      writes: AttachmentMoveWriteProposal[];
      corpus: AttachmentMoveMarkdownCorpus;
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
      status: "published-source-retained";
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
  /** Bind the mutation to the workspace generation used for its preview. */
  expectedGeneration?: number;
  /** Read the current workspace generation immediately before mutation. */
  currentGeneration?: () => number;
}

export interface AttachmentMovePlanningContext {
  generation?: number;
  currentGeneration?: () => number;
}

interface AttachmentVaultReadPort extends VaultReadPort {
  listVisiblePaths?(relativeDirectory?: string): Promise<VisibleVaultPaths>;
}

interface LinkResolution {
  status: "resolved" | "unresolved" | "ambiguous";
  path?: string;
  candidates?: string[];
  parsed?: ParsedVaultAttachmentTarget;
  rejectionReason?: "external" | "invalid" | "private" | "outside-vault";
}

interface PlannedCandidate {
  link: ParsedMarkdownLink;
  resolution: LinkResolution;
  snapshot: VaultTextSnapshot;
  rewritten: string;
  rewrite: AttachmentLinkRewrite;
}

function normalizedTextKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function encodeWikiSegment(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("?", "%3F")
    .replaceAll("#", "%23")
    .replaceAll("^", "%5E")
    .replaceAll("|", "%7C")
    .replaceAll("[", "%5B")
    .replaceAll("]", "%5D")
    .replaceAll("\\", "%5C");
}

function encodeWikiTarget(value: string): string {
  return value.split("/").map(encodeWikiSegment).join("/");
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
  suffix = "",
): string {
  const relative = path.posix.relative(path.posix.dirname(documentPath), targetPath);
  if (syntax === "wiki") return `${encodeWikiTarget(relative)}${suffix}`;
  const encoded = relative.split("/").map(encodeMarkdownSegment).join("/");
  return `${encoded.includes("/") ? encoded : `./${encoded}`}${suffix}`;
}

function isAttachmentPath(filePath: string): boolean {
  return !filePath.toLocaleLowerCase("en-US").endsWith(".md");
}

async function collectVisibleFiles(vault: AttachmentVaultReadPort): Promise<string[]> {
  if (!vault.listVisiblePaths) return vault.listMarkdownPaths();
  const listing = await vault.listVisiblePaths("");
  if (!listing.exists) return [];
  return [...new Set(listing.files)].sort((left, right) => left.localeCompare(right));
}

function resolveAttachmentLink(
  documentPath: string,
  rawTarget: string,
  resolver: VaultLinkResolver,
): LinkResolution {
  const parsed = parseVaultAttachmentTarget(documentPath, rawTarget);
  if (parsed.status === "rejected") {
    // Keep a local-looking destination in the preview as an explicit blocker
    // when path policy rejects it. External URLs are intentionally ignored.
    return parsed.reason === "external"
      ? { status: "unresolved" }
      : {
          status: "unresolved",
          rejectionReason: parsed.reason,
          ...(parsed.parsed ? { parsed: parsed.parsed } : {}),
        };
  }
  // Resolve the original destination token through the same relative-first,
  // vault-root-fallback resolver used by metadata/backlinks. The attachment
  // parser's canonical path is intentionally not fed back into the resolver:
  // doing so would resolve a relative target a second time and miss nested
  // wiki links such as `Assets/Ébauche/diagram.svg` from `Drawings/`.
  const destination = parseMarkdownDestinationTarget(rawTarget)?.path ?? rawTarget;
  const resolution = resolver.resolve(documentPath, destination);
  if (resolution.status === "resolved" && resolution.path && isAttachmentPath(resolution.path)) {
    return { status: "resolved", path: resolution.path, parsed };
  }
  if (resolution.status === "ambiguous") {
    return { status: "ambiguous", candidates: resolution.candidates ?? [], parsed };
  }
  return { status: "unresolved", parsed };
}

function mayReferenceSource(
  parsed: ParsedVaultAttachmentTarget | undefined,
  sourcePath: string,
  rejectionReason?: LinkResolution["rejectionReason"],
): boolean {
  if (!parsed) return false;
  let sameFullPath = false;
  try {
    sameFullPath =
      normalizedVaultPathIdentity(parsed.path) === normalizedVaultPathIdentity(sourcePath);
  } catch {
    // A rejected outside-vault/private token is not full-path-equal. Keep the
    // conservative basename evidence fallback below for source-like names.
  }
  return (
    sameFullPath ||
    ((parsed.bareName || rejectionReason === "private" || rejectionReason === "outside-vault") &&
      normalizedTextKey(path.posix.basename(parsed.path)) ===
        normalizedTextKey(path.posix.basename(sourcePath)))
  );
}

function sourceCandidatePaths(visibleFiles: readonly string[], sourcePath: string): string[] {
  return visibleFiles.filter(
    (candidate) =>
      normalizedTextKey(path.posix.basename(candidate)) ===
      normalizedTextKey(path.posix.basename(sourcePath)),
  );
}

function referenceLabelMayIdentifySource(label: string, sourcePath: string): boolean {
  const normalizedLabel = normalizedTextKey(label);
  const basename = path.posix.basename(sourcePath);
  const extension = path.posix.extname(basename);
  const stem = extension ? basename.slice(0, -extension.length) : basename;
  const exactKeys = new Set([sourcePath, basename, stem].map(normalizedTextKey));
  if (exactKeys.has(normalizedLabel)) return true;

  const sourceTokens = normalizedTextKey(stem)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3);
  if (sourceTokens.length === 0) return false;
  const labelTokens = new Set(normalizedLabel.split(/[^\p{L}\p{N}]+/u));
  return sourceTokens.every((token) => labelTokens.has(token));
}

function opaqueReferenceDestination(rawTarget: string): string | null {
  let cursor = 0;
  while (cursor < rawTarget.length && /\s/u.test(rawTarget[cursor] ?? "")) cursor += 1;
  if (rawTarget[cursor] === "<") cursor += 1;
  const start = cursor;
  let escaped = false;
  let parentheses = 0;
  for (; cursor < rawTarget.length; cursor += 1) {
    const character = rawTarget[cursor] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "(") {
      parentheses += 1;
      continue;
    }
    if (character === ")" && parentheses > 0) {
      parentheses -= 1;
      continue;
    }
    if (character === ">" || (/\s/u.test(character) && parentheses === 0)) break;
  }
  const destination = rawTarget.slice(start, cursor).trim();
  return destination || null;
}

type OpaqueDefinitionSourceEvidence = "source" | "external" | "unrelated" | "unknown";

function opaqueDefinitionSourceEvidence(
  documentPath: string,
  definition: ParsedMarkdownReferenceDefinitionCandidate,
  sourcePath: string,
): OpaqueDefinitionSourceEvidence {
  const destination = opaqueReferenceDestination(definition.rawTarget);
  if (!destination) return "unknown";
  const parsed = parseVaultAttachmentTarget(documentPath, destination);
  if (parsed.status === "local") {
    return mayReferenceSource(parsed, sourcePath) ? "source" : "unrelated";
  }
  if (parsed.reason === "external") return "external";
  if (parsed.parsed) {
    return mayReferenceSource(parsed.parsed, sourcePath, parsed.reason) ? "source" : "unrelated";
  }
  return "unknown";
}

type ReferenceDefinitionEvidence = "resolved" | "ambiguous" | "unresolved" | "opaque";

function referenceDefinitionEvidence(
  documentPath: string,
  definition: ParsedMarkdownReferenceDefinitionCandidate,
  sourcePath: string,
  resolver: VaultLinkResolver,
): ReferenceDefinitionEvidence | null {
  if (!definition.valid || !definition.target) {
    const opaqueEvidence = opaqueDefinitionSourceEvidence(documentPath, definition, sourcePath);
    if (opaqueEvidence === "source") return "opaque";
    if (opaqueEvidence === "external" || opaqueEvidence === "unrelated") return null;
    return referenceLabelMayIdentifySource(definition.label, sourcePath) ? "opaque" : null;
  }
  const resolution = resolveAttachmentLink(documentPath, definition.rawTarget, resolver);
  if (
    resolution.status === "resolved" &&
    resolution.path !== undefined &&
    normalizedVaultPathIdentity(resolution.path) === normalizedVaultPathIdentity(sourcePath)
  ) {
    return "resolved";
  }
  if (
    resolution.status === "ambiguous" &&
    resolution.candidates?.some(
      (candidate) =>
        normalizedVaultPathIdentity(candidate) === normalizedVaultPathIdentity(sourcePath),
    )
  ) {
    return "ambiguous";
  }
  if (
    resolution.status === "unresolved" &&
    mayReferenceSource(resolution.parsed, sourcePath, resolution.rejectionReason)
  ) {
    return "unresolved";
  }
  return null;
}

function referenceDefinitionCandidateId(
  documentPath: string,
  definition: ParsedMarkdownReferenceDefinitionCandidate,
): string {
  return `${documentPath}:${definition.line}:${definition.position}`;
}

interface ReferenceDefinitionSafety {
  blocker: AttachmentMoveBlocker | null;
  rewriteDefinition: ParsedMarkdownReferenceDefinitionCandidate | null;
}

function referenceUsageTarget(
  usage: ReturnType<typeof parseMarkdownReferenceUsages>[number],
): string {
  return `${usage.embed ? "!" : ""}[${usage.label}][]`;
}

function referenceDefinitionSafety(
  documentPath: string,
  usage: ReturnType<typeof parseMarkdownReferenceUsages>[number],
  definitions: readonly ParsedMarkdownReferenceDefinitionCandidate[],
  sourcePath: string,
  resolver: VaultLinkResolver,
  visibleFiles: readonly string[],
): ReferenceDefinitionSafety {
  const relevantDefinitions = definitions.filter((definition) => definition.label === usage.label);
  const evidence = relevantDefinitions.flatMap((definition) => {
    const result = referenceDefinitionEvidence(documentPath, definition, sourcePath, resolver);
    return result ? [{ definition, result }] : [];
  });
  if (usage.sourceMappable === false) {
    const definitionsAreDefinitelyUnrelated = relevantDefinitions.every((definition) => {
      if (definition.external) return true;
      if (!definition.valid || !definition.target) {
        const opaque = opaqueDefinitionSourceEvidence(documentPath, definition, sourcePath);
        return opaque === "external" || opaque === "unrelated";
      }
      const resolution = resolveAttachmentLink(documentPath, definition.rawTarget, resolver);
      if (resolution.status === "resolved") {
        return (
          resolution.path !== undefined &&
          normalizedVaultPathIdentity(resolution.path) !== normalizedVaultPathIdentity(sourcePath)
        );
      }
      if (resolution.status === "ambiguous") {
        return !resolution.candidates?.some(
          (candidate) =>
            normalizedVaultPathIdentity(candidate) === normalizedVaultPathIdentity(sourcePath),
        );
      }
      return false;
    });
    if (
      referenceLabelMayIdentifySource(usage.label, sourcePath) ||
      evidence.length > 0 ||
      !definitionsAreDefinitelyUnrelated
    ) {
      return {
        blocker: {
          documentPath,
          line: usage.line,
          target: referenceUsageTarget(usage),
          syntax: "markdown",
          reason: "unsupported",
          candidates:
            evidence.length > 0
              ? evidence.map(({ definition }) =>
                  referenceDefinitionCandidateId(documentPath, definition),
                )
              : sourceCandidatePaths(visibleFiles, sourcePath),
        },
        rewriteDefinition: null,
      };
    }
    return { blocker: null, rewriteDefinition: null };
  }
  if (relevantDefinitions.length === 0) {
    if (!referenceLabelMayIdentifySource(usage.label, sourcePath)) {
      return { blocker: null, rewriteDefinition: null };
    }
    return {
      blocker: {
        documentPath,
        line: usage.line,
        target: referenceUsageTarget(usage),
        syntax: "markdown",
        reason: "unsupported",
        candidates: sourceCandidatePaths(visibleFiles, sourcePath),
      },
      rewriteDefinition: null,
    };
  }
  if (evidence.length === 0) return { blocker: null, rewriteDefinition: null };
  const candidates = evidence.map(({ definition }) =>
    referenceDefinitionCandidateId(documentPath, definition),
  );
  // CommonMark deterministically selects the first definition. Threadleaf
  // deliberately applies its stricter source-evidence policy instead: once a
  // visible label has multiple definitions and any one may name this source,
  // preserve every definition byte-for-byte and require manual resolution.
  if (relevantDefinitions.length > 1) {
    return {
      blocker: {
        documentPath,
        line: usage.line,
        target: referenceUsageTarget(usage),
        syntax: "markdown",
        reason: "ambiguous",
        candidates,
      },
      rewriteDefinition: null,
    };
  }
  const sourceOnly = evidence.some(({ definition }) => definition.sourceOnly);
  const opaque = evidence.some(({ result }) => result === "opaque");
  if (sourceOnly || opaque) {
    return {
      blocker: {
        documentPath,
        line: usage.line,
        target: referenceUsageTarget(usage),
        syntax: "markdown",
        reason: "unsupported",
        candidates,
      },
      rewriteDefinition: null,
    };
  }
  if (evidence.some(({ result }) => result === "ambiguous")) {
    return {
      blocker: {
        documentPath,
        line: usage.line,
        target: referenceUsageTarget(usage),
        syntax: "markdown",
        reason: "ambiguous",
        candidates,
      },
      rewriteDefinition: null,
    };
  }
  if (evidence.some(({ result }) => result === "unresolved")) {
    return {
      blocker: {
        documentPath,
        line: usage.line,
        target: referenceUsageTarget(usage),
        syntax: "markdown",
        reason: "unresolved",
        candidates: sourceCandidatePaths(visibleFiles, sourcePath),
      },
      rewriteDefinition: null,
    };
  }
  // A single visible source definition is safe to rewrite once. Definitions
  // without source evidence above remain dormant and byte-for-byte untouched.
  const effective = relevantDefinitions.find(
    (definition) => !definition.sourceOnly && definition.valid,
  );
  if (!effective) return { blocker: null, rewriteDefinition: null };
  const effectiveEvidence = referenceDefinitionEvidence(
    documentPath,
    effective,
    sourcePath,
    resolver,
  );
  if (effectiveEvidence !== "resolved") {
    return { blocker: null, rewriteDefinition: null };
  }
  return { blocker: null, rewriteDefinition: effective };
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
    corpus: plan.corpus,
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function sortedMarkdownPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function changedCorpusPaths(
  expectedPaths: readonly string[],
  actualPaths: readonly string[],
  expectedRevisions: readonly { path: string; revision: string }[],
  actualRevisions: readonly { path: string; revision: string }[],
): string[] {
  const changed = new Set<string>();
  const expectedPathSet = new Set(expectedPaths);
  const actualPathSet = new Set(actualPaths);
  for (const path of expectedPathSet) if (!actualPathSet.has(path)) changed.add(path);
  for (const path of actualPathSet) if (!expectedPathSet.has(path)) changed.add(path);
  const expectedByPath = new Map(
    expectedRevisions.map((revision) => [revision.path, revision.revision]),
  );
  for (const revision of actualRevisions) {
    if (expectedByPath.get(revision.path) !== revision.revision) changed.add(revision.path);
  }
  return [...changed].sort((left, right) => left.localeCompare(right));
}

function corpusGeneration(
  paths: readonly string[],
  revisions: readonly { path: string; revision: string }[],
): string {
  const sortedPaths = [...paths].sort((left, right) => left.localeCompare(right));
  const sortedRevisions = [...revisions]
    .map((entry) => ({ path: entry.path, revision: entry.revision }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return createHash("sha256")
    .update(JSON.stringify({ paths: sortedPaths, revisions: sortedRevisions }), "utf8")
    .digest("hex");
}

async function captureKernelCorpus(vault: VaultReadPort): Promise<VaultMarkdownCorpus | null> {
  if (vault.readMarkdownCorpus) {
    try {
      return await vault.readMarkdownCorpus();
    } catch {
      return null;
    }
  }
  // Test doubles and older ports may not expose the kernel's atomic corpus
  // receipt. Enumerate, read, and enumerate again so a note created while the
  // first pass is in flight cannot be mistaken for a stable corpus.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const firstPaths = sortedMarkdownPaths(await vault.listMarkdownPaths());
    const firstRevisions = await readMarkdownRevisions(vault, firstPaths);
    if (!firstRevisions) continue;
    const secondPaths = sortedMarkdownPaths(await vault.listMarkdownPaths());
    const secondRevisions = await readMarkdownRevisions(vault, secondPaths);
    if (!secondRevisions) continue;
    if (changedCorpusPaths(firstPaths, secondPaths, firstRevisions, secondRevisions).length > 0) {
      continue;
    }
    return {
      paths: secondPaths,
      revisions: secondRevisions,
      generation: corpusGeneration(secondPaths, secondRevisions),
    };
  }
  return null;
}

async function readMarkdownRevisions(
  vault: VaultReadPort,
  paths: readonly string[],
): Promise<Array<{ path: string; revision: string }> | null> {
  const revisions: Array<{ path: string; revision: string }> = [];
  for (const documentPath of paths) {
    try {
      const snapshot = await vault.readText(documentPath);
      revisions.push({ path: documentPath, revision: snapshot.revision });
    } catch {
      return null;
    }
  }
  return revisions;
}

async function verifyAttachmentMoveCorpus(
  vault: VaultReadPort,
  corpus: AttachmentMoveMarkdownCorpus,
  expectedGeneration: number | undefined,
  currentGeneration: (() => number) | undefined,
): Promise<{ ok: true } | { ok: false; conflictPaths: string[] }> {
  if (
    expectedGeneration !== undefined &&
    currentGeneration !== undefined &&
    currentGeneration() !== expectedGeneration
  ) {
    return { ok: false, conflictPaths: [] };
  }
  const actual = await captureKernelCorpus(vault);
  if (!actual) return { ok: false, conflictPaths: corpus.kernel.paths };
  const conflictPaths = changedCorpusPaths(
    corpus.kernel.paths,
    actual.paths,
    corpus.kernel.revisions,
    actual.revisions,
  );
  if (
    expectedGeneration !== undefined &&
    currentGeneration !== undefined &&
    currentGeneration() !== expectedGeneration
  ) {
    return { ok: false, conflictPaths };
  }
  return conflictPaths.length === 0 ? { ok: true } : { ok: false, conflictPaths };
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
  context: AttachmentMovePlanningContext = {},
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
  const markdownPaths = sortedMarkdownPaths(await vault.listMarkdownPaths());
  const generation = context.generation ?? context.currentGeneration?.() ?? null;
  const visibleFiles = await collectVisibleFiles(vault);
  const sourceMatches = visibleFiles.filter(
    (candidate) =>
      normalizedVaultPathIdentity(candidate) === normalizedVaultPathIdentity(sourcePath),
  );
  if (sourceMatches.length === 0) {
    throw new Error(`Attachment is not present in the visible vault: ${sourcePath}`);
  }
  if (sourceMatches.length > 1) {
    throw new Error(
      `Attachment source is ambiguous after case and Unicode normalization: ${sourceMatches.join(", ")}`,
    );
  }
  // Keep the on-disk spelling for the kernel call while resolving user/link
  // paths case-insensitively and by NFC, as the metadata index does. An exact
  // lexical spelling is useful only after the normalized identity is unique.
  sourcePath = sourceMatches[0] as string;
  if (
    visibleFiles.some(
      (candidate) =>
        normalizedVaultPathIdentity(candidate) === normalizedVaultPathIdentity(targetPath),
    )
  ) {
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

  const rewrites: AttachmentLinkRewrite[] = [];
  const writes: AttachmentMoveWriteProposal[] = [];
  const markdownRevisions: Array<{ path: string; revision: string }> = [];
  const unresolvedBlockers: AttachmentMoveBlocker[] = [];
  const resolver = new VaultLinkResolver(visibleFiles);
  for (const documentPath of markdownPaths) {
    let snapshot: VaultTextSnapshot;
    try {
      snapshot = await vault.readText(documentPath);
    } catch {
      return {
        status: "conflict",
        from: sourcePath,
        to: targetPath,
        reason: "markdown-corpus-changed",
        conflictPaths: [documentPath],
      };
    }
    markdownRevisions.push({ path: documentPath, revision: snapshot.revision });
    const maskedContent = maskMarkdownCodeAndComments(snapshot.content);
    const referenceDefinitions = parseMarkdownReferenceDefinitionCandidates(
      snapshot.content,
      maskedContent,
    );
    const referenceUsages = parseMarkdownReferenceUsages(snapshot.content, maskedContent);
    const referenceDefinitionTargetRanges = new Set(
      referenceDefinitions.flatMap((definition) =>
        !definition.sourceOnly &&
        definition.valid &&
        definition.targetStart !== null &&
        definition.targetEnd !== null
          ? [`${definition.targetStart}:${definition.targetEnd}`]
          : [],
      ),
    );
    const safeReferenceDefinitionTargetRanges = new Set<string>();
    for (const usage of referenceUsages) {
      const safety = referenceDefinitionSafety(
        documentPath,
        usage,
        referenceDefinitions,
        sourcePath,
        resolver,
        visibleFiles,
      );
      if (safety.blocker) {
        unresolvedBlockers.push(safety.blocker);
      } else if (
        safety.rewriteDefinition &&
        safety.rewriteDefinition.targetStart !== null &&
        safety.rewriteDefinition.targetEnd !== null
      ) {
        safeReferenceDefinitionTargetRanges.add(
          `${safety.rewriteDefinition.targetStart}:${safety.rewriteDefinition.targetEnd}`,
        );
      }
    }
    const candidates: PlannedCandidate[] = [];
    for (const link of parseMarkdownLinks(snapshot.content, maskedContent)) {
      const rawTarget = snapshot.content.slice(link.targetStart, link.targetEnd);
      const resolution = resolveAttachmentLink(documentPath, rawTarget, resolver);
      const isReferencedDefinition =
        link.sourceKind === "markdown-reference-definition" &&
        referenceDefinitionTargetRanges.has(`${link.targetStart}:${link.targetEnd}`);
      const isSafeReferencedDefinition =
        isReferencedDefinition &&
        safeReferenceDefinitionTargetRanges.has(`${link.targetStart}:${link.targetEnd}`);
      if (isReferencedDefinition && !isSafeReferencedDefinition) continue;
      if (resolution.status !== "resolved" || resolution.path !== sourcePath) {
        // Exact target ranges prevent an inline link on the same line from
        // inheriting a reference definition's uncertainty.
        if (
          resolution.status === "ambiguous" &&
          resolution.candidates?.some(
            (candidate) =>
              normalizedVaultPathIdentity(candidate) === normalizedVaultPathIdentity(sourcePath),
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
        } else if (
          resolution.status === "unresolved" &&
          mayReferenceSource(resolution.parsed, sourcePath, resolution.rejectionReason)
        ) {
          unresolvedBlockers.push({
            documentPath,
            line: link.line,
            target: link.target,
            syntax: link.syntax,
            reason: "unresolved",
            candidates: visibleFiles.filter(
              (candidate) =>
                normalizedTextKey(path.posix.basename(candidate)) ===
                normalizedTextKey(path.posix.basename(sourcePath)),
            ),
          });
        }
        continue;
      }
      const afterTarget = replacementTarget(
        link.syntax,
        documentPath,
        targetPath,
        resolution.parsed?.suffix,
      );
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
  const finalKernelCorpus = await captureKernelCorpus(vault);
  const corpus = {
    markdownPaths,
    markdownRevisions,
    generation,
    kernel: finalKernelCorpus ?? {
      paths: markdownPaths,
      revisions: markdownRevisions,
      generation: corpusGeneration(markdownPaths, markdownRevisions),
    },
  } satisfies AttachmentMoveMarkdownCorpus;
  const corpusConflictPaths = changedCorpusPaths(
    markdownPaths,
    finalKernelCorpus?.paths ?? [],
    markdownRevisions,
    finalKernelCorpus?.revisions ?? [],
  );
  if (
    finalKernelCorpus === null ||
    corpusConflictPaths.length > 0 ||
    (context.currentGeneration && context.currentGeneration() !== generation)
  ) {
    return {
      status: "conflict",
      from: sourcePath,
      to: targetPath,
      reason: "markdown-corpus-changed",
      ...(corpusConflictPaths.length > 0 ? { conflictPaths: corpusConflictPaths } : {}),
    };
  }
  const ambiguousBlockers = rewrites
    .filter((rewrite) => rewrite.afterTarget === "")
    .map((rewrite) => ({
      documentPath: rewrite.documentPath,
      line: rewrite.line,
      target: rewrite.beforeTarget,
      syntax: rewrite.syntax,
      reason: "ambiguous" as const,
      candidates: visibleFiles.filter(
        (candidate) =>
          normalizedTextKey(path.posix.basename(candidate)) ===
          normalizedTextKey(path.posix.basename(sourcePath)),
      ),
    }));
  const blockers = [...unresolvedBlockers, ...ambiguousBlockers];
  const plannedWithoutId = {
    status: "planned" as const,
    from: sourcePath,
    to: targetPath,
    sourceRevision: sourceResult.snapshot.revision,
    rewrites: rewrites.filter((rewrite) => rewrite.afterTarget !== ""),
    blockers,
    writes,
    corpus,
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
  const planningContext: AttachmentMovePlanningContext = {
    ...(options.expectedGeneration !== undefined ? { generation: options.expectedGeneration } : {}),
    ...(options.currentGeneration ? { currentGeneration: options.currentGeneration } : {}),
  };
  const plan =
    options.plan ??
    (await planBinaryAttachmentMove(
      vault,
      requestedSourcePath,
      requestedTargetPath,
      expectedSourceRevision,
      planningContext,
    ));
  if (plan.status === "conflict") return plan;
  if (plan.blockers.length > 0)
    return { status: "blocked", from: plan.from, to: plan.to, blockers: plan.blockers };
  // A confirmation is a capability for the exact rewrite preview the user
  // saw. If a later plan has no rewrites, the old capability must not silently
  // turn into an attachment-only rename after an external edit.
  if (options.confirmationId && plan.writes.length === 0 && plan.confirmationId === null) {
    return {
      status: "conflict",
      from: plan.from,
      to: plan.to,
      reason: "rewrite-plan-changed",
    };
  }
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
  const corpusVerification = await verifyAttachmentMoveCorpus(
    vault,
    plan.corpus,
    options.expectedGeneration ?? plan.corpus.generation ?? undefined,
    options.currentGeneration,
  );
  if (!corpusVerification.ok) {
    return {
      status: "conflict",
      from: plan.from,
      to: plan.to,
      reason: "markdown-corpus-changed",
      ...(corpusVerification.conflictPaths.length > 0
        ? { conflictPaths: corpusVerification.conflictPaths }
        : {}),
    };
  }
  const result =
    plan.writes.length > 0
      ? await vault.moveWithWrites({
          sourcePath: plan.from,
          targetPath: plan.to,
          expectedSourceRevision: plan.sourceRevision,
          writes: plan.writes,
          expectedMarkdownCorpus: plan.corpus.kernel,
          strictContainment: true,
        })
      : await vault.renameFile(plan.from, plan.to, plan.sourceRevision, plan.corpus.kernel, {
          strictContainment: true,
        });
  if (result.status === "conflict") {
    return {
      status: "conflict",
      from: result.from,
      to: result.to,
      reason: result.reason,
      ...("conflictPaths" in result &&
      Array.isArray(result.conflictPaths) &&
      result.conflictPaths.length > 0
        ? { conflictPaths: result.conflictPaths }
        : {}),
    };
  }
  if (result.status !== "published-source-retained") {
    return {
      status: "conflict",
      from: result.from,
      to: result.to,
      reason: "source-retention-not-supported",
    };
  }
  const revisions: Array<{ path: string; revision: string }> =
    plan.writes.length > 0 && "writes" in result
      ? (result.writes as Array<{ path: string; revision: string }>)
      : [];
  return {
    status: "published-source-retained",
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
