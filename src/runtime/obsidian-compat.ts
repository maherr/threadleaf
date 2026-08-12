import { type Dirent, promises as fs, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import MarkdownIt from "markdown-it";
import { parse as parseYaml } from "yaml";
import { ActionRegistry } from "../application/action-registry";
import { revisionOf } from "../kernel/durability";
import type { VaultReadPort, VaultWriteResult } from "../kernel/ports";
import type { CommandSummary } from "../shared/contracts";
import { Component } from "./obsidian-components";
import { createCompatibleIcon } from "./obsidian-icons";
import {
  AbstractTextComponent,
  BaseComponent,
  ButtonComponent,
  ColorComponent,
  DropdownComponent,
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
}

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

export class Vault {
  readonly configDir = ".obsidian";
  readonly rootPath: string;
  readonly #reader: VaultReadPort | undefined;
  readonly #writer: CompatibilityVaultWritePort | undefined;
  private readonly listeners = new Map<string, Set<VaultEventCallback>>();
  private readonly revisions = new Map<string, string>();

  constructor(rootPath: string, reader?: VaultReadPort, writer?: CompatibilityVaultWritePort) {
    this.rootPath = path.resolve(rootPath);
    this.#reader = reader;
    this.#writer = writer;
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

  getFileByPath(filePath: string): TFile | null {
    const abstractFile = this.getAbstractFileByPath(filePath);
    return abstractFile instanceof TFile ? abstractFile : null;
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
    const outcome = await this.#writer.writeText(normalized, content, expectedRevision);
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

export interface CachedMetadata {
  frontmatter?: Record<string, unknown>;
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
        const frontmatter = parseFrontmatter(
          readFileSync(this.vault.resolveVaultPath(file.path), "utf8"),
        );
        value = frontmatter ? { frontmatter } : {};
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
        if (!command.callback) {
          throw new Error(`Command has no supported callback: ${command.id}`);
        }
        return command.callback();
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
    if (!command?.callback) {
      return false;
    }

    await this.actions.dispatch(commandId);
    return true;
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
    _app: App,
    markdown: string,
    element: HTMLElement,
    _sourcePath: string,
    _component: Component,
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
  readonly metadataCache: MetadataCache;
  readonly commands: CommandRegistry;
  readonly notices: NoticeBus;
  readonly workspace = new Workspace();
  readonly compatibility = new CompatibilityIntegrationRegistry();
  readonly internalPlugins = createInternalPlugins();
  readonly keymap = new Keymap();
  readonly plugins = new PluginManager();

  constructor(vault: Vault, commands: CommandRegistry, notices: NoticeBus) {
    this.vault = vault;
    this.metadataCache = new MetadataCache(vault);
    this.commands = commands;
    this.notices = notices;
  }

  createFile(filePath: string): TFile {
    return this.vault.getFileByPath(filePath) ?? new TFile(filePath, this.vault);
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
    this.register(this.app.compatibility.addSettingTab(settingTab));
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

  registerMarkdownPostProcessor<T>(postProcessor: T, _sortOrder?: number): T {
    this.register(this.app.compatibility.registerMarkdownPostProcessor(postProcessor));
    return postProcessor;
  }

  registerMarkdownCodeBlockProcessor<T>(_language: string, processor: T, sortOrder?: number): T {
    return this.registerMarkdownPostProcessor(processor, sortOrder);
  }

  registerEditorExtension(extension: unknown): void {
    this.register(this.app.compatibility.registerEditorExtension(extension));
  }

  registerEditorSuggest(editorSuggest: EditorSuggest<unknown>): void {
    this.register(this.app.compatibility.registerEditorSuggest(editorSuggest));
  }

  async loadData(): Promise<unknown | null> {
    return this.app.compatibility.loadPluginData(this.manifest.id);
  }

  async saveData(data: unknown): Promise<void> {
    this.app.compatibility.savePluginData(this.manifest.id, data);
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
    if (failure) {
      throw failure.error;
    }
  }
}

export interface ObsidianCompatibilityModule {
  AbstractTextComponent: typeof AbstractTextComponent;
  App: typeof App;
  BaseComponent: typeof BaseComponent;
  ButtonComponent: typeof ButtonComponent;
  ColorComponent: typeof ColorComponent;
  Component: typeof Component;
  DropdownComponent: typeof DropdownComponent;
  EditorSuggest: typeof EditorSuggest;
  ExtraButtonComponent: typeof ExtraButtonComponent;
  FileView: typeof FileView;
  FuzzySuggestModal: typeof FuzzySuggestModal;
  getLanguage: typeof getLanguage;
  ItemView: typeof ItemView;
  Keymap: typeof Keymap;
  MarkdownView: typeof MarkdownView;
  MarkdownRenderer: typeof MarkdownRenderer;
  MetadataCache: typeof MetadataCache;
  Modal: typeof Modal;
  MomentFormatComponent: typeof MomentFormatComponent;
  Notice: new (message: string, timeout?: number) => object;
  Plugin: typeof Plugin;
  PluginSettingTab: typeof PluginSettingTab;
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
  getIcon(id: string): SVGSVGElement | null;
  normalizePath(filePath: string): string;
  requireApiVersion(version: string): boolean;
  sanitizeHTMLToDom(html: string): DocumentFragment;
  setIcon(parent: HTMLElement, iconId: string): void;
  sleep(milliseconds: number): Promise<void>;
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

  return {
    AbstractTextComponent,
    App,
    BaseComponent,
    ButtonComponent,
    ColorComponent,
    Component,
    DropdownComponent,
    EditorSuggest,
    ExtraButtonComponent,
    FileView,
    FuzzySuggestModal,
    ItemView,
    Keymap,
    MarkdownView,
    MarkdownRenderer,
    MetadataCache,
    Modal,
    MomentFormatComponent,
    Notice,
    Plugin,
    PluginSettingTab,
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
    normalizePath,
    requireApiVersion: () => true,
    sanitizeHTMLToDom,
    setIcon,
    sleep,
  };
}
