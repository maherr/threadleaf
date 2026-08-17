import { createHash } from "node:crypto";
import {
  type Dirent,
  promises as fs,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import MarkdownIt from "markdown-it";
import momentLibrary from "moment";
import TurndownService from "turndown";
import { parse as parseYamlDocument, stringify as yamlStringify } from "yaml";
import { ActionRegistry } from "../application/action-registry";
import { atomicWriteFile, revisionOf } from "../kernel/durability";
import { maskMarkdownCodeAndComments, parseMarkdownLinks } from "../kernel/markdown-links";
import { isPathInside } from "../kernel/path-policy";
import type {
  VaultDirectoryCreateResult,
  VaultReadPort,
  VaultRenameResult,
  VaultWriteResult,
} from "../kernel/ports";
import { createSafeMathElement } from "../renderer/markdown-extensions";
import type { CommandSummary, NoteCreateOutcome } from "../shared/contracts";
import type { PluginMutationWaitOptions } from "../shared/plugin-runtime-protocol";
import {
  BasesEntry,
  BasesEntryGroup,
  BasesQueryResult,
  BasesView,
  BasesViewConfig,
  QueryController,
} from "./obsidian-bases-compat";
import { Component } from "./obsidian-components";
import {
  type EditorCompatibilityFields,
  rendererEditorCompatibilityFields,
} from "./obsidian-editor-compat";
import { Events, VaultEventRef } from "./obsidian-events";
import { createCompatibleIcon } from "./obsidian-icons";
import { Menu, MenuItem, MenuSeparator } from "./obsidian-menu-compat";
import { request, requestUrl } from "./obsidian-network-compat";
import {
  AbstractInputSuggest,
  AbstractTextComponent,
  BaseComponent,
  UiKeymap as BaseKeymap,
  ButtonComponent,
  ColorComponent,
  ConfirmationButton,
  ConfirmationModal,
  DisplayValueComponent,
  DropdownComponent,
  EditableFileView,
  Editor,
  EditorSuggest,
  ExtraButtonComponent,
  FileView,
  FuzzySuggestModal,
  HoverPopover,
  ItemView,
  MarkdownEditView,
  MarkdownView,
  Modal,
  type Modifier,
  MomentFormatComponent,
  PluginSettingTab,
  PopoverState,
  PopoverSuggest,
  ProgressBarComponent,
  Scope,
  SearchComponent,
  SecretComponent,
  Setting,
  SettingGroup,
  SettingPage,
  SettingTab,
  SliderComponent,
  SuggestModal,
  setMarkdownPreviewViewConstructor,
  TextAreaComponent,
  TextComponent,
  TextFileView,
  ToggleComponent,
  ValueComponent,
  View,
  WorkspaceLeaf,
} from "./obsidian-ui-compat";
import {
  BooleanValue,
  DateValue,
  DurationValue,
  FileValue,
  HTMLValue,
  IconValue,
  ImageValue,
  LinkValue,
  ListValue,
  NotNullValue,
  NullValue,
  NumberValue,
  ObjectValue,
  PrimitiveValue,
  RegExpValue,
  RelativeDateValue,
  StringValue,
  TagValue,
  UrlValue,
  Value,
} from "./obsidian-values";
import {
  type CompatibilityBasesViewRegistration,
  type CompatibilityCliFlags,
  type CompatibilityCliHandler,
  type CompatibilityHoverLinkSource,
  CompatibilityIntegrationRegistry,
  type CompatibilityObsidianProtocolHandler,
  Workspace,
  WorkspaceContainer,
  WorkspaceFloating,
  WorkspaceItem,
  WorkspaceMobileDrawer,
  WorkspaceParent,
  WorkspaceRibbon,
  WorkspaceRoot,
  WorkspaceSidedock,
  WorkspaceSplit,
  WorkspaceTabs,
  WorkspaceWindow,
} from "./obsidian-workspace-compat";

export const moment = momentLibrary;

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
  checkCallback?: (checking: boolean) => boolean | undefined;
  editorCallback?: (editor: Editor, view: MarkdownView) => unknown | Promise<unknown>;
  editorCheckCallback?: (
    checking: boolean,
    editor: Editor,
    view: MarkdownView,
  ) => boolean | undefined;
  hotkeys?: Hotkey[];
  mobileOnly?: boolean;
  repeatable?: boolean;
}

export interface Hotkey {
  modifiers: Modifier[];
  key: string;
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

interface RegisteredCommandMetadata {
  ownerId: string;
  releaseAction: () => void;
  releaseHostAction: () => void;
  displayName: string;
}

type VaultEventCallback = (...args: unknown[]) => unknown;

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

export interface DataWriteOptions {
  ctime?: number;
  mtime?: number;
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

  constructor(vault: Vault, reader = false) {
    this.vault = vault;
    this.basePath = vault.rootPath;
    this.canonicalRootPath = reader ? vault.rootPath : realpathSync(vault.rootPath);
  }

  getName(): string {
    return this.vault.getName();
  }

  getBasePath(): string {
    return this.basePath;
  }

  getFullPath(normalizedPath: string): string {
    const lexicalPath = this.vault.resolveVaultPath(normalizePath(normalizedPath));
    this.assertExistingAncestorContained(normalizedPath, lexicalPath);
    return lexicalPath;
  }

  async write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    if (options?.ctime !== undefined || options?.mtime !== undefined) {
      throw new Error(
        "Plugin adapter timestamp options are not available through the revision-aware vault writer.",
      );
    }
    const normalized = normalizePath(normalizedPath);
    this.getFullPath(normalized);
    const existing = this.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFolder) {
      throw new Error(`Plugin adapter write requires a file path: ${normalized}`);
    }
    if (existing instanceof TFile) {
      await this.vault.modify(existing, data);
      return;
    }
    await this.vault.create(normalized, data);
  }

  async writeBinary(
    normalizedPath: string,
    data: ArrayBuffer,
    options?: DataWriteOptions,
  ): Promise<void> {
    if (options?.ctime !== undefined || options?.mtime !== undefined) {
      throw new Error(
        "Plugin adapter timestamp options are not available through the revision-aware vault writer.",
      );
    }
    const normalized = normalizePath(normalizedPath);
    this.getFullPath(normalized);
    const existing = this.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFolder) {
      throw new Error(`Plugin adapter write requires a file path: ${normalized}`);
    }
    if (existing instanceof TFile) {
      await this.vault.modifyBinary(existing, data);
      return;
    }
    await this.vault.createBinary(normalized, data);
  }

  async append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    if (options?.ctime !== undefined || options?.mtime !== undefined) {
      throw new Error(
        "Plugin adapter timestamp options are not available through the revision-aware vault writer.",
      );
    }
    const normalized = normalizePath(normalizedPath);
    this.getFullPath(normalized);
    const file = this.vault.getFileByPath(normalized);
    if (!file) {
      throw new Error(`Plugin adapter append requires an existing file: ${normalized}`);
    }
    await this.vault.append(file, data);
  }

  async appendBinary(
    normalizedPath: string,
    data: ArrayBuffer,
    options?: DataWriteOptions,
  ): Promise<void> {
    if (options?.ctime !== undefined || options?.mtime !== undefined) {
      throw new Error(
        "Plugin adapter timestamp options are not available through the revision-aware vault writer.",
      );
    }
    const normalized = normalizePath(normalizedPath);
    this.getFullPath(normalized);
    const file = this.vault.getFileByPath(normalized);
    if (!file) {
      throw new Error(`Plugin adapter append requires an existing file: ${normalized}`);
    }
    await this.vault.appendBinary(file, data);
  }

  async process(
    normalizedPath: string,
    callback: (data: string) => string,
    options?: DataWriteOptions,
  ): Promise<string> {
    if (options?.ctime !== undefined || options?.mtime !== undefined) {
      throw new Error(
        "Plugin adapter timestamp options are not available through the revision-aware vault writer.",
      );
    }
    const normalized = normalizePath(normalizedPath);
    this.getFullPath(normalized);
    const file = this.vault.getFileByPath(normalized);
    if (!file) {
      throw new Error(`Plugin adapter process requires an existing file: ${normalized}`);
    }
    const current = await this.vault.read(file);
    const next = callback(current);
    await this.vault.modify(file, next);
    return next;
  }

  async rename(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    const source = normalizePath(normalizedPath);
    const target = normalizePath(normalizedNewPath);
    this.getFullPath(source);
    this.getFullPath(target);
    const file = this.vault.getFileByPath(source);
    if (!file) {
      throw new Error(`Plugin adapter rename requires an existing file: ${source}`);
    }
    await this.vault.rename(file, target);
  }

  async trashLocal(normalizedPath: string): Promise<void> {
    const normalized = normalizePath(normalizedPath);
    this.getFullPath(normalized);
    const file = this.vault.getFileByPath(normalized);
    if (!file) {
      throw new Error(`Plugin adapter local trash requires an existing file: ${normalized}`);
    }
    await this.vault.trash(file);
  }

  async mkdir(normalizedPath: string): Promise<void> {
    const normalized = normalizePath(normalizedPath);
    this.getFullPath(normalized);
    await this.vault.createFolder(normalized);
  }

  async copy(source: string, target: string): Promise<void> {
    const sourcePath = normalizePath(source);
    const targetPath = normalizePath(target);
    this.getFullPath(sourcePath);
    this.getFullPath(targetPath);
    const sourceStat = await this.stat(sourcePath);
    if (!sourceStat) {
      throw new Error(`Plugin adapter copy source does not exist: ${sourcePath}`);
    }
    if (sourceStat.type !== "file") {
      throw new Error(`Plugin adapter copy requires a file source: ${sourcePath}`);
    }
    if (await this.exists(targetPath)) {
      throw new Error(`Plugin adapter copy refused to overwrite ${targetPath}.`);
    }
    const content = await this.readBinary(sourcePath);
    await this.vault.createBinary(targetPath, content);
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

  private assertExistingAncestorContained(normalizedPath: string, lexicalPath: string): void {
    let existingPath = lexicalPath;
    while (true) {
      try {
        lstatSync(existingPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        const parentPath = path.dirname(existingPath);
        if (parentPath === existingPath) {
          throw error;
        }
        existingPath = parentPath;
      }
    }
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync(existingPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Path cannot be resolved inside the vault: ${normalizedPath}`);
      }
      throw error;
    }
    if (!isPathInside(this.canonicalRootPath, canonicalPath)) {
      throw new Error(`Path resolves outside the vault: ${normalizedPath}`);
    }
  }
}

export class Vault extends Events {
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
  private readerFiles: TFile[] | null = null;
  private readerInitialization: Promise<void> | null = null;

  constructor(rootPath: string, reader?: VaultReadPort, writer?: CompatibilityVaultWritePort) {
    super();
    this.rootPath = reader ? path.resolve(rootPath) : realpathSync(path.resolve(rootPath));
    this.#reader = reader;
    this.#writer = writer;
    this.adapter = new FileSystemAdapter(this, reader !== undefined);
  }

  getName(): string {
    return path.basename(this.rootPath);
  }

  async initialize(): Promise<void> {
    if (!this.#reader || this.readerFiles) {
      return;
    }
    if (this.readerInitialization) {
      return this.readerInitialization;
    }
    this.readerInitialization = (async () => {
      const paths = await this.#reader?.listMarkdownPaths();
      const now = Date.now();
      this.readerFiles = (paths ?? []).map(
        (filePath) => new TFile(filePath, this, { ctime: now, mtime: now, size: 0 }),
      );
    })();
    try {
      await this.readerInitialization;
    } finally {
      this.readerInitialization = null;
    }
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
    if (this.#reader) {
      if (!this.readerFiles) {
        throw new Error("The compatibility vault file inventory has not been initialized.");
      }
      return [...this.readerFiles];
    }
    const files: TFile[] = [];
    this.collectFiles(this.rootPath, files);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((file) => file.extension.toLowerCase() === "md");
  }

  getAllFolders(includeRoot = false): TFolder[] {
    if (this.#reader) {
      if (!this.readerFiles) {
        throw new Error("The compatibility vault file inventory has not been initialized.");
      }
      const folderPaths = new Set<string>();
      for (const file of this.readerFiles) {
        let parentPath = path.posix.dirname(file.path);
        while (parentPath !== ".") {
          folderPaths.add(parentPath);
          parentPath = path.posix.dirname(parentPath);
        }
      }
      return [
        ...(includeRoot ? [this.folderForPath("")] : []),
        ...[...folderPaths].sort().map((folderPath) => this.folderForPath(folderPath)),
      ];
    }
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

  static recurseChildren(root: TFolder, callback: (file: TAbstractFile) => unknown): void {
    for (const child of root.children) {
      callback(child);
      if (child instanceof TFolder) {
        Vault.recurseChildren(child, callback);
      }
    }
  }

  getAvailablePath(basePath: string, extension: string): string {
    const portableBase = basePath.replaceAll("\\", "/");
    if (path.posix.isAbsolute(portableBase) || path.win32.isAbsolute(basePath)) {
      throw new Error("Available-path base must be vault-relative.");
    }
    const normalizedBase = normalizePath(basePath);
    if (!normalizedBase || normalizedBase.endsWith("/")) {
      throw new Error("Available-path base must name a file.");
    }
    this.resolveVaultPath(normalizedBase);
    const normalizedExtension = extension.replace(/^\.+/u, "");
    if (/[\\/]/u.test(normalizedExtension)) {
      throw new Error("Available-path extension must be a plain extension.");
    }
    const occupied = new Set<string>();
    const collectOccupiedPaths = (absoluteDirectory: string, relativeDirectory: string): void => {
      for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
        const relativePath = normalizePath(path.posix.join(relativeDirectory, entry.name));
        occupied.add(relativePath.toLocaleLowerCase("en-US"));
        if (entry.isDirectory()) {
          collectOccupiedPaths(path.join(absoluteDirectory, entry.name), relativePath);
        }
      }
    };
    collectOccupiedPaths(this.rootPath, "");
    const suffix = normalizedExtension ? `.${normalizedExtension}` : "";
    for (let collision = 0; collision < 10_000; collision += 1) {
      const candidate = `${normalizedBase}${collision === 0 ? "" : ` ${collision}`}${suffix}`;
      if (!occupied.has(candidate.toLocaleLowerCase("en-US"))) {
        return candidate;
      }
    }
    throw new Error(`Could not find an available path for ${normalizedBase}${suffix}.`);
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
    if (this.#reader) {
      if (!this.readerFiles) {
        throw new Error("The compatibility vault file inventory has not been initialized.");
      }
      const file = this.readerFiles.find((candidate) => candidate.path === normalized);
      if (file) {
        return file;
      }
      if (
        normalized === "" ||
        this.readerFiles.some((candidate) => candidate.path.startsWith(`${normalized}/`))
      ) {
        return this.folderForPath(normalized);
      }
      return null;
    }
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
    if (this.#reader) {
      throw new Error("Plugin binary reads are not yet available through the trusted read port.");
    }
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

  async append(file: TFile, content: string, _options?: DataWriteOptions): Promise<void> {
    const current = await this.read(file);
    await this.modify(file, current + content);
  }

  async appendBinary(
    file: TFile,
    content: ArrayBuffer,
    _options?: DataWriteOptions,
  ): Promise<void> {
    const current = new Uint8Array(await this.readBinary(file));
    const appended = new Uint8Array(current.byteLength + content.byteLength);
    appended.set(current);
    appended.set(new Uint8Array(content), current.byteLength);
    await this.modifyBinary(file, appended.buffer);
  }

  async process(
    file: TFile,
    callback: (content: string) => string,
    _options?: DataWriteOptions,
  ): Promise<string> {
    const next = callback(await this.read(file));
    await this.modify(file, next);
    return next;
  }

  async copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
    if (!this.#writer) {
      throw new Error(
        "Plugin file copies are not available in the read-only compatibility runtime.",
      );
    }
    if (file.vault !== this) {
      throw new Error("Plugin copies require a file from the active compatibility vault.");
    }
    const targetPath = normalizePath(newPath);
    if (this.getAbstractFileByPath(targetPath)) {
      throw new Error(`Plugin copy refused to overwrite ${targetPath}.`);
    }

    if (file instanceof TFile) {
      return (await this.createBinary(targetPath, await this.readBinary(file))) as unknown as T;
    }
    if (!(file instanceof TFolder)) {
      throw new Error(
        "Plugin copies require a file or folder from the active compatibility vault.",
      );
    }

    const sourcePath = file.path;
    const allEntries = this.getAllLoadedFiles().filter((entry) => {
      if (entry.path === sourcePath) {
        return false;
      }
      const prefix = sourcePath ? `${sourcePath}/` : "";
      return entry.path.startsWith(prefix);
    });
    const targetFor = (entryPath: string): string => {
      const relative = sourcePath ? entryPath.slice(sourcePath.length + 1) : entryPath;
      return normalizePath(path.posix.join(targetPath, relative));
    };
    const targetEntries = allEntries.map((entry) => ({ entry, target: targetFor(entry.path) }));
    for (const { target } of targetEntries) {
      if (this.getAbstractFileByPath(target)) {
        throw new Error(`Plugin copy refused to overwrite ${target}.`);
      }
    }

    const createdRoot = await this.createFolder(targetPath);
    for (const { target } of targetEntries
      .filter(({ entry }) => entry instanceof TFolder)
      .sort((left, right) => left.target.localeCompare(right.target))) {
      const created = await this.createFolder(target);
      if (!created || !this.getFolderByPath(target)) {
        throw new Error(`Plugin folder copy did not create ${target}.`);
      }
    }
    for (const { entry, target } of targetEntries
      .filter(({ entry }) => entry instanceof TFile)
      .sort((left, right) => left.target.localeCompare(right.target))) {
      await this.createBinary(target, await this.readBinary(entry as TFile));
    }
    return createdRoot as unknown as T;
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

function readVaultAppSettings(vault: Vault): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(vault.rootPath, vault.configDir, "app.json"), "utf8"),
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class FileManager {
  readonly vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  getNewFileParent(sourcePath: string, _newFilePath?: string): TFolder {
    const settings = readVaultAppSettings(this.vault);
    const location = settings.newFileLocation;
    if (location === "folder") {
      const configuredPath = settings.newFileFolderPath;
      if (typeof configuredPath === "string") {
        const configuredFolder = this.vault.getAbstractFileByPath(configuredPath);
        if (configuredFolder instanceof TFolder) {
          return configuredFolder;
        }
      }
    } else if (location === "current" && sourcePath) {
      const sourceDirectory = path.posix.dirname(normalizePath(sourcePath));
      const currentFolder = this.vault.getAbstractFileByPath(
        sourceDirectory === "." ? "" : sourceDirectory,
      );
      if (currentFolder instanceof TFolder) {
        return currentFolder;
      }
    }
    return this.vault.getRoot();
  }

  /**
   * Obsidian changes inbound Markdown and Canvas links according to user preferences. This
   * compatibility surface refuses that potentially link-bearing case until it can do the same.
   */
  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    if (
      this.vault
        .getFiles()
        .some((candidate) => ["canvas", "md"].includes(candidate.extension.toLowerCase()))
    ) {
      throw new Error(
        "FileManager.renameFile is not yet supported for vaults containing Markdown or Canvas files: Threadleaf cannot update inbound links according to Obsidian preferences.",
      );
    }
    await this.vault.rename(file, newPath);
  }

  trashFile(file: TAbstractFile): Promise<void> {
    return this.vault.trash(file);
  }

  async promptForDeletion(file: TAbstractFile): Promise<boolean> {
    if (typeof globalThis.confirm !== "function") {
      return false;
    }
    if (!globalThis.confirm(`Delete ${file.name}?`)) {
      return false;
    }
    await this.trashFile(file);
    return true;
  }

  promptForFileDeletion(file: TAbstractFile): Promise<boolean> {
    return this.promptForDeletion(file);
  }

  async processFrontMatter(
    file: TFile,
    callback: (frontmatter: Record<string, unknown>) => void,
    _options?: DataWriteOptions,
  ): Promise<void> {
    if (file.vault !== this.vault) {
      throw new Error("Frontmatter writes require a file from the active compatibility vault.");
    }
    if (!(file instanceof TFile) || file.extension.toLocaleLowerCase("en-US") !== "md") {
      throw new Error("Frontmatter writes require a Markdown file.");
    }

    const current = await this.vault.read(file);
    const info = getFrontMatterInfo(current);
    let frontmatter: Record<string, unknown>;
    if (!info.exists) {
      frontmatter = {};
    } else {
      const parsed = parseYamlDocument(info.frontmatter, { maxAliasCount: 100 });
      if (parsed === null) {
        frontmatter = {};
      } else if (typeof parsed === "object" && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      } else {
        throw new Error("Frontmatter must contain a YAML object.");
      }
    }

    callback(frontmatter);

    const lineEnding = current.includes("\r\n") ? "\r\n" : "\n";
    const serialized = stringifyYaml(frontmatter).trimEnd();
    const yaml = serialized ? `${serialized.replaceAll("\n", lineEnding)}${lineEnding}` : "";
    const body = info.exists ? current.slice(info.contentStart) : current;
    const bom = current.startsWith("\ufeff") ? "\ufeff" : "";
    await this.vault.modify(file, `${bom}---${lineEnding}${yaml}---${lineEnding}${body}`);
  }

  generateMarkdownLink(file: TFile, sourcePath: string, subpath = "", alias = ""): string {
    if (file.vault !== this.vault) {
      throw new Error("Markdown links require a file from the active compatibility vault.");
    }
    const metadata = new MetadataCache(this.vault);
    const settings = readVaultAppSettings(this.vault);
    const useMarkdownLinks = settings.useMarkdownLinks === true;
    const target = metadata.fileToLinktext(file, sourcePath, !useMarkdownLinks);
    const destination = `${target}${subpath}`;
    if (!useMarkdownLinks) {
      return alias ? `[[${destination}|${alias}]]` : `[[${destination}]]`;
    }

    const encodedPath = target
      .split("/")
      .map((segment) =>
        segment === "." || segment === ".." ? segment : encodeURIComponent(segment),
      )
      .join("/");
    const display =
      alias || (file.extension.toLocaleLowerCase("en-US") === "md" ? file.basename : file.name);
    const escapedDisplay = display.replaceAll("\\", "\\\\").replaceAll("]", "\\]");
    return `[${escapedDisplay}](${encodedPath}${subpath})`;
  }

  async createNewMarkdownFile(parent: TFolder, name: string): Promise<TFile> {
    if (parent.vault !== this.vault) {
      throw new Error(
        "Markdown file creation requires a folder from the active compatibility vault.",
      );
    }
    const trimmedName = name.trim();
    if (
      !trimmedName ||
      trimmedName === "." ||
      trimmedName === ".." ||
      trimmedName.includes("/") ||
      trimmedName.includes("\\") ||
      trimmedName.includes("\0")
    ) {
      throw new Error("Markdown file name must be a non-empty basename.");
    }
    const markdownName = trimmedName.toLocaleLowerCase("en-US").endsWith(".md")
      ? trimmedName
      : `${trimmedName}.md`;
    const stem = markdownName.slice(0, -3);
    for (let suffix = 0; suffix < 10_000; suffix += 1) {
      const candidateName = suffix === 0 ? markdownName : `${stem} ${suffix}.md`;
      const candidatePath = normalizePath(path.posix.join(parent.path, candidateName));
      if (!this.vault.getAbstractFileByPath(candidatePath)) {
        return this.vault.create(candidatePath, "");
      }
    }
    throw new Error(`Could not find an available Markdown path for ${markdownName}.`);
  }

  async getAvailablePathForAttachment(filename: string, sourcePath: string): Promise<string> {
    const normalizedFilename = path.posix.basename(normalizePath(filename));
    if (!normalizedFilename) {
      throw new Error("Attachment filename must not be empty.");
    }
    const normalizedSource = normalizePath(sourcePath);
    const sourceDirectory = path.posix.dirname(normalizedSource);
    const folder = sourceDirectory === "." ? "" : sourceDirectory;
    const extension = path.posix.extname(normalizedFilename);
    const stem = extension ? normalizedFilename.slice(0, -extension.length) : normalizedFilename;

    for (let suffix = 0; suffix < 10_000; suffix += 1) {
      const candidateName = suffix === 0 ? normalizedFilename : `${stem} ${suffix}${extension}`;
      const candidate = normalizePath(path.posix.join(folder, candidateName));
      if (!this.vault.getAbstractFileByPath(candidate)) {
        return candidate;
      }
    }
    throw new Error(`Could not find an available attachment path for ${normalizedFilename}.`);
  }
}

export interface CachedMetadata {
  frontmatter?: Record<string, unknown>;
  links?: ReferenceCache[];
  embeds?: ReferenceCache[];
  tags?: TagCache[];
  headings?: HeadingCache[];
  footnotes?: FootnoteCache[];
  blocks?: Record<string, BlockCache>;
  listItems?: ListItemCache[];
}

export interface Reference {
  displayText?: string;
  link: string;
  original: string;
}

export interface ReferenceCache extends Reference {
  position: CachePosition;
}

// biome-ignore lint/suspicious/noConfusingVoidType: Obsidian callbacks may intentionally omit a return value.
type ReferenceIterator<T extends Reference> = (reference: T) => boolean | void;

export interface CacheLocation {
  col: number;
  line: number;
  offset: number;
}

export interface CachePosition {
  end: CacheLocation;
  start: CacheLocation;
}

export interface SearchResultContainer {
  match: SearchResult;
}

export type BasesPropertyType = "file" | "formula" | "note";

export interface BasesProperty {
  name: string;
  type: BasesPropertyType;
}

export interface TagCache {
  position: CachePosition;
  tag: string;
}

export interface HeadingCache {
  heading: string;
  level: number;
  position: CachePosition;
}

export interface BlockCache {
  id: string;
  position: CachePosition;
}

export interface FootnoteCache {
  id: string;
  position: CachePosition;
}

export interface ListItemCache {
  id?: string;
  parent: number;
  position: CachePosition;
}

export interface SubpathResult {
  start: CacheLocation;
  end: CacheLocation | null;
}

export interface HeadingSubpathResult extends SubpathResult {
  type: "heading";
  current: HeadingCache;
  next: HeadingCache | null;
}

export interface BlockSubpathResult extends SubpathResult {
  type: "block";
  block: BlockCache;
  list?: ListItemCache;
}

export interface FootnoteSubpathResult extends SubpathResult {
  type: "footnote";
  footnote: FootnoteCache;
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
    const parsed: unknown = parseYamlDocument(source, { maxAliasCount: 100 });
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

export interface FrontMatterInfo {
  exists: boolean;
  frontmatter: string;
  from: number;
  to: number;
  contentStart: number;
}

export function getFrontMatterInfo(content: string): FrontMatterInfo {
  const opening = /^\ufeff?---[\t ]*(?:\r\n|\n)/u.exec(content);
  if (!opening) {
    return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  }
  const from = opening[0].length;
  const remaining = content.slice(from);
  const closing = /^(?:---|\.\.\.)[\t ]*(?:\r\n|\n|$)/mu.exec(remaining);
  if (!closing) {
    return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
  }
  const to = from + closing.index;
  return {
    exists: true,
    frontmatter: content.slice(from, to),
    from,
    to,
    contentStart: to + closing[0].length,
  };
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

export function parseFrontMatterStringArray(
  frontmatter: unknown | null,
  key: string | RegExp,
): string[] | null {
  const entry = parseFrontMatterEntry(frontmatter, key);
  const values = Array.isArray(entry) ? entry : typeof entry === "string" ? [entry] : null;
  if (!values) {
    return null;
  }
  return values.filter((value): value is string => typeof value === "string");
}

export function parseFrontMatterAliases(frontmatter: unknown | null): string[] | null {
  const aliases = parseFrontMatterStringArray(frontmatter, "aliases");
  return aliases ?? parseFrontMatterStringArray(frontmatter, "alias");
}

function isValidTagBody(value: string): boolean {
  const segments = value.split("/");
  return (
    segments.every(
      (segment) => segment.length > 0 && /^[\p{L}\p{M}\p{N}\p{S}_-]+$/u.test(segment),
    ) && /[\p{L}\p{S}]/u.test(value)
  );
}

function normalizeFrontmatterTag(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/^#+/u, "").replace(/\/+$/u, "");
  return isValidTagBody(normalized) ? `#${normalized}` : null;
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

export function stripHeading(heading: string): string {
  return heading.replace(stripHeadingPattern, " ").replace(/\s+/gu, " ").trim();
}

export function stripHeadingForLink(heading: string): string {
  return heading
    .replace(/([:#|^\\\r\n]|%%|\[\[|\])/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const stripHeadingPattern = /[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\\r\n]/gu;

export function resolveSubpath(
  cache: CachedMetadata,
  subpath: string,
): HeadingSubpathResult | BlockSubpathResult | FootnoteSubpathResult | null {
  if (!cache || !subpath) {
    return null;
  }
  const parts = subpath.split("#").filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  if (parts.length === 1) {
    const part = parts[0] ?? "";
    if (part.startsWith("^")) {
      const id = part.slice(1).toLowerCase();
      const block = Object.entries(cache.blocks ?? {}).find(
        ([key]) => key.toLowerCase() === id,
      )?.[1];
      if (block) {
        const list = cache.listItems?.find((item) => item.id?.toLowerCase() === id);
        return {
          type: "block",
          block,
          ...(list ? { list } : {}),
          start: block.position.start,
          end: block.position.end,
        };
      }
    } else if (part.startsWith("[^")) {
      const id = part.slice(2, -1);
      const footnote = cache.footnotes?.find((candidate) => candidate.id === id);
      if (footnote) {
        return {
          type: "footnote",
          footnote,
          start: footnote.position.start,
          end: footnote.position.end,
        };
      }
    }
  }

  const headings = cache.headings;
  if (!headings?.length) {
    return null;
  }
  let partIndex = 0;
  let matched: HeadingCache | null = null;
  let next: HeadingCache | null = null;
  let matchedLevel = 0;
  for (const heading of headings) {
    if (matched && heading.level <= matchedLevel) {
      next = heading;
      break;
    }
    const requested = parts[partIndex];
    if (
      !matched &&
      requested !== undefined &&
      heading.level > matchedLevel &&
      stripHeading(heading.heading).toLowerCase() === stripHeading(requested).toLowerCase()
    ) {
      partIndex += 1;
      matchedLevel = heading.level;
      if (partIndex === parts.length) {
        matched = heading;
      }
    }
  }
  return matched
    ? {
        type: "heading",
        current: matched,
        next,
        start: matched.position.start,
        end: next?.position.start ?? null,
      }
    : null;
}

export function parsePropertyId(propertyId: string): BasesProperty {
  const separator = propertyId.indexOf(".");
  if (separator < 0) {
    return { type: propertyId as BasesPropertyType, name: "" };
  }
  return {
    type: propertyId.slice(0, separator) as BasesPropertyType,
    name: propertyId.slice(separator + 1),
  };
}

export function getLinkpath(linktext: string): string {
  return parseLinktext(linktext).path;
}

export function stringifyYaml(value: unknown): string {
  return yamlStringify(value, { aliasDuplicateObjects: false, lineWidth: 0, nullStr: "" });
}

export function parseYaml(yaml: string): unknown {
  return parseYamlDocument(yaml, { maxAliasCount: 100 });
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
  for (const match of searchable.matchAll(/(?:^|[\s(])#([\p{L}\p{M}\p{N}\p{S}_/-]+)/gu)) {
    const tag = match[1]?.replace(/\/+$/u, "");
    if (match.index === undefined || !tag || !isValidTagBody(tag)) {
      continue;
    }
    const hashOffset = match.index + match[0].lastIndexOf("#");
    const endOffset = hashOffset + tag.length + 1;
    tags.push({
      tag: `#${tag}`,
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

function isExplicitRelativeLinkpath(linkpath: string): boolean {
  const rawPath = linkpath.split("#", 1)[0]?.split("|", 1)[0]?.trim() ?? "";
  try {
    return /^(?:\.{1,2})(?:\/|$)/u.test(decodeURIComponent(rawPath));
  } catch {
    return /^(?:\.{1,2})(?:\/|$)/u.test(rawPath);
  }
}

function isExternalLinkpath(linkpath: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(linkpath) || linkpath.startsWith("//");
}

type NewLinkFormat = "shortest" | "relative" | "absolute";

export class MetadataCache extends Events {
  readonly blockCache = {
    getForFile: async (_token: unknown, _file: TFile): Promise<{ blocks: unknown[] }> => ({
      blocks: [],
    }),
  };

  private readonly cache = new Map<string, CachedMetadataRecord>();
  private readonly listeners = new Map<string, Set<VaultEventCallback>>();
  private readonly vault: Vault;

  constructor(vault: Vault) {
    super();
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
        const normalized = tag.replace(/\/+$/u, "");
        if (normalized === "#" || /^#\d+$/u.test(normalized)) {
          continue;
        }
        const parts = normalized.slice(1).split("/");
        for (let length = 1; length <= parts.length; length += 1) {
          const parent = `#${parts.slice(0, length).join("/")}`;
          if (parent !== "#" && !/^#\d+$/u.test(parent)) {
            counts.set(parent, (counts.get(parent) ?? 0) + 1);
          }
        }
      }
    }
    const consolidated = new Map<
      string,
      { count: number; firstSeen: number; representative: string; representativeCount: number }
    >();
    let firstSeen = 0;
    for (const [tag, count] of counts) {
      const key = tag.toLowerCase();
      const existing = consolidated.get(key);
      if (!existing) {
        consolidated.set(key, {
          count,
          firstSeen: firstSeen++,
          representative: tag,
          representativeCount: count,
        });
      } else {
        existing.count += count;
        if (count > existing.representativeCount) {
          existing.representative = tag;
          existing.representativeCount = count;
        }
      }
    }
    return Object.fromEntries(
      [...consolidated.values()]
        .sort(
          (left, right) =>
            left.representative.localeCompare(right.representative) ||
            left.firstSeen - right.firstSeen,
        )
        .map(({ count, representative }) => [representative, count]),
    );
  }

  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    const requested = cleanLinkpath(linkpath);
    if (!requested) {
      return this.vault.getFileByPath(sourcePath);
    }

    const sourceDirectory = path.posix.dirname(normalizePath(sourcePath));
    const directCandidate = (candidate: string): TFile | null => {
      const normalized = normalizePath(candidate);
      const candidates = [normalized];
      if (!path.posix.extname(normalized)) {
        candidates.push(`${normalized}.md`);
      }
      for (const resolvedPath of candidates) {
        const file = this.vault.getFileByPath(resolvedPath);
        if (file) {
          return file;
        }
      }
      // Host-observed: a case-variant full path still wins over any basename
      // fallback, so retry each candidate case-insensitively before giving up.
      for (const resolvedPath of candidates) {
        const folded = resolvedPath.toLocaleLowerCase("en-US");
        const insensitive = this.vault
          .getFiles()
          .find((file) => file.path.toLocaleLowerCase("en-US") === folded);
        if (insensitive) {
          return insensitive;
        }
      }
      return null;
    };

    if (!isExplicitRelativeLinkpath(linkpath)) {
      const exactPath = directCandidate(requested);
      if (exactPath) {
        return exactPath;
      }
    }
    if (sourceDirectory !== ".") {
      const sourceRelative = directCandidate(path.posix.join(sourceDirectory, requested));
      if (sourceRelative) {
        return sourceRelative;
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

  fileToLinktext(file: TFile, sourcePath: string, omitMdExtension = true): string {
    const linkFormat = this.newLinkFormat();
    const sameBasename = this.vault
      .getFiles()
      .filter(
        (candidate) =>
          candidate.basename.toLocaleLowerCase("en-US") ===
          file.basename.toLocaleLowerCase("en-US"),
      );
    const linktext =
      linkFormat === "relative"
        ? path.posix.relative(path.posix.dirname(normalizePath(sourcePath)), file.path)
        : linkFormat === "absolute" || sameBasename.length > 1
          ? file.path
          : file.name;
    return omitMdExtension && file.extension.toLocaleLowerCase("en-US") === "md"
      ? linktext.slice(0, -3)
      : linktext;
  }

  get resolvedLinks(): Record<string, Record<string, number>> {
    return this.linkMaps().resolved;
  }

  get unresolvedLinks(): Record<string, Record<string, number>> {
    return this.linkMaps().unresolved;
  }

  private newLinkFormat(): NewLinkFormat {
    try {
      const settingsPath = this.vault.resolveVaultPath(
        path.posix.join(this.vault.configDir, "app.json"),
      );
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        newLinkFormat?: unknown;
      };
      if (
        settings.newLinkFormat === "shortest" ||
        settings.newLinkFormat === "relative" ||
        settings.newLinkFormat === "absolute"
      ) {
        return settings.newLinkFormat;
      }
    } catch {
      // Obsidian uses shortest links unless the vault's optional setting says otherwise.
    }
    return "shortest";
  }

  private linkMaps(): {
    resolved: Record<string, Record<string, number>>;
    unresolved: Record<string, Record<string, number>>;
  } {
    const resolved: Record<string, Record<string, number>> = {};
    const unresolved: Record<string, Record<string, number>> = {};
    for (const source of this.vault.getMarkdownFiles()) {
      const resolvedForSource: Record<string, number> = {};
      const unresolvedForSource: Record<string, number> = {};
      resolved[source.path] = resolvedForSource;
      unresolved[source.path] = unresolvedForSource;
      let content: string;
      try {
        content = readFileSync(this.vault.resolveVaultPath(source.path), "utf8");
      } catch {
        continue;
      }
      for (const link of parseMarkdownLinks(content)) {
        if (isExternalLinkpath(link.target)) {
          continue;
        }
        const destination = this.getFirstLinkpathDest(link.target, source.path);
        if (destination) {
          resolvedForSource[destination.path] = (resolvedForSource[destination.path] ?? 0) + 1;
          continue;
        }
        const unresolvedPath = cleanLinkpath(link.target);
        if (unresolvedPath) {
          unresolvedForSource[unresolvedPath] = (unresolvedForSource[unresolvedPath] ?? 0) + 1;
        }
      }
    }
    return { resolved, unresolved };
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

interface CommandEditorContext {
  editor: Editor;
  view: MarkdownView;
}

interface CommandRegistrationOptions {
  displayName?: string;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export class CommandRegistry {
  readonly commands: Record<string, Command> = {};
  private readonly registeredCommands = new Map<string, RegisteredCommandMetadata>();
  private editorContextProvider: () => CommandEditorContext | null = () => null;
  private readonly hostActions: ActionRegistry;
  readonly actions: ActionRegistry;

  constructor(hostActions = new ActionRegistry()) {
    this.hostActions = hostActions;
    this.actions = new ActionRegistry();
  }

  register(
    ownerId: string,
    command: Command,
    options: CommandRegistrationOptions = {},
  ): () => void {
    const previous = this.registeredCommands.get(command.id);
    if (previous && previous.ownerId !== ownerId) {
      throw new Error(`Command already registered: ${command.id}`);
    }
    previous?.releaseAction();
    previous?.releaseHostAction();

    const commandId = command.id;
    const displayName = options.displayName ?? command.name;
    const releaseAction = this.actions.register(ownerId, {
      id: commandId,
      name: displayName,
      source: "plugin",
      execute: () => this.executeByKey(commandId),
    });
    const registered: RegisteredCommandMetadata = {
      ownerId,
      releaseAction,
      releaseHostAction: () => undefined,
      displayName,
    };
    this.commands[commandId] = command;
    this.registeredCommands.set(commandId, registered);
    registered.releaseHostAction = this.hostActions.register(ownerId, {
      id: commandId,
      name: displayName,
      source: "plugin",
      execute: () => this.executeByKey(commandId),
    });
    return () => {
      if (this.registeredCommands.get(commandId) === registered) {
        this.registeredCommands.delete(commandId);
        Reflect.deleteProperty(this.commands, commandId);
        releaseAction();
        registered.releaseHostAction();
      }
    };
  }

  setEditorContextProvider(provider: () => CommandEditorContext | null): void {
    this.editorContextProvider = provider;
  }

  removeCommand(commandId: string): void {
    const commandKey = this.resolveCommandKey(commandId);
    if (!commandKey) {
      return;
    }
    const registered = this.registeredCommands.get(commandKey);
    if (!registered) {
      return;
    }
    this.registeredCommands.delete(commandKey);
    Reflect.deleteProperty(this.commands, commandKey);
    registered.releaseAction();
    registered.releaseHostAction();
  }

  executeCommandById(commandId: string): boolean {
    const commandKey = this.resolveCommandKey(commandId);
    const command = commandKey ? this.commands[commandKey] : undefined;
    if (!command || command.mobileOnly) {
      return false;
    }

    const context = this.editorContextProvider();
    if (context?.editor && command.editorCheckCallback) {
      return command.editorCheckCallback(false, context.editor, context.view) === true;
    }
    if (context?.editor && command.editorCallback) {
      const result = command.editorCallback(context.editor, context.view);
      return isPromiseLike(result) || result !== false;
    }
    if (command.checkCallback) {
      return command.checkCallback(false) === true;
    }
    if (command.callback) {
      const result = command.callback();
      return isPromiseLike(result) || result !== false;
    }
    return false;
  }

  list(): CommandSummary[] {
    return [...this.registeredCommands.entries()]
      .filter(([commandId]) => this.commands[commandId] !== undefined)
      .map(([commandId, { ownerId, displayName }]) => ({
        id: commandId,
        name: displayName,
        ownerId,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async run(commandId: string): Promise<boolean> {
    const commandKey = this.resolveCommandKey(commandId);
    if (!commandKey || !(await this.canRun(commandKey))) {
      return false;
    }
    return (await this.actions.dispatch<boolean>(commandKey)) === true;
  }

  async canRun(commandId: string): Promise<boolean> {
    const commandKey = this.resolveCommandKey(commandId);
    const command = commandKey ? this.commands[commandKey] : undefined;
    if (!command || command.mobileOnly) {
      return false;
    }
    const context = this.editorContextProvider();
    if (context?.editor && command.editorCheckCallback) {
      return command.editorCheckCallback(true, context.editor, context.view) === true;
    }
    if (context?.editor && command.editorCallback) {
      return true;
    }
    if (command.checkCallback) {
      return (await command.checkCallback(true)) === true;
    }
    return command.callback !== undefined;
  }

  ownerIdFor(commandId: string): string | null {
    const commandKey = this.resolveCommandKey(commandId);
    return commandKey ? (this.registeredCommands.get(commandKey)?.ownerId ?? null) : null;
  }

  private async executeByKey(commandId: string): Promise<boolean> {
    const command = this.commands[commandId];
    if (!command || command.mobileOnly) {
      return false;
    }
    const context = this.editorContextProvider();
    if (context?.editor && command.editorCheckCallback) {
      return command.editorCheckCallback(false, context.editor, context.view) === true;
    }
    if (context?.editor && command.editorCallback) {
      return (await command.editorCallback(context.editor, context.view)) !== false;
    }
    if (command.checkCallback) {
      return command.checkCallback(false) === true;
    }
    if (command.callback) {
      return (await command.callback()) !== false;
    }
    return false;
  }

  private resolveCommandKey(commandId: string): string | null {
    return this.registeredCommands.has(commandId) ? commandId : null;
  }
}

export class Keymap extends BaseKeymap {
  private readonly scopeStack: Scope[] = [];
  private readonly ownerDocument: Document | null;

  constructor(ownerDocument = typeof document === "undefined" ? null : document) {
    super();
    this.ownerDocument = ownerDocument;
    this.ownerDocument?.addEventListener("keydown", this.handleKeyDown);
  }

  pushScope(scope: Scope): void {
    this.scopeStack.push(scope);
  }

  popScope(scope: Scope): void {
    const index = this.scopeStack.lastIndexOf(scope);
    if (index >= 0) {
      this.scopeStack.splice(index, 1);
    }
  }

  static isModifier(event: MouseEvent | TouchEvent | KeyboardEvent, modifier: Modifier): boolean {
    switch (modifier) {
      case "Mod":
        return process.platform === "darwin" ? event.metaKey : event.ctrlKey;
      case "Ctrl":
        return event.ctrlKey;
      case "Meta":
        return event.metaKey;
      case "Shift":
        return event.shiftKey;
      case "Alt":
        return event.altKey;
    }
  }

  static isModEvent(
    event?: MouseEvent | TouchEvent | KeyboardEvent | null,
  ): "tab" | "split" | "window" | boolean {
    if (!event) {
      return false;
    }
    if ("button" in event && event.button === 1) {
      return "tab";
    }
    if (!Keymap.isModifier(event, "Mod")) {
      return false;
    }
    if (Keymap.isModifier(event, "Alt") && Keymap.isModifier(event, "Shift")) {
      return "window";
    }
    if (Keymap.isModifier(event, "Alt")) {
      return "split";
    }
    return "tab";
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    let scope: Scope | null = this.scopeStack.at(-1) ?? this.getRootScope();
    const visited = new Set<Scope>();
    while (scope && !visited.has(scope)) {
      visited.add(scope);
      const dispatched = scope.handleKeyEvent(event);
      if (dispatched.matched) {
        if (dispatched.result === false) {
          event.preventDefault();
        }
        return;
      }
      scope = scope.parent;
    }
  };
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

export class Notice {
  readonly noticeEl: HTMLElement;
  readonly containerEl: HTMLElement;
  readonly messageEl: HTMLElement;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    message: string | DocumentFragment,
    duration = 5_000,
    private readonly onShow: (message: string) => void = () => {},
  ) {
    const messageText = typeof message === "string" ? message : (message.textContent ?? "");
    this.onShow(messageText);
    if (typeof document === "undefined") {
      this.noticeEl = null as unknown as HTMLElement;
      this.containerEl = null as unknown as HTMLElement;
      this.messageEl = null as unknown as HTMLElement;
      if (duration > 0) {
        this.timeoutHandle = setTimeout(() => this.hide(), duration);
        if (
          typeof this.timeoutHandle === "object" &&
          this.timeoutHandle !== null &&
          "unref" in this.timeoutHandle &&
          typeof this.timeoutHandle.unref === "function"
        ) {
          this.timeoutHandle.unref();
        }
      }
      return;
    }
    const doc = requireCompatibilityDocument();
    this.containerEl = doc.createElement("div");
    this.containerEl.className = "notice-container";
    this.noticeEl = doc.createElement("div");
    this.noticeEl.className = "notice";
    this.messageEl = doc.createElement("div");
    this.messageEl.className = "notice-message";
    this.noticeEl.append(this.messageEl);
    this.containerEl.append(this.noticeEl);
    this.setMessage(message);
    doc.body.append(this.containerEl);
    if (duration > 0) {
      this.timeoutHandle = setTimeout(() => this.hide(), duration);
    }
  }

  setMessage(message: string | DocumentFragment): this {
    if (this.messageEl === null) {
      return this;
    }
    if (typeof message === "string") {
      this.messageEl.textContent = message;
    } else {
      this.messageEl.replaceChildren(message);
    }
    return this;
  }

  hide(): void {
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.containerEl?.remove();
  }
}

const compatibilityMarkdown = new MarkdownIt({
  breaks: false,
  html: true,
  linkify: false,
  typographer: false,
});

interface MarkdownPreviewProcessorRegistration {
  defaultSortOrder: number;
  processor: MarkdownPostProcessor;
  sequence: number;
}

let activeCompatibilityApp: App | null = null;

function validateMarkdownPreviewSortOrder(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("Markdown processor sort order must be a finite integer.");
  }
  return value;
}

function markdownPreviewSortOrder(registration: MarkdownPreviewProcessorRegistration): number {
  const candidate = registration.processor.sortOrder;
  return candidate === undefined
    ? registration.defaultSortOrder
    : validateMarkdownPreviewSortOrder(candidate);
}

function markdownPreviewCodeBlockLanguage(codeBlock: HTMLElement): string | null {
  const languageClass = [...codeBlock.classList].find((className) =>
    className.toLowerCase().startsWith("language-"),
  );
  if (!languageClass) {
    return null;
  }
  const language = languageClass.slice("language-".length).trim().toLowerCase();
  return language || null;
}

// biome-ignore lint/complexity/noStaticOnlyClass: community plugins instantiate this public API by name.
export class MarkdownPreviewRenderer {
  private static readonly registrations: MarkdownPreviewProcessorRegistration[] = [];
  private static nextSequence = 0;

  static registerPostProcessor(postProcessor: MarkdownPostProcessor, sortOrder = 0): void {
    if (typeof postProcessor !== "function") {
      throw new Error("Markdown post processor registration requires a function.");
    }
    const defaultSortOrder = validateMarkdownPreviewSortOrder(sortOrder);
    postProcessor.sortOrder = defaultSortOrder;
    MarkdownPreviewRenderer.registrations.push({
      defaultSortOrder,
      processor: postProcessor,
      sequence: MarkdownPreviewRenderer.nextSequence++,
    });
  }

  static unregisterPostProcessor(postProcessor: MarkdownPostProcessor): void {
    for (let index = MarkdownPreviewRenderer.registrations.length - 1; index >= 0; index -= 1) {
      if (MarkdownPreviewRenderer.registrations[index]?.processor === postProcessor) {
        MarkdownPreviewRenderer.registrations.splice(index, 1);
      }
    }
  }

  static createCodeBlockPostProcessor(
    language: string,
    handler: MarkdownCodeBlockProcessor,
  ): MarkdownPostProcessor {
    const normalizedLanguage = language.trim().toLowerCase();
    if (!normalizedLanguage) {
      throw new Error("Markdown code block processor registration requires a language.");
    }
    if (typeof handler !== "function") {
      throw new Error("Markdown code block processor registration requires a function.");
    }
    return (async (element: HTMLElement, context: MarkdownPostProcessorContext): Promise<void> => {
      const candidates =
        element.tagName.toLowerCase() === "code" && element.parentElement?.tagName === "PRE"
          ? [element]
          : [...element.querySelectorAll<HTMLElement>("pre > code")];
      for (const codeBlock of candidates) {
        if (markdownPreviewCodeBlockLanguage(codeBlock) !== normalizedLanguage) {
          continue;
        }
        const preformatted = codeBlock.parentElement;
        if (!preformatted) {
          continue;
        }
        const replacement = element.ownerDocument.createElement("div");
        replacement.className = "markdown-code-block";
        preformatted.replaceWith(replacement);
        const source = codeBlock.textContent?.replace(/(?:\r\n|\r|\n)$/u, "") ?? "";
        await handler(source, replacement, context);
      }
    }) as MarkdownPostProcessor;
  }

  static async runPostProcessors(
    element: HTMLElement,
    context: MarkdownPostProcessorContext,
  ): Promise<void> {
    const registrations = [...MarkdownPreviewRenderer.registrations].sort(
      (left, right) =>
        markdownPreviewSortOrder(left) - markdownPreviewSortOrder(right) ||
        left.sequence - right.sequence,
    );
    for (const registration of registrations) {
      await registration.processor(element, context);
    }
  }
}

export abstract class MarkdownRenderer extends MarkdownRenderChild {
  readonly app: App;
  hoverPopover: unknown | null = null;

  constructor(containerEl: HTMLElement, app: App | null = activeCompatibilityApp) {
    super(containerEl);
    if (!app) {
      throw new Error("MarkdownRenderer requires an active compatibility App.");
    }
    this.app = app;
  }

  abstract get file(): TFile;

  static async renderMarkdown(
    markdown: string,
    element: HTMLElement,
    sourcePath: string,
    component: Component,
  ): Promise<void> {
    if (!activeCompatibilityApp) {
      throw new Error("MarkdownRenderer.renderMarkdown requires an active compatibility App.");
    }
    await MarkdownRenderer.render(activeCompatibilityApp, markdown, element, sourcePath, component);
  }

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
    await MarkdownPreviewRenderer.runPostProcessors(element, context);
  }
}

export class MarkdownPreviewView extends MarkdownRenderer {
  declare readonly containerEl: HTMLElement;
  private currentFile: TFile;
  private data = "";

  constructor(
    containerEl: HTMLElement,
    app: App | null = activeCompatibilityApp,
    file: TFile | null = null,
  ) {
    super(containerEl, app);
    this.currentFile = file ?? this.app.createFile("");
  }

  get file(): TFile {
    return this.currentFile;
  }

  setFile(file: TFile): void {
    this.currentFile = file;
  }

  get(): string {
    return this.data;
  }

  set(data: string, _clear: boolean): void {
    this.data = data;
    this.containerEl.replaceChildren();
    this.rerender();
  }

  clear(): void {
    this.data = "";
    this.containerEl.replaceChildren();
  }

  rerender(_full = false): void {
    this.containerEl.replaceChildren();
    void MarkdownRenderer.render(
      this.app,
      this.data,
      this.containerEl,
      this.currentFile.path,
      this,
    ).catch((error: unknown) => {
      this.containerEl.dataset.renderError = error instanceof Error ? error.message : String(error);
    });
  }

  getScroll(): number {
    return this.containerEl.scrollTop;
  }

  applyScroll(scroll: number): void {
    if (Number.isFinite(scroll)) {
      this.containerEl.scrollTop = Math.max(0, scroll);
    }
  }
}

setMarkdownPreviewViewConstructor(MarkdownPreviewView);

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
  const canvasViews = {
    canvas: () => ({ canvas }),
  };
  const canvasPlugin = {
    // This direct view adapter is not a backed CanvasPluginInstance.
    enabled: false,
    _loaded: true,
    load: async () => undefined,
    views: canvasViews,
  };
  const dailyNotes = { enabled: false };
  const bookmarks = { enabled: false };
  const fileExplorer = { enabled: false };
  const outline = { enabled: false };
  const plugins = {
    canvas: canvasPlugin,
    "daily-notes": dailyNotes,
    bookmarks,
    "file-explorer": fileExplorer,
    outline,
  };
  const getPluginById = (pluginId: string) =>
    Object.hasOwn(plugins, pluginId) ? plugins[pluginId as keyof typeof plugins] : null;

  return {
    plugins,
    getPluginById,
    getEnabledPluginById: (pluginId: string) => {
      const plugin = getPluginById(pluginId);
      if (!plugin?.enabled || !("instance" in plugin)) {
        return null;
      }
      return plugin.instance ?? null;
    },
  };
}

export class RenderContext {
  hoverPopover: unknown | null = null;
}

export class Tasks {
  readonly #pending = new Set<Promise<unknown>>();

  add(callback: () => Promise<unknown>): void {
    this.addPromise(Promise.resolve().then(callback));
  }

  addPromise(promise: Promise<unknown>): void {
    let tracked: Promise<unknown>;
    tracked = Promise.resolve(promise).finally(() => {
      this.#pending.delete(tracked);
    });
    this.#pending.add(tracked);
  }

  isEmpty(): boolean {
    return this.#pending.size === 0;
  }

  async promise(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending]);
    }
  }
}

export class SecretStorage extends Events {
  private readonly secrets = new Map<string, string>();

  setSecret(id: string, secret: string): void {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) {
      throw new Error(`Invalid secret identifier: ${id}`);
    }
    this.secrets.set(id, secret);
    this.trigger("changed", id);
  }

  getSecret(id: string): string | null {
    return this.secrets.get(id) ?? null;
  }

  listSecrets(): string[] {
    return [...this.secrets.keys()].sort((left, right) => left.localeCompare(right));
  }
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
  readonly keymap: Keymap;
  readonly scope: Scope;
  readonly plugins = new PluginManager();
  lastEvent: unknown | null = null;
  readonly renderContext = new RenderContext();
  readonly secretStorage = new SecretStorage();
  private readonly localStorageFallback = new Map<string, string>();
  private readonly pluginModals = new Map<string, Set<{ close(): void }>>();

  constructor(vault: Vault, commands: CommandRegistry, notices: NoticeBus) {
    activeCompatibilityApp = this;
    this.vault = vault;
    this.fileManager = new FileManager(vault);
    this.metadataCache = new MetadataCache(vault);
    this.commands = commands;
    this.notices = notices;
    this.workspace.setLinkResolver((linktext, sourcePath) =>
      this.metadataCache.getFirstLinkpathDest(linktext, sourcePath),
    );
    this.keymap = new Keymap();
    this.scope = this.keymap.getRootScope();
    this.commands.setEditorContextProvider(() => {
      const view = this.workspace.getActiveViewOfType(MarkdownView);
      return view ? { editor: view.editor, view } : null;
    });
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

  isDarkMode(): boolean {
    if (typeof document === "undefined") {
      return false;
    }
    return [document.documentElement, document.body].some((element) => {
      if (!element) {
        return false;
      }
      return (
        element.dataset.theme === "dark" ||
        element.classList.contains("theme-dark") ||
        element.classList.contains("dark")
      );
    });
  }

  loadLocalStorage(key: string): unknown | null {
    const serialized = this.readLocalStorageValue(key);
    if (serialized === null) {
      return null;
    }
    try {
      return JSON.parse(serialized) as unknown;
    } catch {
      return null;
    }
  }

  saveLocalStorage(key: string, data: unknown | null): void {
    if (data === null) {
      this.writeLocalStorageValue(key, null);
      return;
    }
    const serialized = JSON.stringify(data);
    if (serialized === undefined) {
      throw new Error(`Local storage value for ${key} is not JSON serializable.`);
    }
    this.writeLocalStorageValue(key, serialized);
  }

  private readLocalStorageValue(key: string): string | null {
    try {
      if (typeof globalThis.localStorage !== "undefined") {
        return globalThis.localStorage.getItem(key);
      }
    } catch {
      // Fall through to the renderer-lifetime fallback when storage is unavailable.
    }
    return this.localStorageFallback.get(key) ?? null;
  }

  private writeLocalStorageValue(key: string, value: string | null): void {
    try {
      if (typeof globalThis.localStorage !== "undefined") {
        if (value === null) {
          globalThis.localStorage.removeItem(key);
        } else {
          globalThis.localStorage.setItem(key, value);
        }
        return;
      }
    } catch {
      // Fall through to the renderer-lifetime fallback when storage is unavailable.
    }
    if (value === null) {
      this.localStorageFallback.delete(key);
    } else {
      this.localStorageFallback.set(key, value);
    }
  }
}

export class Plugin extends Component {
  readonly app: App;
  readonly manifest: PluginManifest;
  settings?: unknown;
  private readonly commandReleases = new Map<string, () => void>();

  constructor(app: App, manifest: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }

  async onload(): Promise<void> {}

  onUserEnable(): void {}

  onExternalSettingsChange(): unknown {
    return undefined;
  }

  async onunload(): Promise<void> {}

  addCommand(command: Command): Command {
    const idPrefix = `${this.manifest.id}:`;
    const namePrefix = `${this.manifest.name}: `;
    const localId = command.id.startsWith(idPrefix)
      ? command.id.slice(idPrefix.length)
      : command.id;
    const localName = command.name.startsWith(namePrefix)
      ? command.name.slice(namePrefix.length)
      : command.name;
    this.removeCommand(localId);

    command.id = `${idPrefix}${localId}`;
    command.name = `${namePrefix}${localName}`;
    const qualifiedId = command.id;
    const releaseCommand = this.app.commands.register(this.manifest.id, command, {
      displayName: localName,
    });
    const hotkeyHandlers = (command.hotkeys ?? []).map((hotkey) =>
      this.app.scope.register(hotkey.modifiers, hotkey.key, (event) => {
        if (event.repeat && command.repeatable !== true) {
          return true;
        }
        return !this.app.commands.executeCommandById(qualifiedId);
      }),
    );
    let active = true;
    const release = (): void => {
      if (!active) {
        return;
      }
      active = false;
      for (const handler of hotkeyHandlers) {
        this.app.scope.unregister(handler);
      }
      releaseCommand();
      if (this.commandReleases.get(localId) === release) {
        this.commandReleases.delete(localId);
      }
    };
    this.commandReleases.set(localId, release);
    this.register(release);
    return command;
  }

  removeCommand(commandId: string): void {
    const idPrefix = `${this.manifest.id}:`;
    const localId = commandId.startsWith(idPrefix) ? commandId.slice(idPrefix.length) : commandId;
    this.commandReleases.get(localId)?.();
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

  registerHoverLinkSource(id: string, info: CompatibilityHoverLinkSource): void {
    this.register(this.app.compatibility.registerHoverLinkSource(this.manifest.id, id, info));
  }

  registerExtensions(extensions: string[], viewType: string): void {
    this.register(
      this.app.compatibility.registerExtensions(this.manifest.id, extensions, viewType),
    );
  }

  registerBasesView(viewId: string, registration: CompatibilityBasesViewRegistration): boolean {
    return this.app.compatibility.registerBasesView(this.manifest.id, viewId, registration);
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
    this.register(this.app.compatibility.registerEditorExtension(this.manifest.id, extension));
  }

  registerObsidianProtocolHandler(
    action: string,
    handler: CompatibilityObsidianProtocolHandler,
  ): void {
    this.register(
      this.app.compatibility.registerObsidianProtocolHandler(this.manifest.id, action, handler),
    );
  }

  registerEditorSuggest(editorSuggest: EditorSuggest<unknown>): void {
    this.register(this.app.compatibility.registerEditorSuggest(editorSuggest));
  }

  registerCliHandler(
    command: string,
    description: string,
    flags: CompatibilityCliFlags | null,
    handler: CompatibilityCliHandler,
  ): void {
    this.register(
      this.app.compatibility.registerCliHandler(
        this.manifest.id,
        command,
        description,
        flags,
        handler,
      ),
    );
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
  BasesEntry: typeof BasesEntry;
  BasesEntryGroup: typeof BasesEntryGroup;
  BasesQueryResult: typeof BasesQueryResult;
  BasesView: typeof BasesView;
  BasesViewConfig: typeof BasesViewConfig;
  apiVersion: string;
  arrayBufferToBase64: typeof arrayBufferToBase64;
  arrayBufferToHex: typeof arrayBufferToHex;
  BaseComponent: typeof BaseComponent;
  base64ToArrayBuffer: typeof base64ToArrayBuffer;
  ButtonComponent: typeof ButtonComponent;
  ConfirmationButton: typeof ConfirmationButton;
  ConfirmationModal: typeof ConfirmationModal;
  ColorComponent: typeof ColorComponent;
  Component: typeof Component;
  DateValue: typeof DateValue;
  DurationValue: typeof DurationValue;
  DropdownComponent: typeof DropdownComponent;
  DisplayValueComponent: typeof DisplayValueComponent;
  Editor: typeof Editor;
  EditorSuggest: typeof EditorSuggest;
  EditableFileView: typeof EditableFileView;
  editorEditorField: EditorCompatibilityFields["editorEditorField"];
  editorInfoField: EditorCompatibilityFields["editorInfoField"];
  editorLivePreviewField: EditorCompatibilityFields["editorLivePreviewField"];
  editorViewField: EditorCompatibilityFields["editorViewField"];
  Events: typeof Events;
  ExtraButtonComponent: typeof ExtraButtonComponent;
  FileValue: typeof FileValue;
  FileManager: typeof FileManager;
  FileSystemAdapter: typeof FileSystemAdapter;
  FileView: typeof FileView;
  FuzzySuggestModal: typeof FuzzySuggestModal;
  getAllTags: typeof getAllTags;
  getBlobArrayBuffer: typeof getBlobArrayBuffer;
  getFrontMatterInfo: typeof getFrontMatterInfo;
  getLanguage: typeof getLanguage;
  getLinkpath: typeof getLinkpath;
  hexToArrayBuffer: typeof hexToArrayBuffer;
  htmlToMarkdown: typeof htmlToMarkdown;
  HTMLValue: typeof HTMLValue;
  IconValue: typeof IconValue;
  ImageValue: typeof ImageValue;
  ItemView: typeof ItemView;
  Keymap: typeof Keymap;
  LinkValue: typeof LinkValue;
  ListValue: typeof ListValue;
  MarkdownView: typeof MarkdownView;
  MarkdownEditView: typeof MarkdownEditView;
  MarkdownPreviewView: typeof MarkdownPreviewView;
  MarkdownPreviewRenderer: typeof MarkdownPreviewRenderer;
  MarkdownRenderer: typeof MarkdownRenderer;
  MarkdownRenderChild: typeof MarkdownRenderChild;
  MetadataCache: typeof MetadataCache;
  Menu: typeof Menu;
  MenuItem: typeof MenuItem;
  MenuSeparator: typeof MenuSeparator;
  moment: typeof moment;
  Modal: typeof Modal;
  MomentFormatComponent: typeof MomentFormatComponent;
  Notice: typeof Notice;
  Plugin: typeof Plugin;
  PluginSettingTab: typeof PluginSettingTab;
  HoverPopover: typeof HoverPopover;
  livePreviewState: EditorCompatibilityFields["livePreviewState"];
  PopoverState: typeof PopoverState;
  PopoverSuggest: typeof PopoverSuggest;
  ProgressBarComponent: typeof ProgressBarComponent;
  QueryController: typeof QueryController;
  RegExpValue: typeof RegExpValue;
  RelativeDateValue: typeof RelativeDateValue;
  RenderContext: typeof RenderContext;
  Scope: typeof Scope;
  SearchComponent: typeof SearchComponent;
  SecretStorage: typeof SecretStorage;
  SecretComponent: typeof SecretComponent;
  Setting: typeof Setting;
  SettingGroup: typeof SettingGroup;
  SettingPage: typeof SettingPage;
  SettingTab: typeof SettingTab;
  SliderComponent: typeof SliderComponent;
  SuggestModal: typeof SuggestModal;
  TFile: typeof TFile;
  TAbstractFile: typeof TAbstractFile;
  TFolder: typeof TFolder;
  Tasks: typeof Tasks;
  TextFileView: typeof TextFileView;
  TextAreaComponent: typeof TextAreaComponent;
  TextComponent: typeof TextComponent;
  TagValue: typeof TagValue;
  ToggleComponent: typeof ToggleComponent;
  ValueComponent: typeof ValueComponent;
  BooleanValue: typeof BooleanValue;
  NullValue: typeof NullValue;
  NotNullValue: typeof NotNullValue;
  NumberValue: typeof NumberValue;
  ObjectValue: typeof ObjectValue;
  PrimitiveValue: typeof PrimitiveValue;
  StringValue: typeof StringValue;
  UrlValue: typeof UrlValue;
  Value: typeof Value;
  View: typeof View;
  Vault: typeof Vault;
  Workspace: typeof Workspace;
  WorkspaceContainer: typeof WorkspaceContainer;
  WorkspaceItem: typeof WorkspaceItem;
  WorkspaceLeaf: typeof WorkspaceLeaf;
  WorkspaceMobileDrawer: typeof WorkspaceMobileDrawer;
  WorkspaceParent: typeof WorkspaceParent;
  WorkspaceRibbon: typeof WorkspaceRibbon;
  WorkspaceRoot: typeof WorkspaceRoot;
  WorkspaceSidedock: typeof WorkspaceSidedock;
  WorkspaceSplit: typeof WorkspaceSplit;
  WorkspaceTabs: typeof WorkspaceTabs;
  WorkspaceFloating: typeof WorkspaceFloating;
  WorkspaceWindow: typeof WorkspaceWindow;
  addIcon(id: string, svgContent: string): void;
  debounce: typeof debounce;
  displayTooltip: typeof displayTooltip;
  finishRenderMath: typeof finishRenderMath;
  getIcon(id: string): SVGSVGElement | null;
  getIconIds(): string[];
  iterateCacheRefs(cache: CachedMetadata, callback: ReferenceIterator<ReferenceCache>): boolean;
  iterateRefs(refs: Reference[], callback: ReferenceIterator<Reference>): boolean;
  normalizePath(filePath: string): string;
  parseFrontMatterAliases: typeof parseFrontMatterAliases;
  parseFrontMatterEntry: typeof parseFrontMatterEntry;
  parseFrontMatterStringArray: typeof parseFrontMatterStringArray;
  parseFrontMatterTags: typeof parseFrontMatterTags;
  parseLinktext: typeof parseLinktext;
  parsePropertyId(propertyId: string): BasesProperty;
  parseYaml: typeof parseYaml;
  Platform: typeof Platform;
  prepareFuzzySearch: typeof prepareFuzzySearch;
  prepareSimpleSearch: typeof prepareSimpleSearch;
  renderMatches(
    element: HTMLElement | DocumentFragment,
    text: string,
    matches: SearchMatchPart[] | null,
    offset?: number,
  ): void;
  renderResults(element: HTMLElement, text: string, result: SearchResult, offset?: number): void;
  requireApiVersion(version: string): boolean;
  request: typeof request;
  requestUrl: typeof requestUrl;
  resolveSubpath: typeof resolveSubpath;
  removeIcon(id: string): void;
  renderMath: typeof renderMath;
  sortSearchResults(results: SearchResultContainer[]): void;
  sanitizeHTMLToDom(html: string): DocumentFragment;
  setIcon(parent: HTMLElement, iconId: string): void;
  setTooltip: typeof setTooltip;
  sleep(milliseconds: number): Promise<void>;
  stringifyYaml: typeof stringifyYaml;
  stripHeading: typeof stripHeading;
  stripHeadingForLink: typeof stripHeadingForLink;
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

export function hexToArrayBuffer(hex: string): ArrayBuffer {
  if (hex.length % 2 !== 0 || !/^[\da-f]*$/iu.test(hex)) {
    throw new TypeError("Hex input must contain an even number of hexadecimal characters.");
  }
  const bytes = Buffer.from(hex, "hex");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export async function getBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
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

export function renderMath(source: string, display: boolean): HTMLElement {
  const document = requireCompatibilityDocument();
  return (
    createSafeMathElement(document, source, display) ??
    (() => {
      const fallback = document.createElement(display ? "div" : "span");
      fallback.className = display ? "tl-live-math-block" : "tl-live-math";
      fallback.setAttribute("role", "math");
      fallback.setAttribute("aria-label", source);
      fallback.textContent = source;
      return fallback;
    })()
  );
}

export function finishRenderMath(): Promise<void> {
  return Promise.resolve();
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

// biome-ignore lint/style/useConst: Obsidian exposes apiVersion as a mutable public binding.
export let apiVersion = "1.13.7";

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

function parseApiVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/u.exec(version.trim());
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

export function requireApiVersion(version: string): boolean {
  const requested = parseApiVersion(version);
  const current = parseApiVersion(apiVersion);
  if (!requested || !current) {
    return false;
  }
  for (let index = 0; index < current.length; index += 1) {
    const currentPart = current[index] ?? 0;
    const requestedPart = requested[index] ?? 0;
    if (currentPart !== requestedPart) {
      return currentPart > requestedPart;
    }
  }
  return true;
}

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

let displayedTooltipId = 0;

export function displayTooltip(
  newTargetEl: HTMLElement,
  content: string | DocumentFragment,
  options: TooltipOptions = {},
): void {
  const document = newTargetEl.ownerDocument;
  for (const tooltip of document.querySelectorAll<HTMLElement>(
    '[data-threadleaf-tooltip="active"]',
  )) {
    tooltip.remove();
  }
  const tooltip = document.createElement("div");
  const placement = options.placement ?? "bottom";
  tooltip.className = ["tooltip", ...(options.classes ?? [])].join(" ");
  tooltip.dataset.threadleafTooltip = "active";
  tooltip.dataset.tooltipPlacement = placement;
  tooltip.setAttribute("role", "tooltip");
  if (typeof content === "string") {
    tooltip.textContent = content;
  } else {
    tooltip.append(content);
  }
  const id = `threadleaf-tooltip-${++displayedTooltipId}`;
  tooltip.id = id;
  newTargetEl.setAttribute("aria-describedby", id);
  const show = (): void => {
    const rect = newTargetEl.getBoundingClientRect();
    const gap = options.gap ?? 8;
    const top = placement === "top" ? rect.top - gap : rect.bottom + gap;
    const left = placement === "left" ? rect.left - gap : rect.right + gap;
    tooltip.style.top = `${Math.max(0, top)}px`;
    tooltip.style.left = `${Math.max(0, left)}px`;
    (document.body ?? document.documentElement).append(tooltip);
  };
  if ((options.delay ?? 0) > 0) {
    globalThis.setTimeout(show, options.delay);
  } else {
    show();
  }
}

function requireActiveCompatibilityApp(): App {
  if (!activeCompatibilityApp) {
    throw new Error("Obsidian UI compatibility requires an active app.");
  }
  return activeCompatibilityApp;
}

export function addIcon(id: string, svgContent: string): void {
  requireActiveCompatibilityApp().compatibility.addIcon(id, svgContent);
}

export function getIcon(id: string): SVGSVGElement | null {
  const app = requireActiveCompatibilityApp();
  return createCompatibleIcon(requireCompatibilityDocument(), id, app.compatibility.getIcon(id));
}

export function getIconIds(): string[] {
  return requireActiveCompatibilityApp().compatibility.getIconIds();
}

export function iterateRefs(refs: Reference[], callback: ReferenceIterator<Reference>): boolean {
  for (const reference of refs) {
    if (callback(reference) === true) {
      return true;
    }
  }
  return false;
}

export function iterateCacheRefs(
  cache: CachedMetadata,
  callback: ReferenceIterator<ReferenceCache>,
): boolean {
  for (const reference of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
    if (callback(reference) === true) {
      return true;
    }
  }
  return false;
}

export function removeIcon(id: string): void {
  requireActiveCompatibilityApp().compatibility.removeIcon(id);
}

export function sortSearchResults(results: SearchResultContainer[]): void {
  results.sort((left, right) => right.match.score - left.match.score);
}

function appendSearchText(element: HTMLElement | DocumentFragment, text: string): void {
  if (text.length > 0) {
    element.append(element.ownerDocument.createTextNode(text));
  }
}

export function renderMatches(
  element: HTMLElement | DocumentFragment,
  text: string,
  matches: SearchMatchPart[] | null,
  offset = 0,
): void {
  if (!matches || matches.length === 0) {
    appendSearchText(element, text);
    return;
  }
  const normalizedOffset = Number.isFinite(offset) ? offset : 0;
  let cursor = 0;
  const ranges = [...matches]
    .map(([from, to]) => [from - normalizedOffset, to - normalizedOffset] as SearchMatchPart)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  for (const [from, to] of ranges) {
    const start = Math.max(cursor, Math.min(text.length, Math.trunc(from)));
    const end = Math.max(start, Math.min(text.length, Math.trunc(to)));
    if (end <= start) {
      continue;
    }
    appendSearchText(element, text.slice(cursor, start));
    const matchElement = element.ownerDocument.createElement("span");
    matchElement.className = "search-result-file-matched-text";
    matchElement.textContent = text.slice(start, end);
    element.append(matchElement);
    cursor = end;
  }
  appendSearchText(element, text.slice(cursor));
}

export function renderResults(
  element: HTMLElement,
  text: string,
  result: SearchResult,
  offset = 0,
): void {
  renderMatches(element, text, result.matches, offset);
}

export function setIcon(parent: HTMLElement, iconId: string): void {
  parent.replaceChildren();
  const icon = getIcon(iconId);
  if (icon) {
    parent.append(icon);
  } else {
    parent.dataset.icon = iconId;
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
  const words = [...new Set(query.toLowerCase().split(" ").filter(Boolean))];
  if (words.length === 0) {
    return () => ({ score: 0, matches: [] });
  }

  return (text: string): SearchResult | null => {
    const loweredText = text.toLowerCase();
    const matches: SearchMatchPart[] = [];
    for (const word of words) {
      let start = loweredText.indexOf(word);
      if (start === -1) {
        return null;
      }
      while (start !== -1) {
        matches.push([start, start + word.length]);
        start = loweredText.indexOf(word, start + word.length + 1);
      }
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
    let score = query.length / 100 - text.length / 10_000;
    for (const [index, match] of merged.entries()) {
      const [start, end] = match;
      if (index === 0) {
        score -=
          (end - start + (words.length === 1 || merged.length === 1 || end - start === 1 ? 1 : 0)) /
            100 +
          start / 1_000;
      } else {
        score -= 1 + start / 100;
      }
    }
    return {
      score,
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

export function createObsidianCompatibilityModule(
  app: App,
  editorFields: EditorCompatibilityFields = rendererEditorCompatibilityFields,
): ObsidianCompatibilityModule {
  class BoundNotice extends Notice {
    constructor(message: string | DocumentFragment, duration?: number) {
      super(message, duration, (text) => app.notices.show(text));
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
  const getIconIds = (): string[] => app.compatibility.getIconIds();
  const removeIcon = (id: string): void => app.compatibility.removeIcon(id);
  class BoundMenu extends Menu {
    constructor() {
      super((iconId) => app.compatibility.getIcon(iconId));
    }
  }

  return {
    AbstractInputSuggest,
    AbstractTextComponent,
    App,
    BasesEntry,
    BasesEntryGroup,
    BasesQueryResult,
    BasesView,
    BasesViewConfig,
    apiVersion,
    arrayBufferToBase64,
    arrayBufferToHex,
    BaseComponent,
    base64ToArrayBuffer,
    ButtonComponent,
    ConfirmationButton,
    ConfirmationModal,
    ColorComponent,
    Component,
    DateValue,
    DurationValue,
    displayTooltip,
    debounce,
    DropdownComponent,
    DisplayValueComponent,
    Editor,
    EditorSuggest,
    EditableFileView,
    editorEditorField: editorFields.editorEditorField,
    editorInfoField: editorFields.editorInfoField,
    editorLivePreviewField: editorFields.editorLivePreviewField,
    editorViewField: editorFields.editorViewField,
    Events,
    ExtraButtonComponent,
    finishRenderMath,
    FileValue,
    FileManager,
    FileSystemAdapter,
    FileView,
    FuzzySuggestModal,
    getAllTags,
    getBlobArrayBuffer,
    getFrontMatterInfo,
    getLinkpath,
    hexToArrayBuffer,
    HTMLValue,
    ItemView,
    IconValue,
    ImageValue,
    Keymap,
    LinkValue,
    ListValue,
    MarkdownView,
    MarkdownEditView,
    MarkdownPreviewView,
    MarkdownPreviewRenderer,
    MarkdownRenderer,
    MarkdownRenderChild,
    MetadataCache,
    Menu: BoundMenu,
    MenuItem,
    MenuSeparator,
    moment,
    Modal,
    MomentFormatComponent,
    Notice: BoundNotice,
    parseFrontMatterAliases,
    parseFrontMatterEntry,
    parseFrontMatterStringArray,
    parseFrontMatterTags,
    parsePropertyId,
    parseYaml,
    Plugin,
    PluginSettingTab,
    HoverPopover,
    livePreviewState: editorFields.livePreviewState,
    PopoverState,
    PopoverSuggest,
    ProgressBarComponent,
    QueryController,
    RegExpValue,
    RelativeDateValue,
    RenderContext,
    Scope,
    SearchComponent,
    SecretStorage,
    SecretComponent,
    Setting,
    SettingGroup,
    SettingPage,
    SettingTab,
    SliderComponent,
    SuggestModal,
    TFile,
    TAbstractFile,
    TFolder,
    Tasks,
    TextFileView,
    TextAreaComponent,
    TextComponent,
    TagValue,
    ToggleComponent,
    ValueComponent,
    BooleanValue,
    NullValue,
    NotNullValue,
    NumberValue,
    ObjectValue,
    PrimitiveValue,
    StringValue,
    UrlValue,
    Value,
    Vault,
    View,
    Workspace,
    WorkspaceContainer,
    WorkspaceItem,
    WorkspaceLeaf,
    WorkspaceMobileDrawer,
    WorkspaceParent,
    WorkspaceRibbon,
    WorkspaceRoot,
    WorkspaceSidedock,
    WorkspaceSplit,
    WorkspaceTabs,
    WorkspaceFloating,
    WorkspaceWindow,
    addIcon,
    getIcon,
    getIconIds,
    getLanguage,
    htmlToMarkdown,
    iterateCacheRefs,
    iterateRefs,
    normalizePath,
    parseLinktext,
    Platform,
    prepareFuzzySearch,
    prepareSimpleSearch,
    renderMatches,
    renderResults,
    requireApiVersion,
    request,
    requestUrl,
    resolveSubpath,
    removeIcon,
    renderMath,
    sanitizeHTMLToDom,
    setIcon,
    setTooltip,
    sleep,
    sortSearchResults,
    stringifyYaml,
    stripHeading,
    stripHeadingForLink,
  };
}
