import path from "node:path";
import {
  type FullTextSearchDocument,
  FullTextSearchIndex,
  type FullTextSearchPage,
} from "./full-text-search";
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
  properties: Record<string, string | string[]>;
  links: LinkMetadata[];
}

export interface MetadataIndexSnapshot {
  documents: DocumentMetadataSnapshot[];
  backlinks: Array<{ path: string; sources: string[] }>;
  duplicateNames: Array<{ name: string; paths: string[] }>;
}

interface ParsedLink {
  target: string;
  subpath: string | null;
  alias: string | null;
  embed: boolean;
  syntax: "wiki" | "markdown";
  position: number;
}

interface ParsedDocument {
  path: string;
  revision: string;
  headings: HeadingMetadata[];
  tags: string[];
  properties: Record<string, string | string[]>;
  links: ParsedLink[];
}

export interface IndexUpdateResult {
  mode: "incremental" | "rebuild";
  reason?: RescanReason | "read-race";
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
    Object.entries(properties).sort(([left], [right]) => left.localeCompare(right)),
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

function splitTarget(value: string): { target: string; subpath: string | null } {
  const headingIndex = value.indexOf("#");
  const blockIndex = value.indexOf("^");
  const indexes = [headingIndex, blockIndex].filter((index) => index >= 0);
  const splitAt = indexes.length > 0 ? Math.min(...indexes) : -1;
  if (splitAt === -1) {
    return { target: value.trim(), subpath: null };
  }
  return {
    target: value.slice(0, splitAt).trim(),
    subpath: value.slice(splitAt).trim() || null,
  };
}

function normalizeLinkTarget(value: string): string {
  const unwrapped = value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
  try {
    return decodeURIComponent(unwrapped).replaceAll("\\", "/");
  } catch {
    return unwrapped.replaceAll("\\", "/");
  }
}

function isExternalLink(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//");
}

function parseLinks(content: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  const wikiPattern = /(!)?\[\[([^\]\n]+)\]\]/g;
  for (const match of content.matchAll(wikiPattern)) {
    const inner = match[2] ?? "";
    const aliasAt = inner.indexOf("|");
    const rawTarget = aliasAt === -1 ? inner : inner.slice(0, aliasAt);
    const { target, subpath } = splitTarget(normalizeLinkTarget(rawTarget));
    links.push({
      target,
      subpath,
      alias: aliasAt === -1 ? null : inner.slice(aliasAt + 1).trim() || null,
      embed: match[1] === "!",
      syntax: "wiki",
      position: match.index,
    });
  }

  const markdownPattern = /(!)?\[[^\]\n]*\]\(([^)\n]+)\)/g;
  for (const match of content.matchAll(markdownPattern)) {
    const destination = (match[2] ?? "").trim().split(/\s+["']/)[0] ?? "";
    const normalized = normalizeLinkTarget(destination);
    if (!normalized || isExternalLink(normalized)) {
      continue;
    }
    const { target, subpath } = splitTarget(normalized);
    links.push({
      target,
      subpath,
      alias: null,
      embed: match[1] === "!",
      syntax: "markdown",
      position: match.index,
    });
  }
  return links.sort((left, right) => left.position - right.position);
}

function parseDocument(snapshot: VaultTextSnapshot): ParsedDocument {
  const searchable = stripFencedCode(snapshot.content);
  const properties = parseProperties(snapshot.content);
  const headings: HeadingMetadata[] = [];
  const inlineTags = new Set<string>();
  const lines = searchable.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1] && heading[2]) {
      headings.push({ level: heading[1].length, text: heading[2], line: index + 1 });
    }
    for (const tag of line.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]+)/gu)) {
      if (tag[1]) {
        inlineTags.add(tag[1]);
      }
    }
  }
  const tags = new Set([...tagsFromProperties(properties), ...inlineTags]);
  return {
    path: snapshot.path,
    revision: snapshot.revision,
    headings,
    tags: [...tags].sort((left, right) => left.localeCompare(right)),
    properties,
    links: parseLinks(searchable),
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

export class MetadataIndex {
  readonly #documents = new Map<string, ParsedDocument>();
  readonly #searchIndex = new FullTextSearchIndex();
  #generation = 0;

  get generation(): number {
    return this.#generation;
  }

  static async build(source: VaultReadPort): Promise<MetadataIndex> {
    const index = new MetadataIndex();
    await index.rebuild(source);
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
  }

  remove(filePath: string): void {
    if (this.#documents.delete(filePath)) {
      this.#searchIndex.remove(filePath);
      this.#generation += 1;
    }
  }

  search(query: string, limit = 50): FullTextSearchPage & { generation: number } {
    return { ...this.#searchIndex.search(query, limit), generation: this.#generation };
  }

  snapshot(): MetadataIndexSnapshot {
    const documents = [...this.#documents.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    const byPath = new Map<string, string[]>();
    const byName = new Map<string, string[]>();
    for (const document of documents) {
      const withoutExtension = withoutMarkdownExtension(document.path);
      const pathKey = normalizeKey(withoutExtension);
      const nameKey = normalizeKey(path.posix.basename(withoutExtension));
      byPath.set(pathKey, [...(byPath.get(pathKey) ?? []), document.path]);
      byName.set(nameKey, [...(byName.get(nameKey) ?? []), document.path]);
    }

    const backlinks = new Map<string, Set<string>>();
    const documentSnapshots: DocumentMetadataSnapshot[] = documents.map((document) => ({
      path: document.path,
      revision: document.revision,
      headings: document.headings,
      tags: document.tags,
      properties: document.properties,
      links: document.links.map((link) => {
        const resolution = this.resolveLink(document.path, link.target, byPath, byName);
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

    const duplicateNames = [...byName.entries()]
      .filter(([, paths]) => paths.length > 1)
      .map(([name, paths]) => ({ name, paths: [...paths].sort() }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const backlinkSnapshot = documents.map((document) => ({
      path: document.path,
      sources: [...(backlinks.get(document.path) ?? [])].sort(),
    }));
    return { documents: documentSnapshots, backlinks: backlinkSnapshot, duplicateNames };
  }

  private resolveLink(
    sourcePath: string,
    rawTarget: string,
    byPath: Map<string, string[]>,
    byName: Map<string, string[]>,
  ): LinkResolution {
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
      for (const match of byPath.get(normalizeKey(candidate)) ?? []) {
        if (!candidates.includes(match)) {
          candidates.push(match);
        }
      }
      if (candidates.length > 0) {
        break;
      }
    }
    if (candidates.length === 0 && !target.includes("/")) {
      candidates.push(...(byName.get(normalizeKey(path.posix.basename(target))) ?? []));
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
