import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { compileFunction } from "node:vm";
import type {
  PluginSummary,
  RuntimeEvent,
  RuntimeEventKind,
  RuntimeSnapshot,
} from "../shared/contracts";
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

export class PluginHost {
  readonly app: App;
  readonly vault: Vault;

  private readonly events: RuntimeEvent[] = [];
  private eventSequence = 0;
  private plugin: Plugin | null = null;
  private pluginDirectory: string | null = null;
  private pluginSummary: PluginSummary | null = null;

  constructor(vaultPath: string) {
    this.vault = new Vault(vaultPath);
    const commands = new CommandRegistry();
    const notices = new NoticeBus((message) => this.record("notice", message));
    this.app = new App(this.vault, commands, notices);
    this.record("runtime", `Opened synthetic vault ${this.vault.getName()} in read-only mode.`);
  }

  async loadPlugin(pluginDirectory: string): Promise<RuntimeSnapshot> {
    if (this.plugin) {
      await this.unloadPlugin();
    }

    const resolvedDirectory = this.assertInsideVault(pluginDirectory);
    const manifest = await this.readManifest(path.join(resolvedDirectory, "manifest.json"));
    const entryPath = path.join(resolvedDirectory, "main.js");
    const stylesheetDiscovered = await this.fileExists(path.join(resolvedDirectory, "styles.css"));

    this.pluginDirectory = resolvedDirectory;
    this.pluginSummary = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      state: "empty",
      compatibilityLevel: 0,
      stylesheetDiscovered,
    };
    this.record("plugin", `Discovered ${manifest.name} ${manifest.version}.`);

    try {
      const PluginClass = await this.evaluatePlugin(entryPath);
      this.plugin = new PluginClass(this.app, manifest);
      if (!(this.plugin instanceof Plugin)) {
        throw new Error("Plugin export does not extend the compatibility Plugin class.");
      }
      this.pluginSummary = { ...this.pluginSummary, state: "loaded", compatibilityLevel: 1 };
      this.record("plugin", "Injected the open compatibility module and constructed the plugin.");

      await this.plugin.onload();
      this.pluginSummary = { ...this.pluginSummary, compatibilityLevel: 2 };
      this.record("plugin", "Plugin onload completed without an uncaught error.");

      const commands = this.app.commands.list();
      if (commands.length > 0) {
        this.pluginSummary = { ...this.pluginSummary, compatibilityLevel: 3 };
        for (const command of commands) {
          this.record("command", `Registered command: ${command.name}.`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.pluginSummary = {
        ...this.pluginSummary,
        state: "failed",
      };
      this.record("error", `Plugin load failed: ${message}`);
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
    if (this.pluginSummary) {
      this.pluginSummary = { ...this.pluginSummary, compatibilityLevel: 4 };
    }
    return this.getSnapshot();
  }

  async unloadPlugin(): Promise<RuntimeSnapshot> {
    const wasActive = this.pluginSummary?.state !== "unloaded";

    if (this.plugin) {
      await this.plugin.__unload();
      this.plugin = null;
    }

    if (this.pluginSummary && wasActive) {
      this.pluginSummary = { ...this.pluginSummary, state: "unloaded", compatibilityLevel: 1 };
      this.record("plugin", `Unloaded ${this.pluginSummary.name} and released its registrations.`);
    }

    return this.getSnapshot();
  }

  async reloadPlugin(): Promise<RuntimeSnapshot> {
    if (!this.pluginDirectory) {
      throw new Error("No plugin has been loaded yet.");
    }

    const directory = this.pluginDirectory;
    return this.loadPlugin(directory);
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    return {
      vault: {
        name: this.vault.getName(),
        markdownFileCount: (await this.vault.getMarkdownFiles()).length,
        mode: "synthetic-read-only",
      },
      plugin: this.pluginSummary ? { ...this.pluginSummary } : null,
      commands: this.app.commands.list(),
      notices: this.app.notices.list(),
      events: this.events.map((event) => ({ ...event })),
    };
  }

  private async evaluatePlugin(entryPath: string): Promise<PluginConstructor> {
    const source = await fs.readFile(entryPath, "utf8");
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
    const raw = await fs.readFile(manifestPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Plugin manifest must be an object.");
    }

    const manifest = parsed as Record<string, unknown>;
    for (const field of ["id", "name", "version"] as const) {
      if (typeof manifest[field] !== "string" || manifest[field].length === 0) {
        throw new Error(`Plugin manifest requires a non-empty ${field}.`);
      }
    }

    return manifest as unknown as PluginManifest;
  }

  private assertInsideVault(candidatePath: string): string {
    const resolved = path.resolve(candidatePath);
    const relative = path.relative(this.vault.rootPath, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Plugin directory must be inside the active vault.");
    }
    return resolved;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile();
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
