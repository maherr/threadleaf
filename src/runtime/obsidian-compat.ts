import { promises as fs } from "node:fs";
import path from "node:path";
import { ActionRegistry } from "../application/action-registry";
import type { VaultReadPort } from "../kernel/ports";
import type { CommandSummary } from "../shared/contracts";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  description?: string;
  author?: string;
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
      .map(({ id, name }) => ({ id, name }))
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

  constructor(vault: Vault, commands: CommandRegistry, notices: NoticeBus) {
    this.vault = vault;
    this.commands = commands;
    this.notices = notices;
  }
}

export class Plugin {
  readonly app: App;
  readonly manifest: PluginManifest;
  private readonly registrations: Array<() => void> = [];

  constructor(app: App, manifest: PluginManifest) {
    this.app = app;
    this.manifest = manifest;
  }

  async onload(): Promise<void> {}

  async onunload(): Promise<void> {}

  addCommand(command: Command): Command {
    this.register(this.app.commands.register(this.manifest.id, command));
    return command;
  }

  register(dispose: () => void): void {
    this.registrations.push(dispose);
  }

  async __unload(): Promise<void> {
    try {
      await this.onunload();
    } finally {
      for (const dispose of this.registrations.reverse()) {
        dispose();
      }
      this.registrations.length = 0;
    }
  }
}

export interface ObsidianCompatibilityModule {
  App: typeof App;
  Notice: new (message: string, timeout?: number) => object;
  Plugin: typeof Plugin;
  TFile: typeof TFile;
  Vault: typeof Vault;
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

  return { App, Notice, Plugin, TFile, Vault };
}
