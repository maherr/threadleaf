import path from "node:path";
import {
  type FullTextSearchDocument,
  FullTextSearchIndex,
  type FullTextSearchOptions,
  type FullTextSearchPage,
} from "./full-text-search";
import {
  maskMarkdownCodeAndComments,
  type ParsedMarkdownLink,
  parseMarkdownLinks,
} from "./markdown-links";
import { normalizeVaultDirectoryPath } from "./path-policy";
import type { VaultReadPort, VaultTextSnapshot } from "./ports";
import { type RescanReason, type VaultChangeBatch, WatchSequenceGate } from "./watch-protocol";

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

export interface MetadataIndexSnapshot {
  documents: DocumentMetadataSnapshot[];
  backlinks: Array<{ path: string; sources: string[] }>;
  duplicateNames: Array<{ name: string; paths: string[] }>;
}

interface ParsedDocument {
  path: string;
  revision: string;
  headings: HeadingMetadata[];
  tags: string[];
  tagCounts: Record<string, number>;
  properties: Record<string, string | string[]>;
  links: ParsedMarkdownLink[];
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
  const value = properties.tags ?? properties.tag;
  if (!value) {
    return [];
  }
  const values = Array.isArray(value) ? value : value.split(",");
  return values.map((tag) => tag.trim().replace(/^#/, "")).filter(Boolean);
}

function parseDocument(snapshot: VaultTextSnapshot): ParsedDocument {
  const searchable = stripFencedCode(snapshot.content);
  const masked = maskMarkdownCodeAndComments(snapshot.content);
  const properties = parseProperties(snapshot.content);
  const headings: HeadingMetadata[] = [];
  const tagCounts = new Map<string, number>();
  for (const tag of tagsFromProperties(properties)) {
    tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const lines = searchable.split("\n");
  const tagLines = masked.split("\n");
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
    const tagLine = tagLines[index] ?? "";
    for (const tag of tagLine.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]+)/gu)) {
      if (tag[1]) {
        tagCounts.set(tag[1], (tagCounts.get(tag[1]) ?? 0) + 1);
      }
    }
  }
  const sortedTagCounts = Object.fromEntries(
    [...tagCounts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tag, count]) => [flatten(tag), count]),
  );
  return {
    path: snapshot.path,
    revision: snapshot.revision,
    headings,
    tags: Object.keys(sortedTagCounts),
    tagCounts: sortedTagCounts,
    properties,
    links: parseMarkdownLinks(snapshot.content, masked).map((link) => ({
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class MetadataIndex {
  readonly #documents = new Map<string, ParsedDocument>();
  readonly #searchIndex = new FullTextSearchIndex();
  #generation = 0;
  #snapshotCache: { generation: number; snapshot: MetadataIndexSnapshot } | null = null;

  get generation(): number {
    return this.#generation;
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

  static async fromSnapshotsAsync(snapshots: readonly VaultTextSnapshot[]): Promise<MetadataIndex> {
    const index = new MetadataIndex();
    for (let cursor = 0; cursor < snapshots.length; cursor += 1) {
      const snapshot = snapshots[cursor];
      if (!snapshot) {
        continue;
      }
      const document = parseDocument(snapshot);
      index.#documents.set(snapshot.path, document);
      index.#searchIndex.upsert(toSearchDocument(document, snapshot.content));
      if ((cursor + 1) % snapshotBuildYieldInterval === 0) {
        await yieldToEventLoop();
      }
    }
    index.#generation += 1;
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
        this.#documents.delete(filePath);
        this.#searchIndex.remove(filePath);
      }
    }
    for (const [filePath, replacement] of replacements) {
      this.#documents.set(filePath, replacement.document);
      this.#searchIndex.upsert(replacement.searchDocument);
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
    this.#documents.set(filePath, document);
    this.#searchIndex.upsert(toSearchDocument(document, snapshot.content));
    this.#generation += 1;
    this.#snapshotCache = null;
  }

  remove(filePath: string): void {
    if (this.#documents.delete(filePath)) {
      this.#searchIndex.remove(filePath);
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
      backlinks: backlinkSnapshot,
      duplicateNames,
    };
    this.#snapshotCache = { generation: this.#generation, snapshot };
    return snapshot;
  }

  private replaceDocuments(
    documents: Map<string, ParsedDocument>,
    searchDocuments: FullTextSearchDocument[],
  ): void {
    this.#documents.clear();
    for (const [filePath, document] of documents) {
      this.#documents.set(filePath, document);
    }
    this.#searchIndex.replace(searchDocuments);
    this.#generation += 1;
    this.#snapshotCache = null;
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
  ): Promise<VaultIndexReactor> {
    return new VaultIndexReactor(source, await MetadataIndex.fromSnapshotsAsync(snapshots));
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
