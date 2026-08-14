import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActionRegistry } from "../application/action-registry";
import { isPathInside } from "../kernel/path-policy";
import type { VaultReadPort } from "../kernel/ports";
import type {
  PluginEditorContext,
  PluginEditorUpdate,
  PluginMutationWaitOptions,
  PluginSummary,
  RuntimeEvent,
  RuntimeEventKind,
  RuntimeSnapshot,
} from "../shared/contracts";
import {
  attachedPluginDiagnosticCode,
  createPluginDiagnostic,
  pluginDiagnosticError,
  withPluginDiagnosticCode,
} from "../shared/plugin-diagnostics";
import { maxPluginBundleBytes, parsePluginManifest } from "../shared/plugins";
import {
  App,
  CommandRegistry,
  type CompatibilityVaultWritePort,
  createObsidianCompatibilityModule,
  MarkdownRenderer,
  NoticeBus,
  normalizePath,
  Plugin,
  type PluginManifest,
  sleep,
  Vault,
} from "./obsidian-compat";
import { Component } from "./obsidian-components";
import { FileView, MarkdownView, WorkspaceLeaf } from "./obsidian-ui-compat";
import type { CompatibilitySettingTab } from "./obsidian-workspace-compat";
import type { PluginRuntimePort } from "./plugin-runtime-port";

interface CommonJsModuleRecord {
  exports: unknown;
}

type PluginConstructor = new (app: App, manifest: PluginManifest) => Plugin;

interface LoadedPluginRecord {
  directoryPath: string;
  expectedBundleSha256: string | undefined;
  instance: Plugin | null;
  summary: PluginSummary;
}

/**
 * Matches the note-embed service's 8 MiB aggregate returned-Markdown budget
 * (`DEFAULT_VAULT_NOTE_EMBED_MAX_BYTES` is 2 MiB per source note, but a full preview's returned
 * content is bounded at 8 MiB). A settled projection's HTML can exceed its Markdown input due to
 * tag/attribute overhead, so the note-embed *output* budget, not its per-source-note input budget,
 * is the closer sibling cap for this feature's own output.
 */
export const maxMarkdownProjectionHtmlBytes = 8 * 1024 * 1024;

const compatibilityHostModuleRoots = [
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  "@zsviczian/excalidraw",
  "react",
  "react-dom",
] as const;

export type PluginModuleResolver = NodeJS.Require;

function isCompatibilityHostModule(request: string): boolean {
  return compatibilityHostModuleRoots.some(
    (moduleRoot) => request === moduleRoot || request.startsWith(`${moduleRoot}/`),
  );
}

export class PluginHost implements PluginRuntimePort {
  readonly app: App;
  readonly vault: Vault;

  private readonly events: RuntimeEvent[] = [];
  private eventSequence = 0;
  private readonly plugins = new Map<string, LoadedPluginRecord>();
  private activePluginLeaf: WorkspaceLeaf | null = null;
  private activeSettingTab: CompatibilitySettingTab | null = null;
  private activeSettingTabContainer: HTMLElement | null = null;
  private activeSettingTabPluginId: string | null = null;
  private editorUpdate: PluginEditorUpdate | null = null;
  private editorUpdateSequence = 0;
  private lastPluginId: string | null = null;
  private nativeEditorContext: PluginEditorContext | null = null;
  private nativeMarkdownLeaf: WorkspaceLeaf | null = null;
  private nativeMarkdownView: MarkdownView | null = null;
  private readonly pluginModuleResolver: PluginModuleResolver | undefined;

  constructor(
    vaultPath: string,
    reader?: VaultReadPort,
    actions = new ActionRegistry(),
    pluginModuleResolver?: PluginModuleResolver,
    writer?: CompatibilityVaultWritePort,
  ) {
    this.vault = new Vault(vaultPath, reader, writer);
    this.pluginModuleResolver = pluginModuleResolver;
    const commands = new CommandRegistry(actions);
    const notices = new NoticeBus((message) => this.record("notice", message));
    this.app = new App(this.vault, commands, notices);
    this.app.workspace.setLeafFactory((containerEl) => new WorkspaceLeaf(this.app, containerEl));
    this.app.workspace.setLayoutReadyErrorHandler((_error) => {
      this.record("error", createPluginDiagnostic("runtime-load-failed").message);
    });
    this.record("runtime", `Opened synthetic vault ${this.vault.getName()} in read-only mode.`);
  }

  async loadPlugin(
    pluginDirectory: string,
    expectedBundleSha256?: string,
  ): Promise<RuntimeSnapshot> {
    try {
      return await this.loadPluginUnsafe(pluginDirectory, expectedBundleSha256);
    } catch (error) {
      const pluginId = path.basename(pluginDirectory);
      const code = attachedPluginDiagnosticCode(error) ?? "runtime-load-failed";
      throw pluginDiagnosticError(code, { pluginId }, error);
    }
  }

  private async loadPluginUnsafe(
    pluginDirectory: string,
    expectedBundleSha256?: string,
  ): Promise<RuntimeSnapshot> {
    if (expectedBundleSha256 && !/^[a-f0-9]{64}$/u.test(expectedBundleSha256)) {
      throw new Error("Plugin execution requires a lowercase SHA-256 bundle digest.");
    }
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
      expectedBundleSha256,
      instance: null,
      summary: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        state: "empty",
        compatibilityLevel: 0,
        stylesheetDiscovered,
        error: null,
        errorCode: null,
      },
    };
    this.plugins.set(manifest.id, record);
    this.lastPluginId = manifest.id;
    this.record("plugin", `Discovered ${manifest.name} ${manifest.version}.`);

    let instance: Plugin | null = null;
    try {
      const PluginClass = await this.evaluatePlugin(entryPath, expectedBundleSha256);
      instance = new PluginClass(this.app, manifest);
      if (!(instance instanceof Plugin)) {
        throw new Error("Plugin export does not extend the compatibility Plugin class.");
      }
      record.instance = instance;
      this.app.plugins.register(manifest, instance);
      record.summary = { ...record.summary, state: "loaded", compatibilityLevel: 1 };
      this.record("plugin", "Injected the open compatibility module and constructed the plugin.");

      const commandIdsBefore = new Set(this.app.commands.list().map(({ id }) => id));
      await instance.__load();
      await this.app.workspace.waitForLayoutReadyCallbacks();
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
      await instance?.__unload().catch(() => undefined);
      this.app.plugins.unregister(manifest.id);
      record.instance = null;
      const diagnosticCode = attachedPluginDiagnosticCode(error) ?? "runtime-load-failed";
      record.summary = {
        ...record.summary,
        state: "failed",
        error: createPluginDiagnostic(diagnosticCode, { pluginId: manifest.id }).message,
        errorCode: diagnosticCode,
      };
      this.record(
        "error",
        createPluginDiagnostic(diagnosticCode, { pluginId: manifest.id }).message,
      );
      throw pluginDiagnosticError(diagnosticCode, { pluginId: manifest.id }, error);
    }

    return this.getSnapshot();
  }

  async runCommand(
    commandId: string,
    editorContext?: PluginEditorContext,
  ): Promise<RuntimeSnapshot> {
    const command = this.app.commands.list().find(({ id }) => id === commandId);
    const ownerId = this.app.commands.ownerIdFor(commandId);
    try {
      const canRunInCurrentView = await this.app.commands.canRun(commandId);
      const shouldUseEditorContext =
        editorContext &&
        (!canRunInCurrentView || this.app.workspace.activeLeaf === this.nativeMarkdownLeaf);
      if (shouldUseEditorContext) {
        await this.openNativeEditorContext(editorContext);
      } else {
        this.editorUpdate = null;
      }
      const ran = await this.app.commands.run(commandId);
      if (!ran || !command) {
        throw new Error("command is not available");
      }
      await this.vault.waitForSettledMutations();
      this.captureEditorUpdate();

      this.record("command", `Ran command: ${command.name}.`);
      const record = ownerId ? this.plugins.get(ownerId) : undefined;
      if (record) {
        record.summary = { ...record.summary, compatibilityLevel: 4 };
        this.lastPluginId = ownerId ?? this.lastPluginId;
      }
      return this.getSnapshot();
    } catch (error) {
      throw pluginDiagnosticError(
        "runtime-command-failed",
        ownerId ? { pluginId: ownerId } : {},
        error,
      );
    }
  }

  async waitForPluginMutations(options?: PluginMutationWaitOptions): Promise<RuntimeSnapshot> {
    await this.vault.waitForPluginMutations(options);
    return this.getSnapshot();
  }

  /**
   * Execute `pluginId`'s currently registered Markdown post processors against `content` through
   * the same `MarkdownRenderer.render` path plugins use, then discard the ephemeral render
   * component. The settled (already-awaited, non-live) HTML crosses back on the snapshot; no DOM
   * node, callback, or live render child survives this call. The returned `html` is NOT
   * sanitized -- the processor mutates the DOM after `MarkdownRenderer.render`'s own
   * script/attribute stripping already ran, so nothing re-sanitizes what it added before this
   * method captures `element.innerHTML`. Callers must treat it as untrusted plugin output.
   * Rejects rather than returning a partial snapshot when the plugin is not loaded, its processor
   * throws, or the settled HTML exceeds {@link maxMarkdownProjectionHtmlBytes}, so a caller never
   * mistakes an unprocessed, partial, or oversized result for a settled one.
   */
  async renderMarkdownProjection(
    pluginId: string,
    sourcePath: string,
    content: string,
  ): Promise<RuntimeSnapshot> {
    const record = this.plugins.get(pluginId);
    if (record?.summary.state !== "loaded" || !record.instance) {
      throw pluginDiagnosticError(
        "runtime-render-failed",
        { pluginId },
        new Error(`Plugin is not loaded: ${pluginId}`),
      );
    }
    if (typeof document === "undefined") {
      throw new Error("Plugin markdown rendering requires a renderer document.");
    }
    const normalizedSourcePath = normalizePath(sourcePath);
    const contentSha256 = createHash("sha256").update(content, "utf8").digest("hex");
    const postProcessorCount = this.app.compatibility.snapshot().markdownPostProcessors;
    const component = new Component();
    component.load();
    const element = document.createElement("div");
    let html: string;
    try {
      await MarkdownRenderer.render(this.app, content, element, sourcePath, component);
      // Capture the settled markup before unloading: an `onunload` handler's job is releasing
      // resources (timers, listeners), not producing the rendered artifact, and must never be
      // able to erase evidence of what the processor actually rendered.
      html = element.innerHTML;
    } catch (error) {
      this.record("error", createPluginDiagnostic("runtime-render-failed", { pluginId }).message);
      throw pluginDiagnosticError("runtime-render-failed", { pluginId }, error);
    } finally {
      // The projection is settled and captured above; nothing will call back into this component
      // afterward, so its render children release deterministically right here.
      component.unload();
    }
    const htmlBytes = Buffer.byteLength(html, "utf8");
    if (htmlBytes > maxMarkdownProjectionHtmlBytes) {
      this.record(
        "error",
        createPluginDiagnostic("runtime-render-too-large", { pluginId }).message,
      );
      // A distinct diagnostic code, not a message-text convention: pluginDiagnosticError always
      // reconstructs its thrown message from the stable per-code template (see
      // plugin-diagnostics.ts), discarding whatever wording the `cause` below carries. The code
      // survives IPC only inside that reconstructed message's `[code].` suffix -- see
      // parsePluginDiagnosticMessage, which plugin-markdown-projection-service.ts uses to recover
      // it reliably rather than pattern-matching arbitrary freeform text.
      throw pluginDiagnosticError(
        "runtime-render-too-large",
        { pluginId },
        new Error(
          `Settled Markdown projection is ${htmlBytes} bytes, exceeding the ${maxMarkdownProjectionHtmlBytes} byte limit.`,
        ),
      );
    }
    this.record("plugin", `Rendered a settled Markdown projection for ${record.summary.name}.`);
    const snapshot = await this.getSnapshot();
    return {
      ...snapshot,
      markdownProjection: {
        contentSha256,
        html,
        pluginId,
        postProcessorCount,
        sourcePath: normalizedSourcePath,
      },
    };
  }

  private async openNativeEditorContext(context: PluginEditorContext): Promise<void> {
    await this.nativeMarkdownLeaf?.detach();
    this.nativeMarkdownLeaf = null;
    this.nativeMarkdownView = null;
    this.nativeEditorContext = null;
    this.editorUpdate = null;
    if (typeof document === "undefined") {
      throw new Error("Native editor compatibility requires a renderer document.");
    }
    const container = document.createElement("div");
    container.className = "threadleaf-native-editor-context workspace-leaf";
    const leaf = new WorkspaceLeaf(this.app, container);
    await leaf.setViewState({ type: "markdown", state: { file: context.path } });
    if (!(leaf.view instanceof MarkdownView)) {
      await leaf.detach();
      throw new Error("Native editor compatibility could not open a Markdown view.");
    }
    leaf.view.setViewData(context.content, true);
    leaf.view.editor.setSelectionOffsets(context.selection.anchor, context.selection.head);
    this.nativeMarkdownLeaf = leaf;
    this.nativeMarkdownView = leaf.view;
    this.nativeEditorContext = {
      ...context,
      selection: { ...context.selection },
    };
  }

  private captureEditorUpdate(): void {
    const context = this.nativeEditorContext;
    const view = this.nativeMarkdownView;
    if (!context || !view) {
      return;
    }
    this.editorUpdateSequence += 1;
    this.editorUpdate = {
      baseContent: context.content,
      content: view.editor.getValue(),
      focused: view.editor.hasFocus(),
      id: `threadleaf-plugin-editor-${this.editorUpdateSequence}`,
      path: context.path,
      revision: context.revision,
      selection: view.editor.getSelectionOffsets(),
    };
  }

  async markLayoutReady(): Promise<RuntimeSnapshot> {
    try {
      await this.app.workspace.markLayoutReady();
      this.record("runtime", "Plugin workspace layout became ready.");
      return this.getSnapshot();
    } catch (error) {
      const diagnostic = createPluginDiagnostic("runtime-load-failed");
      this.record("error", diagnostic.message);
      throw pluginDiagnosticError("runtime-load-failed", {}, error);
    }
  }

  async openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot> {
    await this.closePluginView();
    if (typeof document === "undefined") {
      throw new Error("Plugin views require a renderer document.");
    }
    const container = document.createElement("div");
    container.id = "threadleaf-plugin-surface";
    container.className = "threadleaf-plugin-surface workspace-leaf mod-active";
    document.body.append(container);
    const leaf = new WorkspaceLeaf(this.app, container);
    this.activePluginLeaf = leaf;
    try {
      await leaf.setViewState({
        type: viewType,
        state: filePath ? { file: filePath } : {},
      });
      this.record(
        "runtime",
        `Opened plugin view ${viewType}${filePath ? ` for ${filePath}` : ""}.`,
      );
      return this.getSnapshot();
    } catch (error) {
      this.activePluginLeaf = null;
      await leaf.detach().catch(() => undefined);
      throw pluginDiagnosticError("runtime-view-failed", {}, error);
    }
  }

  async openPluginSettings(pluginId: string): Promise<RuntimeSnapshot> {
    await this.closePluginView();
    if (typeof document === "undefined") {
      throw new Error("Plugin settings require a renderer document.");
    }
    const record = this.plugins.get(pluginId);
    if (record?.summary.state !== "loaded") {
      throw new Error(`Plugin is not loaded: ${pluginId}`);
    }
    const settingTab = this.app.compatibility.getSettingTab(pluginId);
    if (!settingTab) {
      throw new Error(`Plugin does not expose a settings tab: ${pluginId}`);
    }
    const container = document.createElement("div");
    container.id = "threadleaf-plugin-surface";
    container.className = "threadleaf-plugin-surface threadleaf-plugin-settings-surface";
    container.append(settingTab.containerEl);
    document.body.append(container);
    this.activeSettingTab = settingTab;
    this.activeSettingTabContainer = container;
    this.activeSettingTabPluginId = pluginId;
    try {
      await Promise.resolve(settingTab.display());
      this.record("runtime", `Opened ${record.summary.name} settings.`);
      return this.getSnapshot();
    } catch (error) {
      this.activeSettingTab = null;
      this.activeSettingTabContainer = null;
      this.activeSettingTabPluginId = null;
      await Promise.resolve(settingTab.hide()).catch(() => undefined);
      container.remove();
      throw pluginDiagnosticError("runtime-settings-failed", { pluginId }, error);
    }
  }

  async closePluginView(): Promise<RuntimeSnapshot> {
    const settingTab = this.activeSettingTab;
    const settingTabContainer = this.activeSettingTabContainer;
    const settingTabPluginId = this.activeSettingTabPluginId;
    this.activeSettingTab = null;
    this.activeSettingTabContainer = null;
    this.activeSettingTabPluginId = null;
    if (settingTab) {
      try {
        await Promise.resolve(settingTab.hide());
      } catch (_error) {
        this.record(
          "error",
          createPluginDiagnostic(
            "runtime-unload-failed",
            settingTabPluginId ? { pluginId: settingTabPluginId } : {},
          ).message,
        );
      }
      settingTabContainer?.remove();
      const pluginName = settingTabPluginId
        ? (this.plugins.get(settingTabPluginId)?.summary.name ?? settingTabPluginId)
        : "Plugin";
      this.record("runtime", `Closed ${pluginName} settings.`);
    }
    const leaves: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf instanceof WorkspaceLeaf) {
        leaves.push(leaf);
      }
    });
    const viewType =
      (this.app.workspace.activeLeaf instanceof WorkspaceLeaf
        ? this.app.workspace.activeLeaf.view?.getViewType()
        : this.activePluginLeaf?.view?.getViewType()) ?? "unknown";
    this.activePluginLeaf = null;
    if (leaves.length > 0) {
      for (const leaf of leaves.reverse()) {
        await leaf.detach();
      }
      this.record("runtime", `Closed plugin view ${viewType}.`);
    }
    this.nativeMarkdownLeaf = null;
    this.nativeMarkdownView = null;
    this.nativeEditorContext = null;
    this.editorUpdate = null;
    return this.getSnapshot();
  }

  async unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    await this.closePluginView();
    const targetId = pluginId ?? this.lastPluginId;
    const record = targetId ? this.plugins.get(targetId) : undefined;
    if (!record || record.summary.state === "unloaded") {
      return this.getSnapshot();
    }
    const modalCloseFailure = this.app.closePluginModals(record.summary.id);
    let unloadError: string | null = null;
    try {
      await record.instance?.__unload();
    } catch (_error) {
      unloadError = createPluginDiagnostic("runtime-unload-failed", {
        pluginId: record.summary.id,
      }).message;
    }
    record.instance = null;
    this.app.plugins.unregister(record.summary.id);
    record.summary = {
      ...record.summary,
      state: "unloaded",
      compatibilityLevel: 1,
      error:
        unloadError ??
        (modalCloseFailure
          ? createPluginDiagnostic("runtime-unload-failed", {
              pluginId: record.summary.id,
            }).message
          : null),
      errorCode: unloadError || modalCloseFailure ? "runtime-unload-failed" : null,
    };
    this.lastPluginId = targetId ?? this.lastPluginId;
    this.record("plugin", `Unloaded ${record.summary.name} and released its registrations.`);
    if (unloadError) {
      this.record(
        "error",
        createPluginDiagnostic("runtime-unload-failed", { pluginId: record.summary.id }).message,
      );
    } else if (modalCloseFailure) {
      this.record(
        "error",
        createPluginDiagnostic("runtime-unload-failed", { pluginId: record.summary.id }).message,
      );
    }
    return this.getSnapshot();
  }

  async unloadAllPlugins(): Promise<RuntimeSnapshot> {
    for (const pluginId of [...this.plugins.keys()]) {
      await this.unloadPlugin(pluginId);
    }
    return this.getSnapshot();
  }

  async close(): Promise<void> {
    await this.closePluginView();
    await this.unloadAllPlugins();
  }

  async reloadPlugin(pluginId?: string): Promise<RuntimeSnapshot> {
    const targetId = pluginId ?? this.lastPluginId;
    const record = targetId ? this.plugins.get(targetId) : undefined;
    if (!record) {
      throw new Error("No plugin has been loaded yet.");
    }
    return this.loadPlugin(record.directoryPath, record.expectedBundleSha256);
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    const plugins = [...this.plugins.values()]
      .map(({ summary }) => ({ ...summary }))
      .sort((left, right) => left.name.localeCompare(right.name, "en-US", { numeric: true }));
    const currentPlugin = this.lastPluginId
      ? (plugins.find(({ id }) => id === this.lastPluginId) ?? null)
      : null;
    const activePluginLeaf =
      this.app.workspace.activeLeaf instanceof WorkspaceLeaf
        ? this.app.workspace.activeLeaf
        : this.activePluginLeaf;
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
      integrations: this.app.compatibility.snapshot(),
      editorUpdate: this.editorUpdate ? structuredClone(this.editorUpdate) : null,
      pluginSurface:
        this.activeSettingTab && this.activeSettingTabPluginId
          ? {
              displayText: `${this.plugins.get(this.activeSettingTabPluginId)?.summary.name ?? this.activeSettingTabPluginId} settings`,
              filePath: null,
              viewType: "threadleaf-plugin-settings",
            }
          : activePluginLeaf?.view && activePluginLeaf !== this.nativeMarkdownLeaf
            ? {
                displayText: activePluginLeaf.view.getDisplayText(),
                filePath:
                  activePluginLeaf.view instanceof FileView && activePluginLeaf.view.file
                    ? activePluginLeaf.view.file.path
                    : null,
                viewType: activePluginLeaf.view.getViewType(),
              }
            : null,
    };
  }

  private async evaluatePlugin(
    entryPath: string,
    expectedBundleSha256?: string,
  ): Promise<PluginConstructor> {
    const bundleBytes = await this.readBoundedBytes(entryPath, maxPluginBundleBytes);
    if (expectedBundleSha256) {
      const actualBundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");
      if (actualBundleSha256 !== expectedBundleSha256) {
        throw withPluginDiagnosticCode(
          new Error(
            "Plugin main.js changed after authority review and was blocked before execution.",
          ),
          "managed-package-changed",
        );
      }
    }
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bundleBytes);
    const nativeRequire = createRequire(entryPath);
    const compatibilityModule = createObsidianCompatibilityModule(this.app);
    const moduleRecord: CommonJsModuleRecord = { exports: {} };

    const pluginRequire = ((request: string) => {
      if (request === "obsidian") {
        return compatibilityModule;
      }
      if (this.pluginModuleResolver && isCompatibilityHostModule(request)) {
        return this.pluginModuleResolver(request);
      }
      return nativeRequire(request);
    }) as NodeJS.Require;

    pluginRequire.resolve = ((request: string, options?: { paths?: string[] }) => {
      if (request === "obsidian") {
        return "obsidian";
      }
      if (this.pluginModuleResolver && isCompatibilityHostModule(request)) {
        return this.pluginModuleResolver.resolve(request, options);
      }
      return nativeRequire.resolve(request, options);
    }) as NodeJS.RequireResolve;
    pluginRequire.cache = nativeRequire.cache;
    pluginRequire.extensions = nativeRequire.extensions;
    pluginRequire.main = nativeRequire.main;

    const sourceUrl = pathToFileURL(entryPath).href;
    const compiled = new Function(
      "exports",
      "require",
      "module",
      "__filename",
      "__dirname",
      "sleep",
      `${source}\n//# sourceURL=${sourceUrl}`,
    );
    compiled(
      moduleRecord.exports,
      pluginRequire,
      moduleRecord,
      entryPath,
      path.dirname(entryPath),
      sleep,
    );

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
      throw withPluginDiagnosticCode(
        new Error(
          "Plugin directory must be an immediate child of .obsidian/plugins in the active vault.",
        ),
        "package-path-escape",
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

  private async readBoundedBytes(filePath: string, maxBytes: number): Promise<Buffer> {
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
    return bytes;
  }

  private async readBoundedText(filePath: string, maxBytes: number): Promise<string> {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.readBoundedBytes(filePath, maxBytes),
    );
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
