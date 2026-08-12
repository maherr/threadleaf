import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { compileFunction } from "node:vm";
import { ActionRegistry } from "../application/action-registry";
import { isPathInside } from "../kernel/path-policy";
import type { VaultReadPort } from "../kernel/ports";
import type {
  PluginSummary,
  RuntimeEvent,
  RuntimeEventKind,
  RuntimeSnapshot,
} from "../shared/contracts";
import { maxPluginBundleBytes, parsePluginManifest } from "../shared/plugins";
import {
  App,
  CommandRegistry,
  createObsidianCompatibilityModule,
  NoticeBus,
  Plugin,
  type PluginManifest,
  Vault,
} from "./obsidian-compat";

interface CommonJsModuleRecord {
  exports: unknown;
}

type PluginConstructor = new (app: App, manifest: PluginManifest) => Plugin;

interface LoadedPluginRecord {
  directoryPath: string;
  instance: Plugin | null;
  summary: PluginSummary;
}

export class PluginHost {
  readonly app: App;
  readonly vault: Vault;

  private readonly events: RuntimeEvent[] = [];
  private eventSequence = 0;
  private readonly plugins = new Map<string, LoadedPluginRecord>();
  private lastPluginId: string | null = null;

  constructor(vaultPath: string, reader?: VaultReadPort, actions = new ActionRegistry()) {
    this.vault = new Vault(vaultPath, reader);
    const commands = new CommandRegistry(actions);
    const notices = new NoticeBus((message) => this.record("notice", message));
    this.app = new App(this.vault, commands, notices);
    this.record("runtime", `Opened synthetic vault ${this.vault.getName()} in read-only mode.`);
  }

  async loadPlugin(pluginDirectory: string): Promise<RuntimeSnapshot> {
    const resolvedDirectory = await this.assertInsideVault(pluginDirectory);
    const manifestPath = await this.canonicalPluginFile(resolvedDirectory, "manifest.json");
    const entryPath = await this.canonicalPluginFile(resolvedDirectory, "main.js");
    const manifest = await this.readManifest(manifestPath);
    if (manifest.id !== path.basename(resolvedDirectory)) {
      throw new Error(
        `Plugin manifest id ${manifest.id} does not match folder ${path.basename(resolvedDirectory)}.`,
      );
    }
    const stylesheetDiscovered = await this.fileExists(
      path.join(resolvedDirectory, "styles.css"),
      resolvedDirectory,
    );
    if (this.plugins.has(manifest.id)) {
      await this.unloadPlugin(manifest.id);
    }

    const record: LoadedPluginRecord = {
      directoryPath: resolvedDirectory,
      instance: null,
      summary: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        state: "empty",
        compatibilityLevel: 0,
        stylesheetDiscovered,
        error: null,
      },
    };
    this.plugins.set(manifest.id, record);
    this.lastPluginId = manifest.id;
    this.record("plugin", `Discovered ${manifest.name} ${manifest.version}.`);

    let instance: Plugin | null = null;
    try {
      const PluginClass = await this.evaluatePlugin(entryPath);
      instance = new PluginClass(this.app, manifest);
      if (!(instance instanceof Plugin)) {
        throw new Error("Plugin export does not extend the compatibility Plugin class.");
      }
      record.instance = instance;
      record.summary = { ...record.summary, state: "loaded", compatibilityLevel: 1 };
      this.record("plugin", "Injected the open compatibility module and constructed the plugin.");

      const commandIdsBefore = new Set(this.app.commands.list().map(({ id }) => id));
      await instance.onload();
      record.summary = { ...record.summary, compatibilityLevel: 2 };
      this.record("plugin", "Plugin onload completed without an uncaught error.");

      const commands = this.app.commands
        .list()
        .filter(
          ({ id }) => !commandIdsBefore.has(id) && this.app.commands.ownerIdFor(id) === manifest.id,
        );
      if (commands.length > 0) {
        record.summary = { ...record.summary, compatibilityLevel: 3 };
        for (const command of commands) {
          this.record("command", `Registered command: ${command.name}.`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await instance?.__unload().catch(() => undefined);
      record.instance = null;
      record.summary = {
        ...record.summary,
        state: "failed",
        error: message,
      };
      this.record("error", `${manifest.name} load failed: ${message}`);
      throw error;
    }

    return this.getSnapshot();
  }

  async runCommand(commandId: string): Promise<RuntimeSnapshot> {
    const command = this.app.commands.list().find(({ id }) => id === commandId);
    const ran = await this.app.commands.run(commandId);
    if (!ran || !command) {
      throw new Error(`Command is not available: ${commandId}`);
    }

    this.record("command", `Ran command: ${command.name}.`);
    const ownerId = this.app.commands.ownerIdFor(commandId);
    const record = ownerId ? this.plugins.get(ownerId) : undefined;
    if (record) {
      record.summary = { ...record.summary, compatibilityLevel: 4 };
      this.lastPluginId = ownerId ?? this.lastPluginId;
    }
    return this.getSnapshot();
  }

  async unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    const targetId = pluginId ?? this.lastPluginId;
    const record = targetId ? this.plugins.get(targetId) : undefined;
    if (!record || record.summary.state === "unloaded") {
      return this.getSnapshot();
    }
    let unloadError: string | null = null;
    try {
      await record.instance?.__unload();
    } catch (error) {
      unloadError = error instanceof Error ? error.message : String(error);
    }
    record.instance = null;
    record.summary = {
      ...record.summary,
      state: "unloaded",
      compatibilityLevel: 1,
      error: unloadError,
    };
    this.lastPluginId = targetId ?? this.lastPluginId;
    this.record("plugin", `Unloaded ${record.summary.name} and released its registrations.`);
    if (unloadError) {
      this.record("error", `${record.summary.name} onunload failed: ${unloadError}`);
    }
    return this.getSnapshot();
  }

  async unloadAllPlugins(): Promise<RuntimeSnapshot> {
    for (const pluginId of [...this.plugins.keys()]) {
      await this.unloadPlugin(pluginId);
    }
    return this.getSnapshot();
  }

  async reloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    const targetId = pluginId ?? this.lastPluginId;
    const record = targetId ? this.plugins.get(targetId) : undefined;
    if (!record) {
      throw new Error("No plugin has been loaded yet.");
    }
    return this.loadPlugin(record.directoryPath);
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    const plugins = [...this.plugins.values()]
      .map(({ summary }) => ({ ...summary }))
      .sort((left, right) => left.name.localeCompare(right.name, "en-US", { numeric: true }));
    const currentPlugin = this.lastPluginId
      ? (plugins.find(({ id }) => id === this.lastPluginId) ?? null)
      : null;
    return {
      vault: {
        id: null,
        name: this.vault.getName(),
        path: this.vault.rootPath,
        markdownFileCount: (await this.vault.getMarkdownFiles()).length,
        mode: "synthetic-read-only",
        source: "direct",
        warning: null,
      },
      plugin: currentPlugin,
      plugins,
      commands: this.app.commands.list(),
      actions: this.app.commands.actions.list(),
      notices: this.app.notices.list(),
      events: this.events.map((event) => ({ ...event })),
    };
  }

  private async evaluatePlugin(entryPath: string): Promise<PluginConstructor> {
    const source = await this.readBoundedText(entryPath, maxPluginBundleBytes);
    const nativeRequire = createRequire(entryPath);
    const compatibilityModule = createObsidianCompatibilityModule(this.app);
    const moduleRecord: CommonJsModuleRecord = { exports: {} };

    const pluginRequire = ((request: string) => {
      if (request === "obsidian") {
        return compatibilityModule;
      }
      return nativeRequire(request);
    }) as NodeJS.Require;

    pluginRequire.resolve = ((request: string, options?: { paths?: string[] }) => {
      if (request === "obsidian") {
        return "obsidian";
      }
      return nativeRequire.resolve(request, options);
    }) as NodeJS.RequireResolve;
    pluginRequire.cache = nativeRequire.cache;
    pluginRequire.extensions = nativeRequire.extensions;
    pluginRequire.main = nativeRequire.main;

    const compiled = compileFunction(
      source,
      ["exports", "require", "module", "__filename", "__dirname"],
      { filename: entryPath },
    );
    compiled(moduleRecord.exports, pluginRequire, moduleRecord, entryPath, path.dirname(entryPath));

    const candidate = this.resolvePluginConstructor(moduleRecord.exports);
    if (typeof candidate !== "function") {
      throw new Error("Plugin bundle does not export a constructor.");
    }
    return candidate as PluginConstructor;
  }

  private resolvePluginConstructor(moduleExports: unknown): unknown {
    if (typeof moduleExports === "function") {
      return moduleExports;
    }
    if (moduleExports && typeof moduleExports === "object" && "default" in moduleExports) {
      return moduleExports.default;
    }
    return null;
  }

  private async readManifest(manifestPath: string): Promise<PluginManifest> {
    const manifest = parsePluginManifest(
      JSON.parse(await this.readBoundedText(manifestPath, 64 * 1024)),
    );
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.minAppVersion ? { minAppVersion: manifest.minAppVersion } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.author ? { author: manifest.author } : {}),
      ...(manifest.authorUrl ? { authorUrl: manifest.authorUrl } : {}),
      isDesktopOnly: manifest.isDesktopOnly,
    };
  }

  private async assertInsideVault(candidatePath: string): Promise<string> {
    const resolved = path.resolve(candidatePath);
    const [canonicalVault, canonicalPluginRoot, canonicalCandidate] = await Promise.all([
      fs.realpath(this.vault.rootPath),
      fs.realpath(path.join(this.vault.rootPath, ".obsidian", "plugins")),
      fs.realpath(resolved),
    ]);
    const stat = await fs.stat(canonicalCandidate);
    if (
      !stat.isDirectory() ||
      !isPathInside(canonicalVault, canonicalPluginRoot) ||
      path.dirname(canonicalCandidate) !== canonicalPluginRoot
    ) {
      throw new Error(
        "Plugin directory must be an immediate child of .obsidian/plugins in the active vault.",
      );
    }
    return canonicalCandidate;
  }

  private async canonicalPluginFile(directoryPath: string, filename: string): Promise<string> {
    const candidatePath = await fs.realpath(path.join(directoryPath, filename));
    if (!isPathInside(directoryPath, candidatePath)) {
      throw new Error(`${filename} resolves outside its plugin directory.`);
    }
    const stat = await fs.stat(candidatePath);
    if (!stat.isFile()) {
      throw new Error(`${filename} is not a regular file.`);
    }
    return candidatePath;
  }

  private async readBoundedText(filePath: string, maxBytes: number): Promise<string> {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`${path.basename(filePath)} is not a regular file.`);
    }
    if (stat.size > maxBytes) {
      throw new Error(`${path.basename(filePath)} exceeds its ${maxBytes} byte limit.`);
    }
    const bytes = await fs.readFile(filePath);
    if (bytes.byteLength > maxBytes) {
      throw new Error(`${path.basename(filePath)} grew beyond its size limit while reading.`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  private async fileExists(filePath: string, directoryPath: string): Promise<boolean> {
    try {
      await this.canonicalPluginFile(directoryPath, path.basename(filePath));
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private record(kind: RuntimeEventKind, message: string): void {
    this.events.push({ sequence: ++this.eventSequence, kind, message });
  }
}
