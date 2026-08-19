import path from "node:path";
import {
  type CachedFullTextSearchDocument,
  type FullTextSearchContentStore,
  type FullTextSearchDocument,
  FullTextSearchIndex,
  type FullTextSearchOptions,
  type FullTextSearchPage,
} from "./full-text-search";
import {
  maskMarkdownCodeAndComments,
  type ParsedMarkdownLink,
  parseMarkdownLinks,
  parseMarkdownReferenceUsages,
} from "./markdown-links";
import { normalizeTagBody, parseInlineMarkdownTags, tagHierarchy, tagKey } from "./markdown-tags";
import { normalizeVaultDirectoryPath } from "./path-policy";
import type { VaultReadPort, VaultTextSnapshot } from "./ports";
import {
  type RescanReason,
  type VaultChange,
  type VaultChangeBatch,
  WatchSequenceGate,
} from "./watch-protocol";

export interface HeadingMetadata {
  level: number;
  text: string;
  line: number;
}

export interface LinkResolution {
  status: "resolved" | "unresolved" | "ambiguous";
  path?: string;
  candidates?: string[];
}

export interface LinkMetadata {
  target: string;
  subpath: string | null;
  alias: string | null;
  embed: boolean;
  syntax: "wiki" | "markdown";
  resolution: LinkResolution;
}

export interface DocumentMetadataSnapshot {
  path: string;
  revision: string;
  headings: HeadingMetadata[];
  tags: string[];
  tagCounts: Record<string, number>;
  properties: Record<string, string | string[]>;
  links: LinkMetadata[];
}

export interface TagIndexEntry {
  /** Case-insensitive NFC identity without a leading hash. */
  key: string;
  /** Source-preserved display spelling without a leading hash. */
  tag: string;
  /** Immediate valid parent identity, or null for a root row. */
  parentKey: string | null;
  /** Exact occurrences of this tag spelling across the vault. */
  directCount: number;
  /** Exact plus descendant occurrences represented by this hierarchy row. */
  count: number;
}

export interface MetadataIndexSnapshot {
  documents: DocumentMetadataSnapshot[];
  tags: TagIndexEntry[];
  backlinks: Array<{ path: string; sources: string[] }>;
  duplicateNames: Array<{ name: string; paths: string[] }>;
}

export interface ParsedDocument {
  path: string;
  revision: string;
  headings: HeadingMetadata[];
  tags: string[];
  tagCounts: Record<string, number>;
  tagOccurrences: string[];
  properties: Record<string, string | string[]>;
  links: ParsedMarkdownLink[];
}

export interface CachedMetadataIndexDocument {
  document: ParsedDocument;
  searchDocument: CachedFullTextSearchDocument;
}

export interface IndexUpdateResult {
  mode: "incremental" | "rebuild";
  reason?: RescanReason | "read-race";
}

/**
 * Detach a short retained string from the note it was cut out of.
 *
 * Every string this module keeps -- a heading, a tag, a property value, a link
 * target -- arrives as a substring of the note body or of one of the
 * `stripFencedCode` / `maskMarkdownCodeAndComments` copies of it. V8 represents
 * such a substring as a SlicedString: a 32-byte header pointing at its parent,
 * which stays alive for as long as the slice does. One two-word heading
 * therefore pinned a 40 KiB note plus two full-note masking copies, and a live
 * metadata index retained 83.3 KiB per note against 7.4 KiB for the same
 * metadata forced through a flattening round trip.
 *
 * Copying the characters through a UTF-8 buffer produces a fresh sequential
 * string with no parent pointer, so the note body is released as soon as the
 * indexer drops it. The equality check is not defensive dressing: it is a
 * per-call proof that the round trip was lossless, and it makes the one input
 * class that cannot survive UTF-8 -- a string carrying an unpaired surrogate --
 * fall back to the original rather than silently becoming U+FFFD.
 */
function flatten(value: string): string {
  if (value.length === 0) {
    return value;
  }
  const copy = Buffer.from(value, "utf8").toString("utf8");
  return copy === value ? copy : value;
}

function flattenValue(value: string | string[]): string | string[] {
  return Array.isArray(value) ? value.map(flatten) : flatten(value);
}

function normalizeKey(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function withoutMarkdownExtension(value: string): string {
  return value.toLowerCase().endsWith(".md") ? value.slice(0, -3) : value;
}

function stripFencedCode(content: string): string {
  let fence: "```" | "~~~" | null = null;
  return content
    .split("\n")
    .map((line) => {
      const marker = /^\s*(```|~~~)/.exec(line)?.[1] as "```" | "~~~" | undefined;
      if (marker && (!fence || marker === fence)) {
        fence = fence ? null : marker;
        return "";
      }
      return fence ? "" : line;
    })
    .join("\n");
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parsePropertyValue(value: string): string | string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map(scalar).filter(Boolean);
  }
  return scalar(trimmed);
}

function parseProperties(content: string): Record<string, string | string[]> {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return {};
  }
  const properties: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.trim() === "---") {
      break;
    }
    const listItem = /^\s+-\s+(.+)$/.exec(line ?? "");
    if (listItem?.[1] && listKey) {
      const existing = properties[listKey];
      properties[listKey] = [
        ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
        scalar(listItem[1]),
      ];
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line ?? "");
    if (match?.[1] && match[2] !== undefined) {
      properties[match[1]] = parsePropertyValue(match[2]);
      listKey = match[2].trim() === "" ? match[1] : undefined;
    } else if (line?.trim()) {
      listKey = undefined;
    }
  }
  return Object.fromEntries(
    Object.entries(properties)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [flatten(key), flattenValue(value)]),
  );
}

function tagsFromProperties(properties: Record<string, string | string[]>): string[] {
  let plural: string | string[] | undefined;
  let singular: string | string[] | undefined;
  for (const [key, candidate] of Object.entries(properties)) {
    const folded = key.toLocaleLowerCase("en-US");
    if (folded === "tags") {
      plural ??= candidate;
    } else if (folded === "tag") {
      singular ??= candidate;
    }
  }
  const value = plural ?? singular;
  if (!value) {
    return [];
  }
  const values = Array.isArray(value) ? value : value.split(",");
  return values.map(normalizeTagBody).filter((tag): tag is string => tag !== null);
}

function parseDocument(snapshot: VaultTextSnapshot): ParsedDocument {
  const searchable = stripFencedCode(snapshot.content);
  const masked = maskMarkdownCodeAndComments(snapshot.content);
  const properties = parseProperties(snapshot.content);
  const headings: HeadingMetadata[] = [];
  const links = parseMarkdownLinks(snapshot.content, masked);
  const referenceUsages = parseMarkdownReferenceUsages(snapshot.content, masked);
  const tagOccurrences = [
    ...tagsFromProperties(properties),
    ...parseInlineMarkdownTags(snapshot.content, masked, { links, referenceUsages }).map(
      ({ tag }) => tag,
    ),
  ];
  const tagCounts = new Map<string, { tag: string; count: number }>();
  for (const tag of tagOccurrences) {
    const key = tagKey(tag);
    const existing = tagCounts.get(key);
    if (existing) existing.count += 1;
    else tagCounts.set(key, { tag, count: 1 });
  }
  const lines = searchable.split("\n");
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    const closingIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
    if (closingIndex >= 0) {
      bodyStart = closingIndex + 2;
    }
  }
  for (let index = bodyStart; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1] && heading[2]) {
      headings.push({ level: heading[1].length, text: flatten(heading[2]), line: index + 1 });
    }
  }
  const sortedTagCounts = Object.fromEntries(
    [...tagCounts.values()]
      .sort((left, right) => left.tag.localeCompare(right.tag))
      .map(({ tag, count }) => [flatten(tag), count]),
  );
  return {
    path: snapshot.path,
    revision: snapshot.revision,
    headings,
    tags: Object.keys(sortedTagCounts),
    tagCounts: sortedTagCounts,
    tagOccurrences: tagOccurrences.map(flatten),
    properties,
    links: links.map((link) => ({
      ...link,
      target: flatten(link.target),
      subpath: link.subpath === null ? null : flatten(link.subpath),
      alias: link.alias === null ? null : flatten(link.alias),
    })),
  };
}

function toSearchDocument(document: ParsedDocument, content: string): FullTextSearchDocument {
  return {
    path: document.path,
    content,
    headings: document.headings,
    tags: document.tags,
    properties: document.properties,
  };
}

function safeCandidate(value: string): string | null {
  const normalized = path.posix.normalize(value).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return null;
  }
  return withoutMarkdownExtension(normalized);
}

export class VaultLinkResolver {
  readonly #byPath = new Map<string, string[]>();
  readonly #byName = new Map<string, string[]>();

  constructor(paths: Iterable<string>) {
    for (const filePath of paths) {
      const withoutExtension = withoutMarkdownExtension(filePath);
      const pathKey = normalizeKey(withoutExtension);
      const nameKey = normalizeKey(path.posix.basename(withoutExtension));
      this.#byPath.set(pathKey, [...(this.#byPath.get(pathKey) ?? []), filePath]);
      this.#byName.set(nameKey, [...(this.#byName.get(nameKey) ?? []), filePath]);
    }
  }

  resolve(sourcePath: string, rawTarget: string): LinkResolution {
    if (rawTarget === "") {
      return { status: "resolved", path: sourcePath };
    }
    const rootedOnly = rawTarget.startsWith("/");
    const target = withoutMarkdownExtension(rawTarget.replace(/^\//, ""));
    const candidates: string[] = [];
    const relative = safeCandidate(path.posix.join(path.posix.dirname(sourcePath), target));
    const rooted = safeCandidate(target);
    for (const candidate of rootedOnly ? [rooted] : [relative, rooted]) {
      if (!candidate) {
        continue;
      }
      for (const match of this.#byPath.get(normalizeKey(candidate)) ?? []) {
        if (!candidates.includes(match)) {
          candidates.push(match);
        }
      }
      if (candidates.length > 0) {
        break;
      }
    }
    if (candidates.length === 0 && !target.includes("/")) {
      candidates.push(...(this.#byName.get(normalizeKey(path.posix.basename(target))) ?? []));
    }
    candidates.sort();
    const resolved = candidates.length === 1 ? candidates[0] : undefined;
    if (resolved) {
      return { status: "resolved", path: resolved };
    }
    if (candidates.length > 1) {
      return { status: "ambiguous", candidates };
    }
    return { status: "unresolved" };
  }

  duplicateNames(): Array<{ name: string; paths: string[] }> {
    return [...this.#byName.entries()]
      .filter(([, paths]) => paths.length > 1)
      .map(([name, paths]) => ({ name, paths: [...paths].sort() }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}

const snapshotBuildYieldInterval = 32;
const snapshotBuildProgressInterval = 512;

export interface MetadataIndexBuildOptions {
  signal?: AbortSignal;
  onProgress?: (indexed: number, total: number) => void;
  contentStore?: FullTextSearchContentStore;
}

function throwIfIndexBuildAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("Metadata index build was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface TagCatalogAggregate {
  count: number;
  directCount: number;
  parentKey: string | null;
  representatives: Map<string, string>;
}

interface TagCatalogContribution {
  key: string;
  tag: string;
  parentKey: string | null;
  direct: boolean;
  representativeId: string;
}

function tagCatalogContributions(document: ParsedDocument): TagCatalogContribution[] {
  const contributions: TagCatalogContribution[] = [];
  for (const [occurrence, tag] of document.tagOccurrences.entries()) {
    const hierarchy = tagHierarchy(tag);
    for (const [index, display] of hierarchy.entries()) {
      contributions.push({
        key: tagKey(display),
        tag: display,
        parentKey: index > 0 ? tagKey(hierarchy[index - 1] ?? "") : null,
        direct: index === hierarchy.length - 1,
        representativeId: `${document.path}\u0000${String(occurrence).padStart(10, "0")}`,
      });
    }
  }
  return contributions;
}

export class MetadataIndex {
  readonly #documents = new Map<string, ParsedDocument>();
  readonly #searchIndex = new FullTextSearchIndex();
  readonly #tagCatalog = new Map<string, TagCatalogAggregate>();
  readonly #tagContributions = new Map<string, TagCatalogContribution[]>();
  #generation = 0;
  #snapshotCache: { generation: number; snapshot: MetadataIndexSnapshot } | null = null;

  get generation(): number {
    return this.#generation;
  }

  get documentCount(): number {
    return this.#documents.size;
  }

  static async build(source: VaultReadPort): Promise<MetadataIndex> {
    const index = new MetadataIndex();
    await index.rebuild(source);
    return index;
  }

  static fromSnapshots(snapshots: readonly VaultTextSnapshot[]): MetadataIndex {
    const index = new MetadataIndex();
    const documents = new Map<string, ParsedDocument>();
    const searchDocuments: FullTextSearchDocument[] = [];
    for (const snapshot of snapshots) {
      const document = parseDocument(snapshot);
      documents.set(snapshot.path, document);
      searchDocuments.push(toSearchDocument(document, snapshot.content));
    }
    index.replaceDocuments(documents, searchDocuments);
    return index;
  }

  static async fromSnapshotsAsync(
    snapshots: readonly VaultTextSnapshot[],
    options: MetadataIndexBuildOptions = {},
  ): Promise<MetadataIndex> {
    const index = new MetadataIndex();
    options.onProgress?.(0, snapshots.length);
    for (let cursor = 0; cursor < snapshots.length; cursor += 1) {
      throwIfIndexBuildAborted(options.signal);
      const snapshot = snapshots[cursor];
      if (!snapshot) {
        continue;
      }
      const document = parseDocument(snapshot);
      index.upsertDocument(document, toSearchDocument(document, snapshot.content));
      if ((cursor + 1) % snapshotBuildProgressInterval === 0 || cursor + 1 === snapshots.length) {
        options.onProgress?.(cursor + 1, snapshots.length);
      }
      if ((cursor + 1) % snapshotBuildYieldInterval === 0) {
        await yieldToEventLoop();
      }
    }
    index.#generation += 1;
    return index;
  }

  static async fromCachedDocumentsAsync(
    documents: AsyncIterable<CachedMetadataIndexDocument>,
    total: number,
    cachedSnapshot: MetadataIndexSnapshot | null | PromiseLike<MetadataIndexSnapshot | null> = null,
    options: MetadataIndexBuildOptions = {},
  ): Promise<MetadataIndex> {
    const index = new MetadataIndex();
    let loaded = 0;
    options.onProgress?.(0, total);
    for await (const cached of documents) {
      throwIfIndexBuildAborted(options.signal);
      if (
        cached.document.path !== cached.searchDocument.path ||
        cached.document.revision.length !== 64
      ) {
        throw new Error("The derived index cache contains an invalid document.");
      }
      index.upsertCachedDocument(cached);
      loaded += 1;
      if (loaded % snapshotBuildProgressInterval === 0 || loaded === total) {
        options.onProgress?.(loaded, total);
      }
      if (loaded % snapshotBuildYieldInterval === 0) {
        await yieldToEventLoop();
      }
    }
    if (loaded !== total) {
      throw new Error(`The derived index cache contains ${loaded} documents, expected ${total}.`);
    }
    index.#generation += 1;
    index.#searchIndex.setContentStore(options.contentStore ?? null);
    const resolvedCachedSnapshot = await cachedSnapshot;
    if (resolvedCachedSnapshot) {
      if (
        resolvedCachedSnapshot.documents.length !== total ||
        resolvedCachedSnapshot.documents.some(
          (document) => index.#documents.get(document.path)?.revision !== document.revision,
        )
      ) {
        throw new Error("The derived index cache projection does not match its documents.");
      }
      index.#snapshotCache = { generation: index.#generation, snapshot: resolvedCachedSnapshot };
    }
    return index;
  }

  async rebuild(source: VaultReadPort): Promise<void> {
    const documents = new Map<string, ParsedDocument>();
    const searchDocuments: FullTextSearchDocument[] = [];
    const paths = await source.listMarkdownPaths();
    for (const filePath of paths) {
      const snapshot = await source.readText(filePath);
      const document = parseDocument(snapshot);
      documents.set(filePath, document);
      searchDocuments.push(toSearchDocument(document, snapshot.content));
    }
    this.replaceDocuments(documents, searchDocuments);
  }

  async rebuildSubtree(source: VaultReadPort, relativeDirectory: string): Promise<void> {
    const normalizedDirectory = normalizeVaultDirectoryPath(relativeDirectory);
    const prefix = normalizedDirectory ? `${normalizedDirectory}/` : "";
    const replacements = new Map<
      string,
      { document: ParsedDocument; searchDocument: FullTextSearchDocument }
    >();
    const paths = await source.listMarkdownPaths(normalizedDirectory);
    for (const filePath of paths) {
      const snapshot = await source.readText(filePath);
      const document = parseDocument(snapshot);
      replacements.set(filePath, {
        document,
        searchDocument: toSearchDocument(document, snapshot.content),
      });
    }
    for (const filePath of [...this.#documents.keys()]) {
      if (!prefix || filePath.startsWith(prefix)) {
        this.deleteDocument(filePath);
      }
    }
    for (const replacement of replacements.values()) {
      this.upsertDocument(replacement.document, replacement.searchDocument);
    }
    this.#generation += 1;
    this.#snapshotCache = null;
  }

  async refresh(source: VaultReadPort, filePath: string): Promise<void> {
    if (!filePath.toLowerCase().endsWith(".md")) {
      this.remove(filePath);
      return;
    }
    const snapshot = await source.readText(filePath);
    const document = parseDocument(snapshot);
    this.upsertDocument(document, toSearchDocument(document, snapshot.content));
    this.#generation += 1;
    this.#snapshotCache = null;
  }

  remove(filePath: string): void {
    if (this.#documents.has(filePath)) {
      this.deleteDocument(filePath);
      this.#generation += 1;
      this.#snapshotCache = null;
    }
  }

  search(
    query: string,
    limit = 50,
    options: FullTextSearchOptions = {},
  ): FullTextSearchPage & { generation: number } {
    return { ...this.#searchIndex.search(query, limit, options), generation: this.#generation };
  }

  snapshot(): MetadataIndexSnapshot {
    if (this.#snapshotCache?.generation === this.#generation) {
      return this.#snapshotCache.snapshot;
    }
    const documents = [...this.#documents.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    const resolver = new VaultLinkResolver(documents.map((document) => document.path));

    const backlinks = new Map<string, Set<string>>();
    const documentSnapshots: DocumentMetadataSnapshot[] = documents.map((document) => ({
      path: document.path,
      revision: document.revision,
      headings: document.headings,
      tags: document.tags,
      tagCounts: document.tagCounts,
      properties: document.properties,
      links: document.links.map((link) => {
        const resolution = resolver.resolve(document.path, link.target);
        if (resolution.status === "resolved" && resolution.path) {
          const sources = backlinks.get(resolution.path) ?? new Set<string>();
          sources.add(document.path);
          backlinks.set(resolution.path, sources);
        }
        return {
          target: link.target,
          subpath: link.subpath,
          alias: link.alias,
          embed: link.embed,
          syntax: link.syntax,
          resolution,
        };
      }),
    }));

    const duplicateNames = resolver.duplicateNames();
    const backlinkSnapshot = documents.map((document) => ({
      path: document.path,
      sources: [...(backlinks.get(document.path) ?? [])].sort(),
    }));
    const snapshot = {
      documents: documentSnapshots,
      tags: this.tagCatalogSnapshot(),
      backlinks: backlinkSnapshot,
      duplicateNames,
    };
    this.#snapshotCache = { generation: this.#generation, snapshot };
    return snapshot;
  }

  *cachedDocuments(): IterableIterator<CachedMetadataIndexDocument> {
    for (const document of this.#documents.values()) {
      const searchDocument = this.#searchIndex.cachedDocument(document.path);
      if (!searchDocument) {
        throw new Error(`Search state is missing for cached document: ${document.path}`);
      }
      yield { document, searchDocument };
    }
  }

  cachedDocument(filePath: string): CachedMetadataIndexDocument | undefined {
    const document = this.#documents.get(filePath);
    const searchDocument = this.#searchIndex.cachedDocument(filePath);
    return document && searchDocument ? { document, searchDocument } : undefined;
  }

  private replaceDocuments(
    documents: Map<string, ParsedDocument>,
    searchDocuments: FullTextSearchDocument[],
  ): void {
    this.#documents.clear();
    this.#tagCatalog.clear();
    this.#tagContributions.clear();
    for (const [filePath, document] of documents) {
      this.#documents.set(filePath, document);
      this.addTagContributions(document);
    }
    this.#searchIndex.replace(searchDocuments);
    this.#generation += 1;
    this.#snapshotCache = null;
  }

  private upsertDocument(document: ParsedDocument, searchDocument: FullTextSearchDocument): void {
    if (this.#documents.has(document.path)) this.removeTagContributions(document.path);
    this.#documents.set(document.path, document);
    this.#searchIndex.upsert(searchDocument);
    this.addTagContributions(document);
  }

  private upsertCachedDocument(cached: CachedMetadataIndexDocument): void {
    if (this.#documents.has(cached.document.path)) {
      throw new Error(`The derived index cache repeats a document: ${cached.document.path}`);
    }
    this.#documents.set(cached.document.path, cached.document);
    this.#searchIndex.upsertCached(cached.searchDocument);
    this.addTagContributions(cached.document);
  }

  private deleteDocument(filePath: string): void {
    this.removeTagContributions(filePath);
    this.#documents.delete(filePath);
    this.#searchIndex.remove(filePath);
  }

  private addTagContributions(document: ParsedDocument): void {
    const contributions = tagCatalogContributions(document);
    this.#tagContributions.set(document.path, contributions);
    for (const contribution of contributions) {
      const aggregate = this.#tagCatalog.get(contribution.key) ?? {
        count: 0,
        directCount: 0,
        parentKey: contribution.parentKey,
        representatives: new Map<string, string>(),
      };
      aggregate.count += 1;
      if (contribution.direct) aggregate.directCount += 1;
      aggregate.representatives.set(contribution.representativeId, contribution.tag);
      this.#tagCatalog.set(contribution.key, aggregate);
    }
  }

  private removeTagContributions(filePath: string): void {
    for (const contribution of this.#tagContributions.get(filePath) ?? []) {
      const aggregate = this.#tagCatalog.get(contribution.key);
      if (!aggregate) continue;
      aggregate.count -= 1;
      if (contribution.direct) aggregate.directCount -= 1;
      aggregate.representatives.delete(contribution.representativeId);
      if (aggregate.count === 0) this.#tagCatalog.delete(contribution.key);
    }
    this.#tagContributions.delete(filePath);
  }

  private tagCatalogSnapshot(): TagIndexEntry[] {
    return [...this.#tagCatalog.entries()]
      .map(([key, aggregate]) => {
        const representative = [...aggregate.representatives.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        )[0]?.[1];
        if (!representative) {
          throw new Error(`Tag catalog row ${key} has no representative.`);
        }
        return {
          key,
          tag: flatten(representative),
          parentKey: aggregate.parentKey,
          directCount: aggregate.directCount,
          count: aggregate.count,
        };
      })
      .sort((left, right) => left.key.localeCompare(right.key));
  }
}

export class VaultIndexReactor {
  readonly index: MetadataIndex;
  readonly #source: VaultReadPort;
  readonly #gate = new WatchSequenceGate();

  private constructor(source: VaultReadPort, index: MetadataIndex) {
    this.#source = source;
    this.index = index;
  }

  static async open(source: VaultReadPort): Promise<VaultIndexReactor> {
    return new VaultIndexReactor(source, await MetadataIndex.build(source));
  }

  static fromSnapshots(
    source: VaultReadPort,
    snapshots: readonly VaultTextSnapshot[],
  ): VaultIndexReactor {
    return new VaultIndexReactor(source, MetadataIndex.fromSnapshots(snapshots));
  }

  static async fromSnapshotsAsync(
    source: VaultReadPort,
    snapshots: readonly VaultTextSnapshot[],
    options: MetadataIndexBuildOptions = {},
  ): Promise<VaultIndexReactor> {
    return new VaultIndexReactor(
      source,
      await MetadataIndex.fromSnapshotsAsync(snapshots, options),
    );
  }

  static async fromCachedDocumentsAsync(
    source: VaultReadPort,
    documents: AsyncIterable<CachedMetadataIndexDocument>,
    total: number,
    cachedSnapshot: MetadataIndexSnapshot | null | PromiseLike<MetadataIndexSnapshot | null> = null,
    options: MetadataIndexBuildOptions = {},
  ): Promise<VaultIndexReactor> {
    return new VaultIndexReactor(
      source,
      await MetadataIndex.fromCachedDocumentsAsync(documents, total, cachedSnapshot, options),
    );
  }

  async reconcileCachedChanges(changes: readonly VaultChange[]): Promise<void> {
    for (const change of changes) {
      if (change.kind === "delete") {
        this.index.remove(change.path);
      } else if (change.kind === "move") {
        this.index.remove(change.from);
        await this.index.refresh(this.#source, change.to);
      } else {
        await this.index.refresh(this.#source, change.state.path);
      }
    }
  }

  async accept(batch: VaultChangeBatch): Promise<IndexUpdateResult> {
    const decision = this.#gate.accept(batch);
    if (!decision.accepted || decision.rescan) {
      if (decision.rescan?.scope === "subtree" && decision.rescan.path !== undefined) {
        await this.index.rebuildSubtree(this.#source, decision.rescan.path);
      } else {
        await this.index.rebuild(this.#source);
      }
      return {
        mode: "rebuild",
        ...(decision.rescan ? { reason: decision.rescan.reason } : {}),
      };
    }

    try {
      for (const change of batch.changes) {
        if (change.kind === "delete") {
          this.index.remove(change.path);
        } else if (change.kind === "move") {
          this.index.remove(change.from);
          await this.index.refresh(this.#source, change.to);
        } else {
          await this.index.refresh(this.#source, change.state.path);
        }
      }
      return { mode: "incremental" };
    } catch {
      await this.index.rebuild(this.#source);
      return { mode: "rebuild", reason: "read-race" };
    }
  }
}
