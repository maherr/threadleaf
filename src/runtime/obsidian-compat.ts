import { promises as fs } from "node:fs";
import path from "node:path";
import { ActionRegistry } from "../application/action-registry";
import type { VaultReadPort } from "../kernel/ports";
import type { CommandSummary } from "../shared/contracts";
import { Component } from "./obsidian-components";
import {
  BaseComponent,
  EditorSuggest,
  FileView,
  FuzzySuggestModal,
  ItemView,
  MarkdownView,
  Modal,
  PluginSettingTab,
  Scope,
  SettingTab,
  SuggestModal,
  TextFileView,
  View,
  WorkspaceLeaf,
} from "./obsidian-ui-compat";
import { CompatibilityIntegrationRegistry, Workspace } from "./obsidian-workspace-compat";

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
}

export class TFile {
  readonly path: string;
  readonly name: string;
  readonly basename: string;
  readonly extension: string;

  constructor(filePath: string) {
    this.path = filePath;
    this.name = path.posix.basename(filePath);
    this.extension = path.posix.extname(filePath).slice(1);
    this.basename =
      this.extension.length > 0 ? this.name.slice(0, -(this.extension.length + 1)) : this.name;
  }
}

export class Vault {
  readonly rootPath: string;
  readonly #reader: VaultReadPort | undefined;

  constructor(rootPath: string, reader?: VaultReadPort) {
    this.rootPath = path.resolve(rootPath);
    this.#reader = reader;
  }

  getName(): string {
    return path.basename(this.rootPath);
  }

  async getMarkdownFiles(): Promise<TFile[]> {
    if (this.#reader) {
      return (await this.#reader.listMarkdownPaths()).map((filePath) => new TFile(filePath));
    }
    const files: TFile[] = [];
    await this.collectMarkdownFiles(this.rootPath, files);
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  async read(file: TFile): Promise<string> {
    if (this.#reader) {
      return (await this.#reader.readText(file.path)).content;
    }
    const absolutePath = this.resolveVaultPath(file.path);
    return fs.readFile(absolutePath, "utf8");
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

  private async collectMarkdownFiles(directory: string, files: TFile[]): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.collectMarkdownFiles(absolutePath, files);
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(new TFile(path.relative(this.rootPath, absolutePath).split(path.sep).join("/")));
      }
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
    if (this.commands.has(command.id)) {
      throw new Error(`Command already registered: ${command.id}`);
    }

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
    this.commands.set(command.id, { ...command, ownerId });
    return () => {
      const registered = this.commands.get(command.id);
      if (registered?.ownerId === ownerId) {
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

export class App {
  readonly vault: Vault;
  readonly commands: CommandRegistry;
  readonly notices: NoticeBus;
  readonly workspace = new Workspace();
  readonly compatibility = new CompatibilityIntegrationRegistry();

  constructor(vault: Vault, commands: CommandRegistry, notices: NoticeBus) {
    this.vault = vault;
    this.commands = commands;
    this.notices = notices;
  }

  createFile(filePath: string): TFile {
    return new TFile(filePath);
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
  App: typeof App;
  BaseComponent: typeof BaseComponent;
  Component: typeof Component;
  EditorSuggest: typeof EditorSuggest;
  FileView: typeof FileView;
  FuzzySuggestModal: typeof FuzzySuggestModal;
  getLanguage: typeof getLanguage;
  ItemView: typeof ItemView;
  MarkdownView: typeof MarkdownView;
  Modal: typeof Modal;
  Notice: new (message: string, timeout?: number) => object;
  Plugin: typeof Plugin;
  PluginSettingTab: typeof PluginSettingTab;
  Scope: typeof Scope;
  SettingTab: typeof SettingTab;
  SuggestModal: typeof SuggestModal;
  TFile: typeof TFile;
  TextFileView: typeof TextFileView;
  View: typeof View;
  Vault: typeof Vault;
  Workspace: typeof Workspace;
  WorkspaceLeaf: typeof WorkspaceLeaf;
  addIcon(id: string, svgContent: string): void;
  getIcon(id: string): SVGSVGElement | null;
  normalizePath(filePath: string): string;
  requireApiVersion(version: string): boolean;
  setIcon(parent: HTMLElement, iconId: string): void;
}

export function getLanguage(): string {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.trim();
  return locale || "en";
}

function requireCompatibilityDocument(): Document {
  if (typeof document === "undefined") {
    throw new Error("Obsidian UI compatibility requires a renderer document.");
  }
  return document;
}

export function normalizePath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.replaceAll("\\", "/")).normalize("NFC");
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
    const content = app.compatibility.getIcon(id);
    if (content === null) {
      return null;
    }
    const svg = requireCompatibilityDocument().createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.dataset.icon = id;
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = content;
    return svg;
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
    App,
    BaseComponent,
    Component,
    EditorSuggest,
    FileView,
    FuzzySuggestModal,
    ItemView,
    MarkdownView,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    Scope,
    SettingTab,
    SuggestModal,
    TFile,
    TextFileView,
    Vault,
    View,
    Workspace,
    WorkspaceLeaf,
    addIcon,
    getIcon,
    getLanguage,
    normalizePath,
    requireApiVersion: () => true,
    setIcon,
  };
}
