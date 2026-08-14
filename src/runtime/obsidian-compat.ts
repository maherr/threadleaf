import { createHash } from "node:crypto";
import {
  type Dirent,
  promises as fs,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import MarkdownIt from "markdown-it";
import moment from "moment";
import TurndownService from "turndown";
import {
  isAlias,
  isCollection,
  isMap,
  isPair,
  isScalar,
  parseDocument,
  parse as parseYaml,
  stringify as yamlStringify,
} from "yaml";
import { ActionRegistry } from "../application/action-registry";
import { atomicWriteFile, revisionOf } from "../kernel/durability";
import { maskMarkdownCodeAndComments } from "../kernel/markdown-links";
import { MetadataIndex } from "../kernel/metadata-index";
import { isPathInside } from "../kernel/path-policy";
import type {
  VaultDirectoryCreateResult,
  VaultReadPort,
  VaultRenameResult,
  VaultWriteResult,
} from "../kernel/ports";
import type { CommandSummary, NoteCreateOutcome } from "../shared/contracts";
import type { PluginMutationWaitOptions } from "../shared/plugin-runtime-protocol";
import { Component } from "./obsidian-components";
import { createCompatibleIcon } from "./obsidian-icons";
import { Menu, MenuItem, MenuSeparator } from "./obsidian-menu-compat";
import {
  AbstractInputSuggest,
  AbstractTextComponent,
  BaseComponent,
  ButtonComponent,
  ColorComponent,
  DropdownComponent,
  Editor,
  EditorSuggest,
  ExtraButtonComponent,
  FileView,
  FuzzySuggestModal,
  ItemView,
  Keymap,
  MarkdownView,
  Modal,
  MomentFormatComponent,
  PluginSettingTab,
  PopoverSuggest,
  ProgressBarComponent,
  Scope,
  SearchComponent,
  Setting,
  SettingTab,
  SliderComponent,
  SuggestModal,
  TextAreaComponent,
  TextComponent,
  TextFileView,
  ToggleComponent,
  ValueComponent,
  View,
  WorkspaceLeaf,
} from "./obsidian-ui-compat";
import {
  CompatibilityIntegrationRegistry,
  Workspace,
  WorkspaceSplit,
} from "./obsidian-workspace-compat";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  description?: string;
  author?: string;
  authorUrl?: string;
  isDesktopOnly?: boolean;
}

export interface Command {
  id: string;
  name: string;
  callback?: () => unknown | Promise<unknown>;
  checkCallback?: (checking: boolean) => boolean | undefined | Promise<boolean | undefined>;
}

export interface MarkdownSectionInformation {
  text: string;
  lineStart: number;
  lineEnd: number;
}

export class MarkdownRenderChild extends Component {
  readonly containerEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    super();
    this.containerEl = containerEl;
  }
}

export interface MarkdownPostProcessorContext {
  readonly docId: string;
  readonly sourcePath: string;
  readonly frontmatter: Record<string, unknown> | null | undefined;
  addChild(child: MarkdownRenderChild): void;
  getSectionInfo(element: HTMLElement): MarkdownSectionInformation | null;
}

export type MarkdownPostProcessor = {
  // biome-ignore lint/suspicious/noConfusingVoidType: This mirrors the public Obsidian callback contract.
  (element: HTMLElement, context: MarkdownPostProcessorContext): Promise<unknown> | void;
  sortOrder?: number;
};

export type MarkdownCodeBlockProcessor = (
  source: string,
  element: HTMLElement,
  context: MarkdownPostProcessorContext,
  // biome-ignore lint/suspicious/noConfusingVoidType: This mirrors the public Obsidian callback contract.
) => Promise<unknown> | void;

interface RegisteredCommand extends Command {
  ownerId: string;
  releaseAction: () => void;
}

type VaultEventCallback = (...args: unknown[]) => unknown;

class VaultEventRef {
  private release: (() => void) | null;

  constructor(release: () => void) {
    this.release = release;
  }

  off(): void {
    this.release?.();
    this.release = null;
  }
}

export interface FileStats {
  ctime: number;
  mtime: number;
  size: number;
}

export interface CompatibilityVaultWritePort {
  createBinary?(relativePath: string, content: Uint8Array): Promise<NoteCreateOutcome>;
  createFolder?(relativePath: string): Promise<VaultDirectoryCreateResult>;
  createText?(relativePath: string, content: string): Promise<NoteCreateOutcome>;
  renameFile?(
    sourcePath: string,
    targetPath: string,
    expectedRevision: string,
  ): Promise<VaultRenameResult>;
  trashFile?(sourcePath: string, expectedRevision: string): Promise<VaultRenameResult>;
  writeBinary?(
    relativePath: string,
    content: Uint8Array,
    expectedRevision: string,
  ): Promise<VaultWriteResult>;
  writeText(
    relativePath: string,
    content: string,
    expectedRevision: string,
  ): Promise<VaultWriteResult>;
}

export class TAbstractFile {
  readonly path: string;
  readonly name: string;
  readonly vault: Vault | null;

  constructor(filePath: string, vault: Vault | null = null) {
    this.path = normalizePath(filePath);
    this.name = path.posix.basename(this.path);
    this.vault = vault;
  }

  get parent(): TFolder | null {
    if (!this.vault) {
      return null;
    }
    const parentPath = path.posix.dirname(this.path);
    return this.vault.folderForPath(parentPath === "." ? "" : parentPath);
  }
}

export class TFolder extends TAbstractFile {
  get children(): TAbstractFile[] {
    return this.vault?.childrenForFolder(this.path) ?? [];
  }

  get isRoot(): boolean {
    return this.path === "";
  }
}

export class TFile extends TAbstractFile {
  readonly path: string;
  readonly name: string;
  readonly basename: string;
  readonly extension: string;
  readonly stat: FileStats;

  constructor(filePath: string, vault: Vault | null = null, stats?: FileStats) {
    super(filePath, vault);
    this.path = normalizePath(filePath);
    this.name = path.posix.basename(this.path);
    this.extension = path.posix.extname(this.path).slice(1);
    this.basename =
      this.extension.length > 0 ? this.name.slice(0, -(this.extension.length + 1)) : this.name;
    this.stat = stats ?? { ctime: 0, mtime: 0, size: 0 };
  }
}

export interface ListedFiles {
  files: string[];
  folders: string[];
}

export interface AdapterStat {
  type: "file" | "folder";
  ctime: number;
  mtime: number;
  size: number;
}

export type SearchMatchPart = [number, number];

export interface SearchResult {
  score: number;
  matches: SearchMatchPart[];
}

export class FileSystemAdapter {
  readonly basePath: string;
  readonly url = { pathToFileURL };
  private readonly canonicalRootPath: string;
  private readonly vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
    this.basePath = vault.rootPath;
    this.canonicalRootPath = realpathSync(vault.rootPath);
  }

  getName(): string {
    return this.vault.getName();
  }

  getBasePath(): string {
    return this.basePath;
  }

  async exists(normalizedPath: string, sensitive = false): Promise<boolean> {
    let resolvedPath: string;
    try {
      resolvedPath = this.resolveExistingPath(normalizedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
    if (!sensitive) {
      return true;
    }
    const normalized = normalizePath(normalizedPath);
    let currentPath = this.basePath;
    for (const segment of normalized.split("/").filter(Boolean)) {
      const entries = await fs.readdir(currentPath);
      if (!entries.includes(segment)) {
        return false;
      }
      currentPath = path.join(currentPath, segment);
    }
    return isPathInside(this.canonicalRootPath, resolvedPath);
  }

  async stat(normalizedPath: string): Promise<AdapterStat | null> {
    let resolvedPath: string;
    try {
      resolvedPath = this.resolveExistingPath(normalizedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile() && !stats.isDirectory()) {
      return null;
    }
    return {
      type: stats.isDirectory() ? "folder" : "file",
      ctime: stats.birthtimeMs || stats.ctimeMs,
      mtime: stats.mtimeMs,
      size: stats.size,
    };
  }

  async list(normalizedPath: string): Promise<ListedFiles> {
    const resolvedPath = this.resolveExistingPath(normalizedPath);
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const listed: ListedFiles = { files: [], folders: [] };
    for (const entry of entries) {
      const childPath = normalizePath(path.posix.join(normalizePath(normalizedPath), entry.name));
      let type: "file" | "folder" | null = entry.isFile()
        ? "file"
        : entry.isDirectory()
          ? "folder"
          : null;
      if (entry.isSymbolicLink()) {
        const childStats = await fs.stat(this.resolveExistingPath(childPath));
        type = childStats.isFile() ? "file" : childStats.isDirectory() ? "folder" : null;
      }
      if (type === "file") {
        listed.files.push(childPath);
      } else if (type === "folder") {
        listed.folders.push(childPath);
      }
    }
    listed.files.sort((left, right) => left.localeCompare(right));
    listed.folders.sort((left, right) => left.localeCompare(right));
    return listed;
  }

  async read(normalizedPath: string): Promise<string> {
    return fs.readFile(this.resolveExistingPath(normalizedPath), "utf8");
  }

  async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
    const bytes = await fs.readFile(this.resolveExistingPath(normalizedPath));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  getResourcePath(normalizedPath: string): string {
    return pathToFileURL(this.resolveExistingPath(normalizedPath)).toString();
  }

  getFilePath(normalizedPath: string): string {
    return this.resolveExistingPath(normalizedPath);
  }

  private resolveExistingPath(normalizedPath: string): string {
    const lexicalPath = this.vault.resolveVaultPath(normalizePath(normalizedPath));
    const canonicalPath = realpathSync(lexicalPath);
    if (!isPathInside(this.canonicalRootPath, canonicalPath)) {
      throw new Error(`Path resolves outside the vault: ${normalizedPath}`);
    }
    return canonicalPath;
  }
}

export class Vault {
  readonly adapter: FileSystemAdapter;
  readonly configDir = ".obsidian";
  readonly rootPath: string;
  readonly #reader: VaultReadPort | undefined;
  readonly #writer: CompatibilityVaultWritePort | undefined;
  private readonly listeners = new Map<string, Set<VaultEventCallback>>();
  private readonly activeMutationKinds = new Map<number, string>();
  private inFlightMutations = 0;
  private mutationSequence = 0;
  private mutationVersion = 0;
  private readonly revisions = new Map<string, string>();

  constructor(rootPath: string, reader?: VaultReadPort, writer?: CompatibilityVaultWritePort) {
    this.rootPath = realpathSync(path.resolve(rootPath));
    this.#reader = reader;
    this.#writer = writer;
    this.adapter = new FileSystemAdapter(this);
  }

  getName(): string {
    return path.basename(this.rootPath);
  }

  on(name: string, callback: VaultEventCallback, context?: unknown): VaultEventRef {
    const bound = context ? callback.bind(context) : callback;
    const callbacks = this.listeners.get(name) ?? new Set<VaultEventCallback>();
    callbacks.add(bound);
    this.listeners.set(name, callbacks);
    return new VaultEventRef(() => {
      callbacks.delete(bound);
      if (callbacks.size === 0) {
        this.listeners.delete(name);
      }
    });
  }

  offref(eventRef: VaultEventRef): void {
    eventRef.off();
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const callback of [...(this.listeners.get(name) ?? [])]) {
      callback(...args);
    }
  }

  getFiles(): TFile[] {
    const files: TFile[] = [];
    this.collectFiles(this.rootPath, files);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((file) => file.extension.toLowerCase() === "md");
  }

  getAllFolders(includeRoot = false): TFolder[] {
    const folders: TFolder[] = includeRoot ? [this.folderForPath("")] : [];
    const collect = (absoluteDirectory: string): void => {
      for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || !entry.isDirectory()) {
          continue;
        }
        const absolutePath = path.join(absoluteDirectory, entry.name);
        const relativePath = path.relative(this.rootPath, absolutePath).split(path.sep).join("/");
        folders.push(this.folderForPath(relativePath));
        collect(absolutePath);
      }
    };
    collect(this.rootPath);
    return folders.sort((left, right) => left.path.localeCompare(right.path));
  }

  getAvailablePath(basePath: string, extension: string): string {
    const normalizedBase = normalizePath(basePath);
    if (!normalizedBase || normalizedBase.endsWith("/")) {
      throw new Error("Available-path base must name a file.");
    }
    const normalizedExtension = extension.replace(/^\.+/u, "");
    const occupied = new Set(
      [...this.getFiles(), ...this.getAllFolders(true)].map((entry) =>
        entry.path.toLocaleLowerCase("en-US"),
      ),
    );
    const suffix = normalizedExtension ? `.${normalizedExtension}` : "";
    for (let collision = 0; collision < 10_000; collision += 1) {
      const candidate = `${normalizedBase}${collision === 0 ? "" : ` ${collision}`}${suffix}`;
      if (!occupied.has(candidate.toLocaleLowerCase("en-US"))) {
        return candidate;
      }
    }
    throw new Error(`Could not find an available path for ${normalizedBase}${suffix}.`);
  }

  async getAvailablePathForAttachments(
    filename: string,
    extension: string,
    sourceFile?: TFile | null,
  ): Promise<string> {
    const normalizedFilename = path.posix.basename(normalizePath(filename));
    if (!normalizedFilename) {
      throw new Error("Attachment filename must not be empty.");
    }
    if (sourceFile && sourceFile.vault !== this) {
      throw new Error(
        "Attachment paths require a source file from the active compatibility vault.",
      );
    }
    const parentPath = sourceFile?.parent?.path ?? "";
    return this.getAvailablePath(
      normalizePath(path.posix.join(parentPath, normalizedFilename)),
      extension,
    );
  }

  getAllLoadedFiles(): TAbstractFile[] {
    const files = this.getFiles();
    const folders = new Map<string, TFolder>();
    folders.set("", this.folderForPath(""));
    for (const file of files) {
      let parentPath = path.posix.dirname(file.path);
      while (parentPath !== "." && !folders.has(parentPath)) {
        folders.set(parentPath, this.folderForPath(parentPath));
        parentPath = path.posix.dirname(parentPath);
      }
    }
    return [...folders.values(), ...files];
  }

  getRoot(): TFolder {
    return this.folderForPath("");
  }

  getAbstractFileByPath(filePath: string): TAbstractFile | null {
    const normalized = normalizePath(filePath);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(this.resolveVaultPath(normalized));
    } catch {
      return null;
    }
    if (stats.isFile()) {
      return this.fileFromStats(normalized, stats);
    }
    return stats.isDirectory() ? this.folderForPath(normalized) : null;
  }

  getAbstractFileByPathInsensitive(filePath: string): TAbstractFile | null {
    const requested = normalizePath(filePath).toLocaleLowerCase("en-US");
    return (
      this.getAllLoadedFiles().find(
        (candidate) => candidate.path.toLocaleLowerCase("en-US") === requested,
      ) ?? null
    );
  }

  getFileByPath(filePath: string): TFile | null {
    const abstractFile = this.getAbstractFileByPath(filePath);
    return abstractFile instanceof TFile ? abstractFile : null;
  }

  getFolderByPath(folderPath: string): TFolder | null {
    const abstractFile = this.getAbstractFileByPath(folderPath);
    return abstractFile instanceof TFolder ? abstractFile : null;
  }

  getResourcePath(file: TFile): string {
    if (file.vault !== this) {
      throw new Error("Plugin resource paths require a file from the active compatibility vault.");
    }
    return this.adapter.getResourcePath(file.path);
  }

  getConfig(_key: string): unknown {
    return undefined;
  }

  async read(file: TFile): Promise<string> {
    if (this.#reader) {
      const snapshot = await this.#reader.readText(file.path);
      this.revisions.set(file.path, snapshot.revision);
      return snapshot.content;
    }
    const bytes = await fs.readFile(this.resolveVaultPath(file.path));
    this.revisions.set(file.path, revisionOf(bytes));
    return bytes.toString("utf8");
  }

  cachedRead(file: TFile): Promise<string> {
    return this.read(file);
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const bytes = await fs.readFile(this.resolveVaultPath(file.path));
    this.revisions.set(file.path, revisionOf(bytes));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  async modifyBinary(file: TFile, content: ArrayBuffer): Promise<void> {
    if (!this.#writer?.writeBinary) {
      throw new Error(
        "Plugin binary saves are not available in the read-only compatibility runtime.",
      );
    }
    if (file.vault !== this) {
      throw new Error("Plugin vault writes require a file from the active compatibility vault.");
    }
    const normalized = normalizePath(file.path);
    let expectedRevision = this.revisions.get(normalized);
    if (!expectedRevision) {
      await this.readBinary(file);
      expectedRevision = this.revisions.get(normalized);
    }
    if (!expectedRevision) {
      throw new Error(`Could not establish the current revision for ${normalized}.`);
    }
    const outcome = await this.trackMutation("modify-binary", () =>
      this.#writer?.writeBinary?.(normalized, new Uint8Array(content), expectedRevision),
    );
    if (!outcome) {
      throw new Error(
        "Plugin binary saves are not available in the read-only compatibility runtime.",
      );
    }
    if (outcome.status === "conflict") {
      throw new Error(
        `Plugin save conflict for ${normalized}; the proposed bytes were preserved at ${outcome.conflictPath}.`,
      );
    }
    this.revisions.set(normalized, outcome.revision);
    file.stat.mtime = Date.now();
    file.stat.size = content.byteLength;
    this.trigger("modify", file);
  }

  async modify(file: TFile, content: string): Promise<void> {
    if (!this.#writer) {
      throw new Error(
        "Plugin view saves are not available in the read-only compatibility runtime.",
      );
    }
    if (file.vault !== this) {
      throw new Error("Plugin vault writes require a file from the active compatibility vault.");
    }
    const normalized = normalizePath(file.path);
    let expectedRevision = this.revisions.get(normalized);
    if (!expectedRevision) {
      await this.read(file);
      expectedRevision = this.revisions.get(normalized);
    }
    if (!expectedRevision) {
      throw new Error(`Could not establish the current revision for ${normalized}.`);
    }
    const outcome = await this.trackMutation("modify-text", () =>
      this.#writer?.writeText(normalized, content, expectedRevision),
    );
    if (!outcome) {
      throw new Error(
        "Plugin view saves are not available in the read-only compatibility runtime.",
      );
    }
    if (outcome.status === "conflict") {
      throw new Error(
        `Plugin save conflict for ${normalized}; the proposed bytes were preserved at ${outcome.conflictPath}.`,
      );
    }
    this.revisions.set(normalized, outcome.revision);
    file.stat.mtime = Date.now();
    file.stat.size = Buffer.byteLength(content, "utf8");
    this.trigger("modify", file);
  }

  async create(filePath: string, content: string): Promise<TFile> {
    if (!this.#writer?.createText) {
      throw new Error(
        "Plugin file creation is not available in the read-only compatibility runtime.",
      );
    }
    const normalized = normalizePath(filePath);
    const outcome = await this.trackMutation("create-text", () =>
      this.#writer?.createText?.(normalized, content),
    );
    if (!outcome) {
      throw new Error(
        "Plugin file creation is not available in the read-only compatibility runtime.",
      );
    }
    if (outcome.status === "exists") {
      throw new Error(`Plugin file creation refused to overwrite ${outcome.path}.`);
    }
    if (outcome.status === "conflict") {
      throw new Error(
        `Plugin file creation conflict for ${normalized}; the proposed bytes were preserved at ${outcome.conflictPath}.`,
      );
    }
    const now = Date.now();
    const file =
      this.getFileByPath(outcome.path) ??
      new TFile(outcome.path, this, {
        ctime: now,
        mtime: now,
        size: Buffer.byteLength(content, "utf8"),
      });
    this.revisions.set(file.path, outcome.revision);
    this.trigger("create", file);
    return file;
  }

  async createBinary(filePath: string, content: ArrayBuffer): Promise<TFile> {
    if (!this.#writer?.createBinary) {
      throw new Error(
        "Plugin binary creation is not available in the read-only compatibility runtime.",
      );
    }
    const normalized = normalizePath(filePath);
    const outcome = await this.trackMutation("create-binary", () =>
      this.#writer?.createBinary?.(normalized, new Uint8Array(content)),
    );
    if (!outcome) {
      throw new Error(
        "Plugin binary creation is not available in the read-only compatibility runtime.",
      );
    }
    if (outcome.status === "exists") {
      throw new Error(`Plugin file creation refused to overwrite ${outcome.path}.`);
    }
    if (outcome.status === "conflict") {
      throw new Error(
        `Plugin file creation conflict for ${normalized}; the proposed bytes were preserved at ${outcome.conflictPath}.`,
      );
    }
    const now = Date.now();
    const file =
      this.getFileByPath(outcome.path) ??
      new TFile(outcome.path, this, {
        ctime: now,
        mtime: now,
        size: content.byteLength,
      });
    this.revisions.set(file.path, outcome.revision);
    this.trigger("create", file);
    return file;
  }

  async createFolder(folderPath: string): Promise<TFolder> {
    if (!this.#writer?.createFolder) {
      throw new Error(
        "Plugin folder creation is not available in the read-only compatibility runtime.",
      );
    }
    const outcome = await this.trackMutation("create-folder", () =>
      this.#writer?.createFolder?.(normalizePath(folderPath)),
    );
    if (!outcome) {
      throw new Error(
        "Plugin folder creation is not available in the read-only compatibility runtime.",
      );
    }
    const folder = this.folderForPath(outcome.path);
    if (outcome.created) {
      this.trigger("create", folder);
    }
    return folder;
  }

  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    if (!this.#writer?.renameFile) {
      throw new Error(
        "Plugin file renames are not available in the read-only compatibility runtime.",
      );
    }
    if (!(file instanceof TFile)) {
      throw new Error("Plugin folder renames are not supported yet.");
    }
    if (file.vault !== this) {
      throw new Error("Plugin vault renames require a file from the active compatibility vault.");
    }
    const sourcePath = normalizePath(file.path);
    const targetPath = normalizePath(newPath);
    let expectedRevision = this.revisions.get(sourcePath);
    if (!expectedRevision) {
      await this.readBinary(file);
      expectedRevision = this.revisions.get(sourcePath);
    }
    if (!expectedRevision) {
      throw new Error(`Could not establish the current revision for ${sourcePath}.`);
    }
    const outcome = await this.trackMutation("rename", () =>
      this.#writer?.renameFile?.(sourcePath, targetPath, expectedRevision),
    );
    if (!outcome) {
      throw new Error(
        "Plugin file renames are not available in the read-only compatibility runtime.",
      );
    }
    if (outcome.status === "conflict") {
      throw new Error(
        `Plugin rename conflict for ${sourcePath} to ${targetPath}: ${outcome.reason}.`,
      );
    }
    this.revisions.delete(sourcePath);
    this.revisions.set(targetPath, expectedRevision);
    const mutableFile = file as unknown as {
      basename: string;
      extension: string;
      name: string;
      path: string;
    };
    mutableFile.path = targetPath;
    mutableFile.name = path.posix.basename(targetPath);
    mutableFile.extension = path.posix.extname(targetPath).slice(1);
    mutableFile.basename =
      mutableFile.extension.length > 0
        ? mutableFile.name.slice(0, -(mutableFile.extension.length + 1))
        : mutableFile.name;
    this.trigger("rename", file, sourcePath);
  }

  async trash(file: TAbstractFile): Promise<void> {
    if (!this.#writer?.trashFile) {
      throw new Error("Plugin file trash is not available in the read-only compatibility runtime.");
    }
    if (!(file instanceof TFile)) {
      throw new Error("Plugin folder trash is not supported yet.");
    }
    if (file.vault !== this) {
      throw new Error("Plugin trash requires a file from the active compatibility vault.");
    }
    const sourcePath = normalizePath(file.path);
    let expectedRevision = this.revisions.get(sourcePath);
    if (!expectedRevision) {
      await this.readBinary(file);
      expectedRevision = this.revisions.get(sourcePath);
    }
    if (!expectedRevision) {
      throw new Error(`Could not establish the current revision for ${sourcePath}.`);
    }
    const outcome = await this.trackMutation("trash", () =>
      this.#writer?.trashFile?.(sourcePath, expectedRevision),
    );
    if (!outcome) {
      throw new Error("Plugin file trash is not available in the read-only compatibility runtime.");
    }
    if (outcome.status === "conflict") {
      throw new Error(`Plugin trash conflict for ${sourcePath}: ${outcome.reason}.`);
    }
    this.revisions.delete(sourcePath);
    this.trigger("delete", file);
  }

  async waitForSettledMutations(quietMs = 75, timeoutMs = 5_000): Promise<void> {
    const startedAt = Date.now();
    let observedVersion = this.mutationVersion;
    let quietSince = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (this.inFlightMutations > 0 || this.mutationVersion !== observedVersion) {
        observedVersion = this.mutationVersion;
        quietSince = Date.now();
        continue;
      }
      if (Date.now() - quietSince >= quietMs) {
        return;
      }
    }
    const activeKinds = [...new Set(this.activeMutationKinds.values())].sort();
    const detail = activeKinds.length > 0 ? ` Active operations: ${activeKinds.join(", ")}.` : "";
    throw new Error(
      `Plugin vault mutations did not settle before the compatibility timeout.${detail}`,
    );
  }

  waitForPluginMutations(options?: PluginMutationWaitOptions): Promise<void> {
    return this.waitForSettledMutations(options?.quietMs, options?.timeoutMs);
  }

  private async trackMutation<T>(
    kind: string,
    operation: () => Promise<T> | undefined,
  ): Promise<T | undefined> {
    const sequence = ++this.mutationSequence;
    this.activeMutationKinds.set(sequence, kind);
    this.inFlightMutations += 1;
    this.mutationVersion += 1;
    try {
      return await operation();
    } finally {
      this.activeMutationKinds.delete(sequence);
      this.inFlightMutations -= 1;
      this.mutationVersion += 1;
    }
  }

  resolveVaultPath(relativePath: string): string {
    const normalized = relativePath.replaceAll("\\", "/");
    const absolutePath = path.resolve(this.rootPath, normalized);
    const relative = path.relative(this.rootPath, absolutePath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path escapes the vault: ${relativePath}`);
    }

    return absolutePath;
  }

  folderForPath(folderPath: string): TFolder {
    return new TFolder(normalizePath(folderPath), this);
  }

  childrenForFolder(folderPath: string): TAbstractFile[] {
    const absolutePath = this.resolveVaultPath(folderPath);
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(absolutePath, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => {
        const childPath = normalizePath(path.posix.join(folderPath, entry.name));
        if (entry.isDirectory()) {
          return this.folderForPath(childPath);
        }
        const stats = statSync(this.resolveVaultPath(childPath));
        return this.fileFromStats(childPath, stats);
      })
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  private collectFiles(directory: string, files: TFile[]): void {
    const entries = readdirSync(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        this.collectFiles(absolutePath, files);
        continue;
      }

      if (entry.isFile()) {
        const relativePath = path.relative(this.rootPath, absolutePath).split(path.sep).join("/");
        files.push(this.fileFromStats(relativePath, statSync(absolutePath)));
      }
    }
  }

  private fileFromStats(
    filePath: string,
    stats: { birthtimeMs: number; ctimeMs: number; mtimeMs: number; size: number },
  ): TFile {
    return new TFile(filePath, this, {
      ctime: stats.birthtimeMs || stats.ctimeMs,
      mtime: stats.mtimeMs,
      size: stats.size,
    });
  }
}

export class FileManager {
  readonly vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    return this.vault.rename(file, newPath);
  }

  trashFile(file: TAbstractFile): Promise<void> {
    return this.vault.trash(file);
  }

  async getAvailablePathForAttachment(filename: string, sourcePath = ""): Promise<string> {
    const normalizedFilename = path.posix.basename(normalizePath(filename));
    if (!normalizedFilename) {
      throw new Error("Attachment filename must not be empty.");
    }
    const dottedExtension = path.posix.extname(normalizedFilename);
    const stem = dottedExtension
      ? normalizedFilename.slice(0, -dottedExtension.length)
      : normalizedFilename;
    const sourceFile = sourcePath ? this.vault.getFileByPath(sourcePath) : null;
    if (sourcePath && !sourceFile) {
      const sourceDirectory = path.posix.dirname(normalizePath(sourcePath));
      return this.vault.getAvailablePath(
        normalizePath(path.posix.join(sourceDirectory === "." ? "" : sourceDirectory, stem)),
        dottedExtension,
      );
    }
    return this.vault.getAvailablePathForAttachments(stem, dottedExtension, sourceFile);
  }

  async processFrontMatter(
    file: TFile,
    callback: (frontmatter: Record<string, unknown>) => unknown,
    _options?: unknown,
  ): Promise<void> {
    if (file.vault !== this.vault) {
      throw new Error("Frontmatter updates require a file from the active compatibility vault.");
    }
    if (file.extension.toLocaleLowerCase("en-US") !== "md") {
      throw new Error("Frontmatter updates require a Markdown file.");
    }
    const content = await this.vault.read(file);
    const updated = updateFrontmatterBytes(content, callback);
    if (updated !== content) {
      await this.vault.modify(file, updated);
    }
  }
}

interface FrontmatterRegion {
  source: string;
  sourceEnd: number;
  sourceStart: number;
}

function locateFrontmatter(content: string): FrontmatterRegion | null {
  const opening = /^\ufeff?---[\t ]*(?:\r\n|\n)/u.exec(content);
  if (!opening) {
    return null;
  }
  const remaining = content.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[\t ]*(?:\r\n|\n|$)/mu.exec(remaining);
  if (!closing) {
    throw new Error("Cannot process unterminated YAML frontmatter.");
  }
  const sourceStart = opening[0].length;
  const sourceEnd = sourceStart + closing.index;
  return {
    source: content.slice(sourceStart, sourceEnd),
    sourceEnd,
    sourceStart,
  };
}

function yamlLineEnding(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function assertSupportedFrontmatterValue(value: unknown, seen = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot serialize a non-finite frontmatter number.");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`Cannot serialize frontmatter value of type ${typeof value}.`);
  }
  if (seen.has(value)) {
    throw new Error(
      "Cannot serialize a shared or cyclic frontmatter value as implicit YAML aliases.",
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertSupportedFrontmatterValue(item, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Cannot serialize a non-plain frontmatter object.");
    }
    for (const item of Object.values(value as Record<string, unknown>)) {
      assertSupportedFrontmatterValue(item, seen);
    }
  }
}

function yamlNodeHasUnsupportedSyntax(node: unknown): boolean {
  if (isAlias(node)) {
    return true;
  }
  if (isPair(node)) {
    return yamlNodeHasUnsupportedSyntax(node.key) || yamlNodeHasUnsupportedSyntax(node.value);
  }
  if (isScalar(node)) {
    return Boolean(node.anchor || node.tag || node.commentBefore || node.comment);
  }
  if (isCollection(node)) {
    return (
      Boolean(
        node.anchor ||
          node.tag ||
          node.commentBefore ||
          node.comment ||
          node.flow ||
          node.spaceBefore,
      ) || node.items.some((item) => yamlNodeHasUnsupportedSyntax(item))
    );
  }
  return node !== null && node !== undefined;
}

function serializeYamlEntry(key: string, value: unknown, lineEnding: string): string {
  assertSupportedFrontmatterValue(value);
  const entry = Object.create(null) as Record<string, unknown>;
  entry[key] = value;
  return yamlStringify(entry, { lineWidth: 0 }).replaceAll("\n", lineEnding);
}

function serializeScalarLike(node: unknown, value: unknown): string {
  assertSupportedFrontmatterValue(value);
  if (!isScalar(node) || node.anchor || node.tag) {
    throw new Error("Cannot modify unsupported YAML scalar syntax without normalizing it.");
  }
  if (typeof value === "string" && typeof node.value === "string") {
    if (node.type === "QUOTE_DOUBLE") {
      return JSON.stringify(value);
    }
    if (node.type === "QUOTE_SINGLE") {
      return `'${value.replaceAll("'", "''")}'`;
    }
    if (node.type === "BLOCK_FOLDED" || node.type === "BLOCK_LITERAL") {
      throw new Error("Cannot modify unsupported YAML block scalar syntax without normalizing it.");
    }
  }
  const serialized = yamlStringify(value, { lineWidth: 0 }).trimEnd();
  if (serialized.includes("\n")) {
    throw new Error("Cannot replace a YAML scalar with a collection through a scalar patch.");
  }
  return serialized;
}

function yamlNodeRange(node: unknown): [number, number, number] | null {
  if (!node || typeof node !== "object" || !("range" in node)) {
    return null;
  }
  const range = (node as { range?: unknown }).range;
  return Array.isArray(range) && range.length === 3 && range.every(Number.isInteger)
    ? (range as [number, number, number])
    : null;
}

function yamlPairEnd(source: string, pair: unknown): number {
  if (!isPair(pair)) {
    throw new Error("Cannot patch unsupported YAML top-level content.");
  }
  const valueRange = yamlNodeRange(pair.value);
  if (valueRange) {
    return valueRange[2];
  }
  const keyRange = yamlNodeRange(pair.key);
  if (!keyRange) {
    throw new Error("Cannot patch unsupported YAML key syntax.");
  }
  const newline = source.indexOf("\n", keyRange[2]);
  return newline === -1 ? source.length : newline + 1;
}

function patchExistingFrontmatter(
  source: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  lineEnding: string,
): string {
  const document = parseDocument(source, {
    keepSourceTokens: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw document.errors[0];
  }
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error("Cannot process YAML frontmatter whose top level is not a mapping.");
  }
  const pairsByKey = new Map<string, unknown>();
  for (const pair of document.contents?.items ?? []) {
    if (!isPair(pair) || !isScalar(pair.key)) {
      throw new Error("Cannot process unsupported YAML frontmatter key syntax.");
    }
    pairsByKey.set(String(pair.key.value), pair);
  }

  const edits: Array<{ end: number; replacement: string; start: number }> = [];
  for (const key of Object.keys(before)) {
    if (Object.hasOwn(after, key) && isDeepStrictEqual(before[key], after[key])) {
      continue;
    }
    const pair = pairsByKey.get(key);
    if (!isPair(pair)) {
      throw new Error(`Cannot find the source YAML for frontmatter key ${key}.`);
    }
    const keyRange = yamlNodeRange(pair.key);
    if (!keyRange) {
      throw new Error(`Cannot patch unsupported YAML key ${key}.`);
    }
    if (!Object.hasOwn(after, key)) {
      if (yamlNodeHasUnsupportedSyntax(pair)) {
        throw new Error(`Cannot remove ${key} because it uses unsupported YAML syntax.`);
      }
      edits.push({ start: keyRange[0], end: yamlPairEnd(source, pair), replacement: "" });
      continue;
    }

    const nextValue = after[key];
    const nextValueIsScalar =
      nextValue === null ||
      typeof nextValue === "string" ||
      typeof nextValue === "number" ||
      typeof nextValue === "boolean" ||
      typeof nextValue === "undefined";
    if (isScalar(pair.value) && nextValueIsScalar) {
      const valueRange = yamlNodeRange(pair.value);
      if (!valueRange) {
        throw new Error(`Cannot patch unsupported YAML scalar ${key}.`);
      }
      edits.push({
        start: valueRange[0],
        end: valueRange[1],
        replacement: serializeScalarLike(pair.value, nextValue),
      });
      continue;
    }
    if (yamlNodeHasUnsupportedSyntax(pair)) {
      throw new Error(`Cannot modify ${key} because it uses unsupported YAML syntax.`);
    }
    edits.push({
      start: keyRange[0],
      end: yamlPairEnd(source, pair),
      replacement: serializeYamlEntry(key, nextValue, lineEnding),
    });
  }

  let patched = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    patched = `${patched.slice(0, edit.start)}${edit.replacement}${patched.slice(edit.end)}`;
  }
  const additions = Object.keys(after).filter((key) => !Object.hasOwn(before, key));
  if (additions.length > 0) {
    if (patched && !patched.endsWith("\n")) {
      patched += lineEnding;
    }
    for (const key of additions) {
      patched += serializeYamlEntry(key, after[key], lineEnding);
    }
  }
  return patched;
}

function updateFrontmatterBytes(
  content: string,
  callback: (frontmatter: Record<string, unknown>) => unknown,
): string {
  const region = locateFrontmatter(content);
  const lineEnding = yamlLineEnding(content);
  const parsed = region ? parseYaml(region.source, { maxAliasCount: 100, uniqueKeys: true }) : {};
  const before = parsed ?? {};
  if (
    before === null ||
    typeof before !== "object" ||
    Array.isArray(before) ||
    Object.getPrototypeOf(before) !== Object.prototype
  ) {
    throw new Error("Cannot process YAML frontmatter whose top level is not a mapping.");
  }
  const frontmatter = before as Record<string, unknown>;
  const baseline = structuredClone(frontmatter);
  const callbackResult = callback(frontmatter);
  if (
    callbackResult &&
    (typeof callbackResult === "object" || typeof callbackResult === "function") &&
    "then" in callbackResult
  ) {
    throw new Error("Frontmatter processing callbacks must be synchronous.");
  }
  if (isDeepStrictEqual(baseline, frontmatter)) {
    return content;
  }

  let updated: string;
  if (region) {
    const patchedSource = patchExistingFrontmatter(
      region.source,
      baseline,
      frontmatter,
      lineEnding,
    );
    updated = `${content.slice(0, region.sourceStart)}${patchedSource}${content.slice(region.sourceEnd)}`;
  } else {
    const bom = content.startsWith("\ufeff") ? "\ufeff" : "";
    const body = content.slice(bom.length);
    const yaml = stringifyYaml(frontmatter).replaceAll("\n", lineEnding);
    updated = `${bom}---${lineEnding}${yaml}---${lineEnding}${body}`;
  }
  const reparsed = parseFrontmatter(updated);
  if (!reparsed || !isDeepStrictEqual(reparsed, frontmatter)) {
    throw new Error("Frontmatter patch verification failed; no vault write was attempted.");
  }
  return updated;
}

export interface CachedMetadata {
  frontmatter?: Record<string, unknown>;
  tags?: TagCache[];
}

export interface CacheLocation {
  col: number;
  line: number;
  offset: number;
}

export interface CachePosition {
  end: CacheLocation;
  start: CacheLocation;
}

export interface TagCache {
  position: CachePosition;
  tag: string;
}

interface CachedMetadataRecord {
  mtime: number;
  size: number;
  value: CachedMetadata;
}

function frontmatterSource(content: string): string | null {
  const opening = /^\ufeff?---[\t ]*(?:\r\n|\n)/.exec(content);
  if (!opening) {
    return null;
  }
  const remaining = content.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[\t ]*(?:\r\n|\n|$)/m.exec(remaining);
  return closing ? remaining.slice(0, closing.index) : null;
}

function parseFrontmatter(content: string): Record<string, unknown> | undefined {
  const source = frontmatterSource(content);
  if (source === null) {
    return undefined;
  }
  try {
    const parsed: unknown = parseYaml(source, { maxAliasCount: 100 });
    if (parsed === null) {
      return {};
    }
    return typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseFrontMatterEntry(
  frontmatter: unknown | null,
  key: string | RegExp,
): unknown | null {
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return null;
  }
  for (const [entryKey, value] of Object.entries(frontmatter as Record<string, unknown>)) {
    if (typeof key === "string") {
      if (entryKey === key) {
        return value ?? null;
      }
      continue;
    }
    key.lastIndex = 0;
    if (key.test(entryKey)) {
      return value ?? null;
    }
  }
  return null;
}

function normalizeFrontmatterTag(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/^#+/u, "");
  return normalized ? `#${normalized}` : null;
}

export function parseFrontMatterTags(frontmatter: unknown | null): string[] | null {
  const entry = parseFrontMatterEntry(frontmatter, "tags");
  const values = Array.isArray(entry) ? entry : typeof entry === "string" ? entry.split(",") : null;
  if (!values) {
    return null;
  }
  return values
    .map((value) => normalizeFrontmatterTag(value))
    .filter((value): value is string => value !== null);
}

export function getAllTags(cache: CachedMetadata): string[] | null {
  const frontmatterTags = parseFrontMatterTags(cache.frontmatter ?? null);
  const inlineTags = cache.tags?.map(({ tag }) => tag) ?? [];
  if (frontmatterTags === null && cache.tags === undefined) {
    return null;
  }
  return [...(frontmatterTags ?? []), ...inlineTags];
}

export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const subpathStart = linktext.indexOf("#");
  return subpathStart === -1
    ? { path: linktext, subpath: "" }
    : {
        path: linktext.slice(0, subpathStart),
        subpath: linktext.slice(subpathStart),
      };
}

export function getLinkpath(linktext: string): string {
  return parseLinktext(linktext).path;
}

export function stringifyYaml(value: unknown): string {
  return yamlStringify(value, { lineWidth: 0 });
}

function cacheLocation(content: string, offset: number): CacheLocation {
  const before = content.slice(0, offset);
  const lastNewline = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length - 1,
    col: offset - (lastNewline + 1),
    offset,
  };
}

function inlineTagCaches(content: string): TagCache[] {
  const searchable = maskMarkdownCodeAndComments(content);
  const tags: TagCache[] = [];
  for (const match of searchable.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]+)/gu)) {
    if (match.index === undefined || !match[1]) {
      continue;
    }
    const hashOffset = match.index + match[0].lastIndexOf("#");
    const endOffset = hashOffset + match[1].length + 1;
    tags.push({
      tag: `#${match[1]}`,
      position: {
        start: cacheLocation(content, hashOffset),
        end: cacheLocation(content, endOffset),
      },
    });
  }
  return tags;
}

function cleanLinkpath(linkpath: string): string {
  const withoutReference = linkpath.split("#", 1)[0]?.split("|", 1)[0] ?? "";
  try {
    return normalizePath(decodeURIComponent(withoutReference.trim()));
  } catch {
    return normalizePath(withoutReference.trim());
  }
}

export class MetadataCache {
  readonly blockCache = {
    getForFile: async (_token: unknown, _file: TFile): Promise<{ blocks: unknown[] }> => ({
      blocks: [],
    }),
  };

  private readonly cache = new Map<string, CachedMetadataRecord>();
  private readonly listeners = new Map<string, Set<VaultEventCallback>>();
  private readonly vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  getFileCache(file: TFile | null): CachedMetadata | null {
    if (!file) {
      return null;
    }
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(this.vault.resolveVaultPath(file.path));
    } catch {
      this.cache.delete(file.path);
      return null;
    }
    const existing = this.cache.get(file.path);
    if (existing && existing.mtime === stats.mtimeMs && existing.size === stats.size) {
      return existing.value;
    }

    let value: CachedMetadata = {};
    if (file.extension.toLowerCase() === "md") {
      try {
        const content = readFileSync(this.vault.resolveVaultPath(file.path), "utf8");
        const frontmatter = parseFrontmatter(content);
        const tags = inlineTagCaches(content);
        value = {
          ...(frontmatter ? { frontmatter } : {}),
          ...(tags.length > 0 ? { tags } : {}),
        };
      } catch {
        value = {};
      }
    }
    this.cache.set(file.path, { mtime: stats.mtimeMs, size: stats.size, value });
    return value;
  }

  getCache(filePath: string): CachedMetadata | null {
    return this.getFileCache(this.vault.getFileByPath(filePath));
  }

  getCachedFiles(): string[] {
    return this.vault.getFiles().map((file) => file.path);
  }

  getTags(): Record<string, number> {
    const counts = new Map<string, number>();
    for (const file of this.vault.getMarkdownFiles()) {
      const tags = getAllTags(this.getFileCache(file) ?? {});
      for (const tag of tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
  }

  get unresolvedLinks(): Record<string, Record<string, number>> {
    const snapshots = this.vault.getMarkdownFiles().map((file) => {
      const content = readFileSync(this.vault.resolveVaultPath(file.path), "utf8");
      return {
        path: file.path,
        content,
        revision: revisionOf(Buffer.from(content, "utf8")),
        size: Buffer.byteLength(content, "utf8"),
      };
    });
    const unresolved: Record<string, Record<string, number>> = {};
    for (const document of MetadataIndex.fromSnapshots(snapshots).snapshot().documents) {
      const counts = new Map<string, number>();
      for (const link of document.links) {
        if (link.resolution.status !== "resolved") {
          counts.set(link.target, (counts.get(link.target) ?? 0) + 1);
        }
      }
      if (counts.size > 0) {
        unresolved[document.path] = Object.fromEntries(
          [...counts].sort(([left], [right]) => left.localeCompare(right)),
        );
      }
    }
    return unresolved;
  }

  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    const requested = cleanLinkpath(linkpath);
    if (!requested) {
      return this.vault.getFileByPath(sourcePath);
    }

    const sourceDirectory = path.posix.dirname(normalizePath(sourcePath));
    const candidates = new Set<string>();
    const addCandidate = (candidate: string): void => {
      const normalized = normalizePath(candidate);
      candidates.add(normalized);
      if (!path.posix.extname(normalized)) {
        candidates.add(`${normalized}.md`);
      }
    };
    if (sourceDirectory !== ".") {
      addCandidate(path.posix.join(sourceDirectory, requested));
    }
    addCandidate(requested);
    for (const candidate of candidates) {
      const file = this.vault.getFileByPath(candidate);
      if (file) {
        return file;
      }
    }

    const requestedName = path.posix.basename(requested).toLocaleLowerCase("en-US");
    const hasExtension = path.posix.extname(requestedName).length > 0;
    return (
      this.vault
        .getFiles()
        .filter((file) =>
          hasExtension
            ? file.name.toLocaleLowerCase("en-US") === requestedName
            : file.basename.toLocaleLowerCase("en-US") === requestedName,
        )
        .sort(
          (left, right) =>
            left.path.length - right.path.length || left.path.localeCompare(right.path),
        )[0] ?? null
    );
  }

  fileToLinktext(file: TFile, _sourcePath: string, omitMdExtension = false): string {
    const sameBasename = this.vault
      .getFiles()
      .filter(
        (candidate) =>
          candidate.basename.toLocaleLowerCase("en-US") ===
          file.basename.toLocaleLowerCase("en-US"),
      );
    const shortestUniquePath = sameBasename.length === 1 ? file.name : file.path;
    return omitMdExtension && file.extension.toLocaleLowerCase("en-US") === "md"
      ? shortestUniquePath.slice(0, -3)
      : shortestUniquePath;
  }

  getLinks(): Record<string, Array<{ link: string }>> {
    return {};
  }

  get resolvedLinks(): Record<string, Record<string, number>> {
    return {};
  }

  getLinkSuggestions(): Array<{ file: TFile; path: string }> {
    return this.vault.getFiles().map((file) => ({ file, path: file.path }));
  }

  on(name: string, callback: VaultEventCallback, context?: unknown): VaultEventRef {
    const bound = context ? callback.bind(context) : callback;
    const callbacks = this.listeners.get(name) ?? new Set<VaultEventCallback>();
    callbacks.add(bound);
    this.listeners.set(name, callbacks);
    return new VaultEventRef(() => this.removeListener(name, bound));
  }

  off(name: string, callback: VaultEventCallback): void {
    this.removeListener(name, callback);
  }

  offref(eventRef: VaultEventRef): void {
    eventRef.off();
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const callback of [...(this.listeners.get(name) ?? [])]) {
      callback(...args);
    }
  }

  private removeListener(name: string, callback: VaultEventCallback): void {
    const callbacks = this.listeners.get(name);
    callbacks?.delete(callback);
    if (callbacks?.size === 0) {
      this.listeners.delete(name);
    }
  }
}

export class CommandRegistry {
  private readonly commands = new Map<string, RegisteredCommand>();
  readonly actions: ActionRegistry;

  constructor(actions = new ActionRegistry()) {
    this.actions = actions;
  }

  register(ownerId: string, command: Command): () => void {
    const previous = this.commands.get(command.id);
    if (previous && previous.ownerId !== ownerId) {
      throw new Error(`Command already registered: ${command.id}`);
    }
    previous?.releaseAction();

    const releaseAction = this.actions.register(ownerId, {
      id: command.id,
      name: command.name,
      source: "plugin",
      execute: async () => {
        if (command.callback) {
          return command.callback();
        }
        if (command.checkCallback) {
          return command.checkCallback(false);
        }
        throw new Error(`Command has no supported callback: ${command.id}`);
      },
    });
    const registered = { ...command, ownerId, releaseAction };
    this.commands.set(command.id, registered);
    return () => {
      if (this.commands.get(command.id) === registered) {
        this.commands.delete(command.id);
        releaseAction();
      }
    };
  }

  list(): CommandSummary[] {
    return [...this.commands.values()]
      .map(({ id, name, ownerId }) => ({ id, name, ownerId }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async run(commandId: string): Promise<boolean> {
    const command = this.commands.get(commandId);
    if (!command || !(await this.canRun(commandId))) {
      return false;
    }

    await this.actions.dispatch(commandId);
    return true;
  }

  async canRun(commandId: string): Promise<boolean> {
    const command = this.commands.get(commandId);
    if (!command) {
      return false;
    }
    if (command.callback) {
      return true;
    }
    if (!command.checkCallback) {
      return false;
    }
    return (await command.checkCallback(true)) === true;
  }

  ownerIdFor(commandId: string): string | null {
    return this.commands.get(commandId)?.ownerId ?? null;
  }
}

export class NoticeBus {
  private readonly messages: string[] = [];
  private readonly onNotice: (message: string) => void;

  constructor(onNotice: (message: string) => void) {
    this.onNotice = onNotice;
  }

  show(message: string): void {
    this.messages.push(message);
    this.onNotice(message);
  }

  list(): string[] {
    return [...this.messages];
  }
}

const compatibilityMarkdown = new MarkdownIt({
  breaks: false,
  html: true,
  linkify: false,
  typographer: false,
});

// biome-ignore lint/complexity/noStaticOnlyClass: community plugins instantiate this public API by name.
export class MarkdownRenderer {
  static async render(
    app: App,
    markdown: string,
    element: HTMLElement,
    sourcePath: string,
    component: Component,
  ): Promise<void> {
    const template = element.ownerDocument.createElement("template");
    template.innerHTML = compatibilityMarkdown.render(markdown);
    for (const unsafeElement of template.content.querySelectorAll(
      "script, iframe, object, embed, form",
    )) {
      unsafeElement.remove();
    }
    for (const candidate of template.content.querySelectorAll<HTMLElement>("*")) {
      for (const attribute of [...candidate.attributes]) {
        if (attribute.name.toLowerCase().startsWith("on")) {
          candidate.removeAttribute(attribute.name);
        }
      }
    }
    for (const anchor of template.content.querySelectorAll<HTMLAnchorElement>("a")) {
      const destination = anchor.getAttribute("href") ?? "";
      anchor.dataset.href = destination;
      anchor.setAttribute("href", "#");
    }
    for (const image of template.content.querySelectorAll<HTMLImageElement>("img")) {
      const source = image.getAttribute("src") ?? "";
      if (/^(?:https?:)?\/\//i.test(source)) {
        const label = image.alt || "External image";
        const placeholder = element.ownerDocument.createElement("span");
        placeholder.className = "external-image-placeholder";
        placeholder.textContent = label;
        placeholder.title = source;
        image.replaceWith(placeholder);
      }
    }
    element.append(template.content);
    const normalizedSourcePath = normalizePath(sourcePath);
    const sourceLines = markdown.split(/\r\n|\r|\n/u);
    const parsedFrontmatter = parseFrontmatter(markdown);
    const frontmatter =
      parsedFrontmatter && Object.keys(parsedFrontmatter).length === 0 ? null : parsedFrontmatter;
    const context: MarkdownPostProcessorContext = {
      docId: `${normalizedSourcePath || "<memory>"}:${createHash("sha256").update(markdown, "utf8").digest("hex")}`,
      sourcePath: normalizedSourcePath,
      frontmatter,
      addChild: (child) => {
        if (!(child instanceof MarkdownRenderChild)) {
          throw new Error("Markdown processor children must extend MarkdownRenderChild.");
        }
        component.addChild(child);
      },
      getSectionInfo: (sectionElement) => {
        if (sectionElement !== element && !element.contains(sectionElement)) {
          return null;
        }
        return {
          text: markdown,
          lineStart: 0,
          lineEnd: Math.max(0, sourceLines.length - 1),
        };
      },
    };
    await app.compatibility.runMarkdownPostProcessors(element, context);
  }
}

export class PluginManager {
  readonly enabledPlugins = new Set<string>();
  readonly manifests: Record<string, PluginManifest> = Object.create(null);
  readonly plugins: Record<string, Plugin> = Object.create(null);

  register(manifest: PluginManifest, plugin: Plugin): void {
    this.enabledPlugins.add(manifest.id);
    this.manifests[manifest.id] = manifest;
    this.plugins[manifest.id] = plugin;
  }

  unregister(pluginId: string): void {
    this.enabledPlugins.delete(pluginId);
    delete this.manifests[pluginId];
    delete this.plugins[pluginId];
  }

  getPlugin(pluginId: string): Plugin | null {
    return this.plugins[pluginId] ?? null;
  }

  ownerIdForReference(holder: object): string | null {
    for (const [pluginId, plugin] of Object.entries(this.plugins)) {
      if (holder === plugin) {
        return pluginId;
      }
      for (const key of Reflect.ownKeys(holder)) {
        const descriptor = Object.getOwnPropertyDescriptor(holder, key);
        if (descriptor && "value" in descriptor && descriptor.value === plugin) {
          return pluginId;
        }
      }
    }
    return null;
  }
}

function createCanvasNode(file: TFile) {
  const containerEl = requireCompatibilityDocument().createElement("div");
  containerEl.className = "canvas-node";
  const child = {
    file,
    showPreview: () => undefined,
  };
  return {
    child,
    containerEl,
    detach: () => containerEl.remove(),
    file,
    isEditable: () => true,
    isEditing: false,
    render: () => undefined,
    setFilePath: () => undefined,
    startEditing: () => undefined,
  };
}

function createInternalPlugins() {
  const nodes = new Set<ReturnType<typeof createCanvasNode>>();
  const canvas = {
    createFileNode: ({ file }: { file: TFile }) => {
      const node = createCanvasNode(file);
      nodes.add(node);
      return node;
    },
    removeNode: (node: ReturnType<typeof createCanvasNode>) => {
      nodes.delete(node);
      node.detach();
    },
  };
  return {
    plugins: {
      canvas: {
        _loaded: true,
        load: async () => undefined,
        views: {
          canvas: () => ({ canvas }),
        },
      },
    },
  };
}

export class App {
  readonly vault: Vault;
  readonly fileManager: FileManager;
  readonly metadataCache: MetadataCache;
  readonly commands: CommandRegistry;
  readonly notices: NoticeBus;
  readonly workspace = new Workspace();
  readonly compatibility = new CompatibilityIntegrationRegistry();
  readonly internalPlugins = createInternalPlugins();
  readonly keymap = new Keymap();
  readonly plugins = new PluginManager();
  private readonly pluginModals = new Map<string, Set<{ close(): void }>>();

  constructor(vault: Vault, commands: CommandRegistry, notices: NoticeBus) {
    this.vault = vault;
    this.fileManager = new FileManager(vault);
    this.metadataCache = new MetadataCache(vault);
    this.commands = commands;
    this.notices = notices;
    this.vault.on("create", (file) => {
      if (file instanceof TFile) {
        this.metadataCache.trigger("changed", file, "", this.metadataCache.getFileCache(file));
      }
    });
    this.vault.on("modify", (file) => {
      if (file instanceof TFile) {
        this.metadataCache.trigger("changed", file, "", this.metadataCache.getFileCache(file));
      }
    });
  }

  async loadPluginData(pluginId: string): Promise<unknown | null> {
    const dataPath = this.pluginDataPath(pluginId);
    try {
      return JSON.parse(await fs.readFile(dataPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async savePluginData(pluginId: string, data: unknown): Promise<void> {
    const dataPath = this.pluginDataPath(pluginId);
    const serialized = JSON.stringify(data, null, 2);
    if (serialized === undefined) {
      throw new Error(`Plugin ${pluginId} data is not JSON serializable.`);
    }
    await atomicWriteFile(dataPath, Buffer.from(`${serialized}\n`, "utf8"));
  }

  private pluginDataPath(pluginId: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId)) {
      throw new Error(`Invalid plugin identifier: ${pluginId}`);
    }
    return this.vault.resolveVaultPath(
      path.posix.join(this.vault.configDir, "plugins", pluginId, "data.json"),
    );
  }

  createFile(filePath: string): TFile {
    return this.vault.getFileByPath(filePath) ?? new TFile(filePath, this.vault);
  }

  registerPluginModal(modal: { close(): void }): () => void {
    const pluginId = this.plugins.ownerIdForReference(modal);
    if (!pluginId) {
      return () => {};
    }
    const modals = this.pluginModals.get(pluginId) ?? new Set<{ close(): void }>();
    modals.add(modal);
    this.pluginModals.set(pluginId, modals);
    return () => {
      modals.delete(modal);
      if (modals.size === 0 && this.pluginModals.get(pluginId) === modals) {
        this.pluginModals.delete(pluginId);
      }
    };
  }

  closePluginModals(pluginId: string): unknown | null {
    const modals = [...(this.pluginModals.get(pluginId) ?? [])];
    this.pluginModals.delete(pluginId);
    let failure: unknown = null;
    for (const modal of modals.reverse()) {
      try {
        modal.close();
      } catch (error) {
        failure ??= error;
      }
    }
    return failure;
  }

  getAccentColor(): string {
    if (typeof document === "undefined") {
      return "#0072b2";
    }
    const probe = document.createElement("span");
    probe.style.color = "var(--interactive-accent, #0072b2)";
    document.body.append(probe);
    const color = document.defaultView?.getComputedStyle(probe).color.trim();
    probe.remove();
    return color || "#0072b2";
  }
}

export class Plugin extends Component {
  readonly app: App;
  readonly manifest: PluginManifest;

  constructor(app: App, manifest: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }

  async onload(): Promise<void> {}

  async onunload(): Promise<void> {}

  addCommand(command: Command): Command {
    this.register(this.app.commands.register(this.manifest.id, command));
    return command;
  }

  addRibbonIcon(
    icon: string,
    title: string,
    callback: (event: MouseEvent) => unknown,
  ): HTMLElement {
    const doc = requireCompatibilityDocument();
    const element = doc.createElement("button");
    element.type = "button";
    element.className = "side-dock-ribbon-action clickable-icon";
    element.dataset.icon = icon;
    const iconElement = createCompatibleIcon(doc, icon, this.app.compatibility.getIcon(icon));
    if (iconElement) {
      element.append(iconElement);
    }
    element.title = title;
    element.setAttribute("aria-label", title);
    element.addEventListener("click", callback);
    this.register(() => element.removeEventListener("click", callback));
    this.register(this.app.compatibility.addRibbonItem(element));
    return element;
  }

  addStatusBarItem(): HTMLElement {
    const element = requireCompatibilityDocument().createElement("div");
    element.className = "status-bar-item plugin-editor-status";
    this.register(this.app.compatibility.addStatusBarItem(element));
    return element;
  }

  addSettingTab(settingTab: PluginSettingTab): void {
    this.register(this.app.compatibility.addSettingTab(this.manifest.id, settingTab));
  }

  registerView(type: string, creator: (leaf: WorkspaceLeaf) => View): void {
    this.register(
      this.app.compatibility.registerView(
        this.manifest.id,
        type,
        creator as (leaf: unknown) => unknown,
      ),
    );
  }

  registerExtensions(extensions: string[], viewType: string): void {
    this.register(
      this.app.compatibility.registerExtensions(this.manifest.id, extensions, viewType),
    );
  }

  registerMarkdownPostProcessor(
    postProcessor: MarkdownPostProcessor,
    sortOrder?: number,
  ): MarkdownPostProcessor {
    this.register(
      this.app.compatibility.registerMarkdownPostProcessor(
        this.manifest.id,
        postProcessor,
        sortOrder,
      ),
    );
    return postProcessor;
  }

  registerMarkdownCodeBlockProcessor(
    language: string,
    processor: MarkdownCodeBlockProcessor,
    sortOrder?: number,
  ): MarkdownPostProcessor {
    const registered = ((_element: HTMLElement, _context: MarkdownPostProcessorContext) => {
      throw new Error(
        `Markdown code block processor for ${language.trim()} can only run on a fenced block.`,
      );
    }) as MarkdownPostProcessor;
    if (sortOrder !== undefined) {
      registered.sortOrder = sortOrder;
    }
    this.register(
      this.app.compatibility.registerMarkdownCodeBlockProcessor(
        this.manifest.id,
        language,
        processor,
        sortOrder,
        registered,
      ),
    );
    return registered;
  }

  registerEditorExtension(extension: unknown): void {
    this.register(this.app.compatibility.registerEditorExtension(extension));
  }

  registerEditorSuggest(editorSuggest: EditorSuggest<unknown>): void {
    this.register(this.app.compatibility.registerEditorSuggest(editorSuggest));
  }

  async loadData(): Promise<unknown | null> {
    return this.app.loadPluginData(this.manifest.id);
  }

  async saveData(data: unknown): Promise<void> {
    await this.app.savePluginData(this.manifest.id, data);
  }

  async __load(): Promise<void> {
    if (this._loaded) {
      return;
    }
    this._loaded = true;
    try {
      await this.onload();
    } catch (error) {
      this._loaded = false;
      this.releaseComponentResources();
      throw error;
    }
  }

  async __unload(): Promise<void> {
    let failure: { error: unknown } | null = null;
    try {
      await this.onunload();
    } catch (error) {
      failure = { error };
    }
    const releaseFailure = this.releaseComponentResources();
    if (releaseFailure) {
      failure ??= { error: releaseFailure };
    }
    this._loaded = false;
    if (failure) {
      throw failure.error;
    }
  }
}

export interface ObsidianCompatibilityModule {
  AbstractInputSuggest: typeof AbstractInputSuggest;
  AbstractTextComponent: typeof AbstractTextComponent;
  App: typeof App;
  arrayBufferToBase64: typeof arrayBufferToBase64;
  arrayBufferToHex: typeof arrayBufferToHex;
  BaseComponent: typeof BaseComponent;
  base64ToArrayBuffer: typeof base64ToArrayBuffer;
  ButtonComponent: typeof ButtonComponent;
  ColorComponent: typeof ColorComponent;
  Component: typeof Component;
  DropdownComponent: typeof DropdownComponent;
  Editor: typeof Editor;
  EditorSuggest: typeof EditorSuggest;
  ExtraButtonComponent: typeof ExtraButtonComponent;
  FileManager: typeof FileManager;
  FileSystemAdapter: typeof FileSystemAdapter;
  FileView: typeof FileView;
  FuzzySuggestModal: typeof FuzzySuggestModal;
  getAllTags: typeof getAllTags;
  getLanguage: typeof getLanguage;
  getLinkpath: typeof getLinkpath;
  htmlToMarkdown: typeof htmlToMarkdown;
  ItemView: typeof ItemView;
  Keymap: typeof Keymap;
  MarkdownView: typeof MarkdownView;
  MarkdownRenderer: typeof MarkdownRenderer;
  MarkdownRenderChild: typeof MarkdownRenderChild;
  MetadataCache: typeof MetadataCache;
  Menu: typeof Menu;
  MenuItem: typeof MenuItem;
  MenuSeparator: typeof MenuSeparator;
  moment: typeof moment;
  Modal: typeof Modal;
  MomentFormatComponent: typeof MomentFormatComponent;
  Notice: new (message: string, timeout?: number) => object;
  Plugin: typeof Plugin;
  PluginSettingTab: typeof PluginSettingTab;
  PopoverSuggest: typeof PopoverSuggest;
  ProgressBarComponent: typeof ProgressBarComponent;
  Scope: typeof Scope;
  SearchComponent: typeof SearchComponent;
  Setting: typeof Setting;
  SettingTab: typeof SettingTab;
  SliderComponent: typeof SliderComponent;
  SuggestModal: typeof SuggestModal;
  TFile: typeof TFile;
  TAbstractFile: typeof TAbstractFile;
  TFolder: typeof TFolder;
  TextFileView: typeof TextFileView;
  TextAreaComponent: typeof TextAreaComponent;
  TextComponent: typeof TextComponent;
  ToggleComponent: typeof ToggleComponent;
  ValueComponent: typeof ValueComponent;
  View: typeof View;
  Vault: typeof Vault;
  Workspace: typeof Workspace;
  WorkspaceLeaf: typeof WorkspaceLeaf;
  WorkspaceSplit: typeof WorkspaceSplit;
  addIcon(id: string, svgContent: string): void;
  debounce: typeof debounce;
  getIcon(id: string): SVGSVGElement | null;
  normalizePath(filePath: string): string;
  parseFrontMatterEntry: typeof parseFrontMatterEntry;
  parseFrontMatterTags: typeof parseFrontMatterTags;
  parseLinktext: typeof parseLinktext;
  Platform: typeof Platform;
  prepareFuzzySearch: typeof prepareFuzzySearch;
  prepareSimpleSearch: typeof prepareSimpleSearch;
  requireApiVersion(version: string): boolean;
  sanitizeHTMLToDom(html: string): DocumentFragment;
  setIcon(parent: HTMLElement, iconId: string): void;
  setTooltip: typeof setTooltip;
  sleep(milliseconds: number): Promise<void>;
  stringifyYaml: typeof stringifyYaml;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("base64");
}

export function arrayBufferToHex(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString("hex");
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bytes = Buffer.from(base64, "base64");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const htmlMarkdownConverter = new TurndownService({
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  headingStyle: "atx",
  strongDelimiter: "**",
});

export function htmlToMarkdown(html: string | HTMLElement | Document | DocumentFragment): string {
  return htmlMarkdownConverter.turndown(html);
}

export interface Debouncer<T extends unknown[], V> {
  (...args: T): Debouncer<T, V>;
  cancel(): Debouncer<T, V>;
  run(): V | undefined;
}

export function debounce<T extends unknown[], V>(
  callback: (...args: T) => V,
  timeout = 0,
  resetTimer = false,
): Debouncer<T, V> {
  let args: T | null = null;
  let context: unknown;
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const invoke = (): V | undefined => {
    if (!args) {
      return undefined;
    }
    const pendingArgs = args;
    const pendingContext = context;
    args = null;
    context = undefined;
    timer = null;
    return callback.apply(pendingContext, pendingArgs);
  };
  const debounced = function (this: unknown, ...nextArgs: T): Debouncer<T, V> {
    args = nextArgs;
    context = this;
    if (timer && !resetTimer) {
      return debounced;
    }
    if (timer) {
      globalThis.clearTimeout(timer);
    }
    timer = globalThis.setTimeout(invoke, Math.max(0, timeout));
    return debounced;
  } as Debouncer<T, V>;
  debounced.cancel = (): Debouncer<T, V> => {
    if (timer) {
      globalThis.clearTimeout(timer);
    }
    timer = null;
    args = null;
    context = undefined;
    return debounced;
  };
  debounced.run = (): V | undefined => {
    if (timer) {
      globalThis.clearTimeout(timer);
    }
    return invoke();
  };
  return debounced;
}

const currentPlatform = process.platform;

export const Platform = Object.freeze({
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: currentPlatform === "darwin",
  isWin: currentPlatform === "win32",
  isLinux: currentPlatform === "linux",
  isSafari: false,
  resourcePathPrefix: "file:///",
});

export interface TooltipOptions {
  placement?: "bottom" | "right" | "left" | "top";
  classes?: string[];
  gap?: number;
  delay?: number;
}

export function setTooltip(
  element: HTMLElement,
  tooltip: string,
  options: TooltipOptions = {},
): void {
  element.title = tooltip;
  element.dataset.tooltipPosition = options.placement ?? "top";
  if (options.classes?.length) {
    element.dataset.tooltipClasses = options.classes.join(" ");
  } else {
    delete element.dataset.tooltipClasses;
  }
  if (options.gap !== undefined) {
    element.dataset.tooltipGap = String(options.gap);
  } else {
    delete element.dataset.tooltipGap;
  }
  if (options.delay !== undefined) {
    element.dataset.tooltipDelay = String(options.delay);
  } else {
    delete element.dataset.tooltipDelay;
  }
  if (!element.getAttribute("aria-label") && !element.textContent?.trim()) {
    element.setAttribute("aria-label", tooltip);
  }
}

interface FuzzyCharacter {
  end: number;
  folded: string;
  start: number;
  value: string;
}

function fuzzyCharacters(value: string): FuzzyCharacter[] {
  const characters: FuzzyCharacter[] = [];
  let offset = 0;
  for (const character of value) {
    const end = offset + character.length;
    characters.push({
      start: offset,
      end,
      folded: character.toLocaleLowerCase("en-US"),
      value: character,
    });
    offset = end;
  }
  return characters;
}

function isFuzzyWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}]/u.test(character);
}

function fuzzyScore(
  query: readonly FuzzyCharacter[],
  target: readonly FuzzyCharacter[],
  matchedIndexes: readonly number[],
): number {
  let score = query.length * 100 - target.length;
  for (let index = 0; index < matchedIndexes.length; index += 1) {
    const targetIndex = matchedIndexes[index];
    if (targetIndex === undefined) {
      continue;
    }
    const targetCharacter = target[targetIndex];
    const queryCharacter = query[index];
    if (!targetCharacter || !queryCharacter) {
      continue;
    }
    const previousTarget = target[targetIndex - 1];
    const atBoundary =
      targetIndex === 0 ||
      !isFuzzyWordCharacter(previousTarget?.value) ||
      (previousTarget?.value === previousTarget?.value.toLocaleLowerCase("en-US") &&
        targetCharacter.value !== targetCharacter.value.toLocaleLowerCase("en-US"));
    if (atBoundary) {
      score += 35;
    }
    if (targetCharacter.value === queryCharacter.value) {
      score += 5;
    }
    const previousMatchIndex = matchedIndexes[index - 1];
    if (previousMatchIndex === undefined) {
      score -= targetCharacter.start * 2;
      continue;
    }
    const previousMatch = target[previousMatchIndex];
    if (!previousMatch) {
      continue;
    }
    const gap = targetCharacter.start - previousMatch.end;
    score += gap === 0 ? 60 : -Math.min(gap, 30) * 2;
  }
  if (query.length === target.length) {
    score += 1_000;
  }
  return score;
}

function fuzzyRanges(
  target: readonly FuzzyCharacter[],
  matchedIndexes: readonly number[],
): SearchMatchPart[] {
  const ranges: SearchMatchPart[] = [];
  for (const matchedIndex of matchedIndexes) {
    const character = target[matchedIndex];
    if (!character) {
      continue;
    }
    const previous = ranges.at(-1);
    if (previous && previous[1] === character.start) {
      previous[1] = character.end;
    } else {
      ranges.push([character.start, character.end]);
    }
  }
  return ranges;
}

export function prepareSimpleSearch(query: string): (text: string) => SearchResult | null {
  const words = query.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return () => ({ score: 0, matches: [] });
  }
  const foldedWords = words.map((word) => word.toLocaleLowerCase("en-US"));

  return (text: string): SearchResult | null => {
    const foldedText = text.toLocaleLowerCase("en-US");
    const matches: SearchMatchPart[] = [];
    let positionCost = 0;
    for (const word of foldedWords) {
      const start = foldedText.indexOf(word);
      if (start === -1) {
        return null;
      }
      matches.push([start, start + word.length]);
      positionCost += start;
    }
    matches.sort(([left], [right]) => left - right);
    const merged: SearchMatchPart[] = [];
    for (const match of matches) {
      const previous = merged.at(-1);
      if (previous && match[0] <= previous[1]) {
        previous[1] = Math.max(previous[1], match[1]);
      } else {
        merged.push([...match]);
      }
    }
    return {
      score: -positionCost / Math.max(text.length, 1),
      matches: merged,
    };
  };
}

export function prepareFuzzySearch(query: string): (text: string) => SearchResult | null {
  const queryCharacters = fuzzyCharacters(query.trim());
  if (queryCharacters.length === 0) {
    return () => ({ score: 0, matches: [] });
  }

  return (text: string): SearchResult | null => {
    const targetCharacters = fuzzyCharacters(text);
    let best: SearchResult | null = null;
    const firstQueryCharacter = queryCharacters[0];
    if (!firstQueryCharacter) {
      return { score: 0, matches: [] };
    }
    for (let startIndex = 0; startIndex < targetCharacters.length; startIndex += 1) {
      if (targetCharacters[startIndex]?.folded !== firstQueryCharacter.folded) {
        continue;
      }
      const matchedIndexes = [startIndex];
      let targetIndex = startIndex + 1;
      for (let queryIndex = 1; queryIndex < queryCharacters.length; queryIndex += 1) {
        const queryCharacter = queryCharacters[queryIndex];
        while (
          targetIndex < targetCharacters.length &&
          targetCharacters[targetIndex]?.folded !== queryCharacter?.folded
        ) {
          targetIndex += 1;
        }
        if (targetIndex >= targetCharacters.length) {
          break;
        }
        matchedIndexes.push(targetIndex);
        targetIndex += 1;
      }
      if (matchedIndexes.length !== queryCharacters.length) {
        continue;
      }
      const candidate = {
        score: fuzzyScore(queryCharacters, targetCharacters, matchedIndexes),
        matches: fuzzyRanges(targetCharacters, matchedIndexes),
      };
      if (!best || candidate.score > best.score) {
        best = candidate;
      }
    }
    return best;
  };
}

export function getLanguage(): string {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.trim();
  return locale || "en";
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(0, milliseconds)));
}

export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const template = requireCompatibilityDocument().createElement("template");
  template.innerHTML = html;
  for (const unsafeElement of template.content.querySelectorAll(
    "script, iframe, object, embed, form, meta, base",
  )) {
    unsafeElement.remove();
  }
  for (const candidate of template.content.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of [...candidate.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        candidate.removeAttribute(attribute.name);
        continue;
      }
      if (
        ["href", "src", "xlink:href", "formaction"].includes(name) &&
        /^\s*(?:javascript|vbscript|data\s*:\s*text\/html)/i.test(attribute.value)
      ) {
        candidate.removeAttribute(attribute.name);
      }
    }
  }
  return template.content;
}

function requireCompatibilityDocument(): Document {
  if (typeof document === "undefined") {
    throw new Error("Obsidian UI compatibility requires a renderer document.");
  }
  return document;
}

export function normalizePath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replaceAll("\\", "/")).normalize("NFC");
  if (normalized === ".") {
    return "";
  }
  return normalized.replace(/^\.\//, "").replace(/^\/+/, "");
}

export function createObsidianCompatibilityModule(app: App): ObsidianCompatibilityModule {
  class Notice {
    readonly message: string;
    readonly timeout: number | undefined;

    constructor(message: string, timeout?: number) {
      this.message = message;
      this.timeout = timeout;
      app.notices.show(message);
    }
  }

  const addIcon = (id: string, svgContent: string): void => {
    app.compatibility.addIcon(id, svgContent);
  };
  const getIcon = (id: string): SVGSVGElement | null => {
    return createCompatibleIcon(requireCompatibilityDocument(), id, app.compatibility.getIcon(id));
  };
  const setIcon = (parent: HTMLElement, iconId: string): void => {
    parent.replaceChildren();
    const icon = getIcon(iconId);
    if (icon) {
      parent.append(icon);
    } else {
      parent.dataset.icon = iconId;
    }
  };
  class BoundMenu extends Menu {
    constructor() {
      super((iconId) => app.compatibility.getIcon(iconId));
    }
  }

  return {
    AbstractInputSuggest,
    AbstractTextComponent,
    App,
    arrayBufferToBase64,
    arrayBufferToHex,
    BaseComponent,
    base64ToArrayBuffer,
    ButtonComponent,
    ColorComponent,
    Component,
    debounce,
    DropdownComponent,
    Editor,
    EditorSuggest,
    ExtraButtonComponent,
    FileManager,
    FileSystemAdapter,
    FileView,
    FuzzySuggestModal,
    getAllTags,
    getLinkpath,
    ItemView,
    Keymap,
    MarkdownView,
    MarkdownRenderer,
    MarkdownRenderChild,
    MetadataCache,
    Menu: BoundMenu,
    MenuItem,
    MenuSeparator,
    moment,
    Modal,
    MomentFormatComponent,
    Notice,
    Plugin,
    PluginSettingTab,
    PopoverSuggest,
    ProgressBarComponent,
    Scope,
    SearchComponent,
    Setting,
    SettingTab,
    SliderComponent,
    SuggestModal,
    TFile,
    TAbstractFile,
    TFolder,
    TextFileView,
    TextAreaComponent,
    TextComponent,
    ToggleComponent,
    ValueComponent,
    Vault,
    View,
    Workspace,
    WorkspaceLeaf,
    WorkspaceSplit,
    addIcon,
    getIcon,
    getLanguage,
    htmlToMarkdown,
    normalizePath,
    parseFrontMatterEntry,
    parseFrontMatterTags,
    parseLinktext,
    Platform,
    prepareFuzzySearch,
    prepareSimpleSearch,
    requireApiVersion: () => true,
    sanitizeHTMLToDom,
    setIcon,
    setTooltip,
    sleep,
    stringifyYaml,
  };
}
