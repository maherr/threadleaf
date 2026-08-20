import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  promises as fs,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ActionRegistry } from "../application/action-registry";
import { readStableFileWithinLimit } from "../kernel/durability";
import { isPathInside } from "../kernel/path-policy";
import type { VaultReadPort } from "../kernel/ports";
import { authorityJsonSha256 } from "../shared/authority-json";
import type {
  PluginEditorContext,
  PluginEditorEventSnapshot,
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
import {
  compareCanonicalPluginPackagePaths,
  type ExactPluginPackageIdentity,
  isPluginConstructionRefusal,
  isPluginDistributionPathIncluded,
  maxPluginBundleBytes,
  type PluginCapabilityId,
  type PluginConstructionDispatch,
  PluginConstructionRefusal,
  type PluginConstructionRequest,
  parsePluginManifest,
} from "../shared/plugins";
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
  TFile,
  Vault,
} from "./obsidian-compat";
import { Component } from "./obsidian-components";
import type { EditorCompatibilityFields } from "./obsidian-editor-compat";
import {
  createElectronCompatibilityModule,
  ElectronCompatibilityActivity,
} from "./obsidian-electron-compat";
import { FileView, MarkdownView, WorkspaceLeaf } from "./obsidian-ui-compat";
import type { CompatibilitySettingTab } from "./obsidian-workspace-compat";
import type { PluginRuntimePort } from "./plugin-runtime-port";

interface CommonJsModuleRecord {
  exports: unknown;
}

interface VerifiedPluginPackageFile {
  sha256: string;
  size: number;
}

type PluginConstructor = new (app: App, manifest: PluginManifest) => Plugin;

interface LoadedPluginRecord {
  directoryPath: string;
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

export interface PluginHostOptions {
  compatibilityEditorFields?: EditorCompatibilityFields;
  onEditorExtensionsChange?(extensions: readonly unknown[]): void;
  onOpenFile?(filePath: string): void | Promise<void>;
  onSurfaceChange?(): void;
}

interface PluginProjectionSettleOptions {
  quietMs?: number;
  timeoutMs?: number;
}

function hasLoadingProjectionPlaceholder(element: HTMLElement): boolean {
  return [element, ...element.querySelectorAll("*")].some(
    (candidate) => candidate.textContent?.trim() === "Loading...",
  );
}

/**
 * Markdown render children are live components and Obsidian does not await their async onload
 * hooks. A returned compatibility projection cannot keep that live realm attached, so hold the
 * bounded request through its loading placeholder and a short DOM-quiet window before capture.
 */
export async function waitForSettledPluginProjectionElement(
  element: HTMLElement,
  options: PluginProjectionSettleOptions = {},
): Promise<void> {
  const rendererWindow = element.ownerDocument.defaultView;
  const MutationObserverType = rendererWindow?.MutationObserver;
  if (!rendererWindow || !MutationObserverType) {
    if (process.env.THREADLEAF_PLUGIN_E2E_DIAGNOSTICS === "1") {
      console.debug("Compatibility Markdown projection has no DOM settle observer.");
    }
    return;
  }
  const quietMs = options.quietMs ?? 75;
  const timeoutMs = options.timeoutMs ?? 12_000;
  if (process.env.THREADLEAF_PLUGIN_E2E_DIAGNOSTICS === "1") {
    console.debug("Compatibility Markdown projection settle started.", {
      loading: hasLoadingProjectionPlaceholder(element),
      quietMs,
      timeoutMs,
    });
  }
  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    let lastMutationAt = startedAt;
    let timer = 0;
    const finish = (observer: MutationObserver, error?: Error) => {
      observer.disconnect();
      rendererWindow.clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    let scheduleCheck = () => undefined;
    const observer = new MutationObserverType(() => {
      lastMutationAt = Date.now();
      scheduleCheck();
    });
    const check = () => {
      const now = Date.now();
      if (now - startedAt >= timeoutMs) {
        finish(
          observer,
          hasLoadingProjectionPlaceholder(element)
            ? new Error("Plugin Markdown projection did not settle its loading state.")
            : undefined,
        );
        return;
      }
      if (!hasLoadingProjectionPlaceholder(element) && now - lastMutationAt >= quietMs) {
        finish(observer);
        return;
      }
      scheduleCheck();
    };
    scheduleCheck = () => {
      rendererWindow.clearTimeout(timer);
      const now = Date.now();
      const nextQuietAt = lastMutationAt + quietMs;
      const deadline = startedAt + timeoutMs;
      timer = rendererWindow.setTimeout(check, Math.max(1, Math.min(nextQuietAt, deadline) - now));
    };
    observer.observe(element, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    scheduleCheck();
  });
}

export const maxConsumedPluginConstructionAttempts = 4_096;

const networkBuiltinRoots = new Set(["dgram", "dns", "http", "http2", "https", "net", "tls"]);
const subprocessBuiltinRoots = new Set(["child_process", "cluster", "worker_threads"]);
const dynamicCodeBuiltinRoots = new Set(["inspector", "module", "repl", "v8", "vm"]);

// Every reviewed Phase 0 profile discloses all authorities mapped here. This is forward-looking
// enforcement for narrower profiles, not an active discriminator among the current profiles.
function builtinAuthority(request: string): PluginCapabilityId | null {
  const normalized = request.startsWith("node:") ? request.slice(5) : request;
  if (!isBuiltin(request)) {
    return null;
  }
  const root = normalized.split("/", 1)[0] ?? normalized;
  if (root === "fs" || root === "sqlite") {
    return "filesystem";
  }
  if (networkBuiltinRoots.has(root)) {
    return "network";
  }
  if (subprocessBuiltinRoots.has(root)) {
    return "subprocess";
  }
  if (dynamicCodeBuiltinRoots.has(root)) {
    return "dynamic-code";
  }
  return "host-environment";
}

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
  private editorEvent: PluginEditorEventSnapshot | null = null;
  private editorUpdateSequence = 0;
  private lastPluginId: string | null = null;
  private nativeEditorContext: PluginEditorContext | null = null;
  private nativeMarkdownLeaf: WorkspaceLeaf | null = null;
  private nativeMarkdownView: MarkdownView | null = null;
  private readonly pluginModuleResolver: PluginModuleResolver | undefined;
  private readonly electronCompatibilityActivity = new ElectronCompatibilityActivity();
  private readonly consumedConstructionAttempts = new Set<string>();
  private readonly compatibilityEditorFields: EditorCompatibilityFields | undefined;
  private readonly onEditorExtensionsChange: ((extensions: readonly unknown[]) => void) | undefined;
  private editorExtensionNoticeRecorded = false;

  constructor(
    vaultPath: string,
    reader?: VaultReadPort,
    actions = new ActionRegistry(),
    pluginModuleResolver?: PluginModuleResolver,
    writer?: CompatibilityVaultWritePort,
    options?: PluginHostOptions,
  ) {
    this.vault = new Vault(vaultPath, reader, writer);
    this.pluginModuleResolver = pluginModuleResolver;
    this.compatibilityEditorFields = options?.compatibilityEditorFields;
    this.onEditorExtensionsChange = options?.onEditorExtensionsChange;
    const commands = new CommandRegistry(actions);
    const notices = new NoticeBus((message) => this.record("notice", message));
    this.app = new App(this.vault, commands, notices);
    this.app.workspace.setLeafFactory((containerEl) => {
      if (containerEl) this.mountPluginSurfaceContainer(containerEl);
      return new WorkspaceLeaf(this.app, containerEl);
    });
    this.app.workspace.setLayoutReadyErrorHandler((_error) => {
      this.record("error", createPluginDiagnostic("runtime-load-failed").message);
    });
    this.app.compatibility.setEditorExtensionChangeListener((extensions) => {
      if (this.onEditorExtensionsChange) {
        this.onEditorExtensionsChange(extensions);
        return;
      }
      if (extensions.length > 0 && !this.editorExtensionNoticeRecorded) {
        this.editorExtensionNoticeRecorded = true;
        this.record(
          "runtime",
          "Editor extensions are registered but unavailable in isolated compatibility mode.",
        );
      }
    });
    this.app.workspace.on("file-open", (file) => {
      if (
        file instanceof TFile &&
        this.app.workspace.activeLeaf !== this.nativeMarkdownLeaf &&
        options?.onOpenFile
      ) {
        void Promise.resolve(options.onOpenFile(file.path)).catch((error) => {
          this.record(
            "error",
            `Plugin file navigation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    });
    if (options?.onSurfaceChange) {
      this.app.setPluginModalChangeListener(options.onSurfaceChange);
    }
    this.record("runtime", `Opened synthetic vault ${this.vault.getName()} in read-only mode.`);
  }

  loadPlugin(request: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    return Promise.reject(new PluginConstructionRefusal(this.directLoadRefusalPolicy(request)));
  }

  async loadAuthorizedPlugin(dispatch: PluginConstructionDispatch): Promise<RuntimeSnapshot> {
    try {
      await this.vault.initialize();
      return await this.loadPluginUnsafe(dispatch);
    } catch (error) {
      if (isPluginConstructionRefusal(error)) {
        throw error;
      }
      const pluginId = dispatch?.policy?.packageIdentity?.pluginId ?? "unknown-plugin";
      const code = attachedPluginDiagnosticCode(error) ?? "runtime-load-failed";
      throw pluginDiagnosticError(code, { pluginId }, error);
    }
  }

  private async loadPluginUnsafe(dispatch: PluginConstructionDispatch): Promise<RuntimeSnapshot> {
    this.assertConstructionDispatch(dispatch);
    const { pluginDirectory, policy } = dispatch;
    const resolvedDirectory = dispatch.packageFiles
      ? pluginDirectory
      : await this.assertSealedPackageRoot(pluginDirectory);
    const manifestPath = path.join(resolvedDirectory, "manifest.json");
    const entryPath = path.join(resolvedDirectory, "main.js");
    const packageBytes = dispatch.packageFiles
      ? new Map(dispatch.packageFiles.map((file) => [file.path, new Uint8Array(file.bytes)]))
      : undefined;
    const verifiedFiles = dispatch.packageFiles
      ? new Map(
          dispatch.packageFiles.map(({ path: filePath, sha256, size }) => [
            filePath,
            { sha256, size },
          ]),
        )
      : await this.verifyPackageIdentity(resolvedDirectory, policy);
    const manifest = this.readManifest(
      manifestPath,
      resolvedDirectory,
      verifiedFiles,
      packageBytes,
    );
    if (
      manifest.id !== policy.packageIdentity.pluginId ||
      manifest.version !== policy.packageIdentity.manifestVersion
    ) {
      throw new PluginConstructionRefusal(this.identityMismatchPolicy(policy));
    }
    const stylesheetDiscovered = verifiedFiles.has("styles.css");
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
        errorCode: null,
      },
    };
    this.plugins.set(manifest.id, record);
    this.syncEditorExtensionOwnerOrder();
    this.lastPluginId = manifest.id;
    this.record("plugin", `Discovered ${manifest.name} ${manifest.version}.`);

    let instance: Plugin | null = null;
    try {
      const PluginClass = await this.evaluatePlugin(
        entryPath,
        resolvedDirectory,
        policy,
        verifiedFiles,
        packageBytes,
      );
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
      if (isPluginConstructionRefusal(error)) {
        this.plugins.delete(manifest.id);
        this.syncEditorExtensionOwnerOrder();
        if (this.lastPluginId === manifest.id) {
          this.lastPluginId = null;
        }
        throw error;
      }
      if (process.env.THREADLEAF_PLUGIN_E2E_DIAGNOSTICS === "1") {
        console.error(`Compatibility plugin load failed: ${manifest.id}`, error);
      }
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
    this.editorEvent = null;
    const command = this.app.commands.list().find(({ id }) => id === commandId);
    const ownerId = this.app.commands.ownerIdFor(commandId);
    try {
      const canRunInCurrentView = await this.app.commands.canRun(commandId);
      const activeLeaf = this.app.workspace.activeLeaf;
      const hasPluginOwnedActiveView =
        activeLeaf !== null &&
        activeLeaf !== this.nativeMarkdownLeaf &&
        activeLeaf.view !== null &&
        activeLeaf.view.getViewType() !== "empty";
      const shouldUseEditorContext =
        editorContext &&
        typeof document !== "undefined" &&
        (!canRunInCurrentView || !hasPluginOwnedActiveView);
      if (shouldUseEditorContext) {
        await this.openNativeEditorContext(editorContext);
      } else {
        this.editorUpdate = null;
      }
      const releaseExecutionOwner = ownerId
        ? this.app.beginPluginExecution(ownerId)
        : () => undefined;
      let ran: boolean;
      try {
        ran = await this.app.commands.run(commandId);
      } finally {
        releaseExecutionOwner();
      }
      if (!ran || !command) {
        throw new Error("command is not available");
      }
      await this.electronCompatibilityActivity.waitForIdle();
      // Obsidian commands are allowed to start async vault work without returning its Promise.
      // Keep a short post-command quiet window so the returned snapshot reflects that work instead
      // of reporting success against the leaf and file that preceded the command.
      await this.vault.waitForSettledMutations(250, 10_000);
      this.captureEditorUpdate();

      this.record("command", `Ran command: ${command.name}.`);
      const record = ownerId ? this.plugins.get(ownerId) : undefined;
      if (record) {
        this.lastPluginId = ownerId ?? this.lastPluginId;
      }
      return this.getSnapshot();
    } catch (error) {
      if (process.env.THREADLEAF_PLUGIN_E2E_DIAGNOSTICS === "1") {
        console.error(`Compatibility command failed: ${commandId}`, error);
      }
      throw pluginDiagnosticError(
        "runtime-command-failed",
        ownerId ? { pluginId: ownerId } : {},
        error,
      );
    }
  }

  async runPluginEditorPaste(
    editorContext: PluginEditorContext,
    clipboardText: string,
  ): Promise<RuntimeSnapshot> {
    try {
      await this.openNativeEditorContext(editorContext);
      const view = this.nativeMarkdownView;
      if (!view || typeof document === "undefined") {
        throw new Error("Plugin paste delivery requires an active native Markdown editor.");
      }
      const EventConstructor = document.defaultView?.Event;
      if (!EventConstructor) {
        throw new Error("Plugin paste delivery requires a renderer Event constructor.");
      }
      const pasteEvent = new EventConstructor("paste", {
        bubbles: true,
        cancelable: true,
      }) as ClipboardEvent;
      Object.defineProperty(pasteEvent, "clipboardData", {
        configurable: false,
        enumerable: true,
        value: {
          getData: (format: string) =>
            format === "text" || format === "text/plain" ? clipboardText : "",
          types: ["text/plain"],
        },
        writable: false,
      });
      await this.app.workspace.triggerAsync("editor-paste", pasteEvent, view.editor, view);
      await this.electronCompatibilityActivity.waitForIdle();
      await this.vault.waitForSettledMutations(250, 10_000);
      this.captureEditorUpdate();
      this.editorEvent = { handled: pasteEvent.defaultPrevented, type: "paste" };
      this.record(
        "plugin",
        pasteEvent.defaultPrevented
          ? "A compatibility plugin handled the editor paste."
          : "Compatibility plugins left the editor paste unchanged.",
      );
      return this.getSnapshot();
    } catch (error) {
      throw pluginDiagnosticError("runtime-command-failed", {}, error);
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
    element.dataset.threadleafPluginProjectionStaging = "true";
    element.setAttribute("aria-hidden", "true");
    Object.assign(element.style, {
      left: "-100000px",
      pointerEvents: "none",
      position: "fixed",
      top: "0",
      visibility: "hidden",
      width: "960px",
    });
    document.body.append(element);
    let html: string;
    try {
      await MarkdownRenderer.render(this.app, content, element, sourcePath, component, pluginId);
      await waitForSettledPluginProjectionElement(element);
      // Capture the settled markup before unloading: an `onunload` handler's job is releasing
      // resources (timers, listeners), not producing the rendered artifact, and must never be
      // able to erase evidence of what the processor actually rendered.
      html = element.innerHTML;
    } catch (error) {
      if (process.env.THREADLEAF_PLUGIN_E2E_DIAGNOSTICS === "1") {
        console.error(`Compatibility Markdown projection failed: ${pluginId}`, error);
      }
      this.record("error", createPluginDiagnostic("runtime-render-failed", { pluginId }).message);
      throw pluginDiagnosticError("runtime-render-failed", { pluginId }, error);
    } finally {
      // The projection is settled and captured above; nothing will call back into this component
      // afterward, so its render children release deterministically right here.
      component.unload();
      element.remove();
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
    this.mountPluginSurfaceContainer(container);
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
    this.mountPluginSurfaceContainer(container);
    this.activeSettingTab = settingTab;
    this.activeSettingTabContainer = container;
    this.activeSettingTabPluginId = pluginId;
    try {
      const declarativeTab = settingTab as typeof settingTab & {
        renderSettingDefinitions?: () => void;
        settingItems?: unknown[];
        update?: () => void;
      };
      declarativeTab.update?.();
      if (
        Array.isArray(declarativeTab.settingItems) &&
        declarativeTab.settingItems.length > 0 &&
        typeof declarativeTab.renderSettingDefinitions === "function"
      ) {
        declarativeTab.renderSettingDefinitions();
      } else {
        await Promise.resolve(settingTab.display());
      }
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
    this.editorEvent = null;
    return this.getSnapshot();
  }

  private mountPluginSurfaceContainer(container: HTMLElement): void {
    container.classList.add("threadleaf-plugin-surface");
    const visibleHost = document.getElementById("plugin-surface-host");
    if (!visibleHost) {
      document.body.append(container);
      return;
    }
    Object.assign(container.style, {
      inset: "0",
      minHeight: "0",
      minWidth: "0",
      overflow: "hidden",
      position: "absolute",
    });
    visibleHost.append(container);
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
    this.syncEditorExtensionOwnerOrder();
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

  private syncEditorExtensionOwnerOrder(): void {
    this.app.compatibility.setEditorExtensionOwnerOrder([...this.plugins.keys()]);
  }

  async close(): Promise<void> {
    await this.closePluginView();
    await this.unloadAllPlugins();
  }

  reloadPlugin(request?: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    if (!request) {
      return Promise.reject(new Error("Plugin reload requires an exact construction request."));
    }
    return Promise.reject(new PluginConstructionRefusal(this.directLoadRefusalPolicy(request)));
  }

  async reloadAuthorizedPlugin(dispatch: PluginConstructionDispatch): Promise<RuntimeSnapshot> {
    const targetId = dispatch.policy.packageIdentity.pluginId;
    const record = targetId ? this.plugins.get(targetId) : undefined;
    if (!record) {
      throw new Error("No plugin has been loaded yet.");
    }
    return this.loadAuthorizedPlugin(dispatch);
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    await this.vault.initialize();
    const plugins = [...this.plugins.values()]
      .map(({ summary }) => ({ ...summary }))
      .sort((left, right) => left.name.localeCompare(right.name, "en-US", { numeric: true }));
    const currentPlugin = this.lastPluginId
      ? (plugins.find(({ id }) => id === this.lastPluginId) ?? null)
      : null;
    const workspaceActiveLeaf =
      this.app.workspace.activeLeaf instanceof WorkspaceLeaf ? this.app.workspace.activeLeaf : null;
    const workspaceActiveViewType = workspaceActiveLeaf?.view?.getViewType() ?? "empty";
    const activePluginLeaf =
      workspaceActiveLeaf === this.nativeMarkdownLeaf
        ? null
        : workspaceActiveLeaf && workspaceActiveViewType !== "empty"
          ? workspaceActiveLeaf
          : this.activePluginLeaf;
    const activePluginViewState = activePluginLeaf?.getViewState().state;
    const activePluginFilePath =
      activePluginLeaf?.view instanceof FileView && activePluginLeaf.view.file
        ? activePluginLeaf.view.file.path
        : typeof activePluginViewState?.file === "string" && activePluginViewState.file.length > 0
          ? activePluginViewState.file
          : null;
    const activeModalPluginId = this.app.activePluginModalOwnerId();
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
      integrations: {
        ...this.app.compatibility.snapshot(),
        workspaceEvents: this.app.workspace.eventNames(),
      },
      editorUpdate: this.editorUpdate ? structuredClone(this.editorUpdate) : null,
      editorEvent: this.editorEvent ? { ...this.editorEvent } : null,
      pluginSurface:
        this.activeSettingTab && this.activeSettingTabPluginId
          ? {
              displayText: `${this.plugins.get(this.activeSettingTabPluginId)?.summary.name ?? this.activeSettingTabPluginId} settings`,
              filePath: null,
              viewType: "threadleaf-plugin-settings",
            }
          : activeModalPluginId
            ? {
                displayText: `${this.plugins.get(activeModalPluginId)?.summary.name ?? activeModalPluginId} dialog`,
                filePath: null,
                viewType: "threadleaf-plugin-modal",
              }
            : activePluginLeaf?.view && activePluginLeaf !== this.nativeMarkdownLeaf
              ? {
                  displayText: activePluginLeaf.view.getDisplayText(),
                  filePath: activePluginFilePath,
                  viewType: activePluginLeaf.view.getViewType(),
                }
              : null,
    };
  }

  seedVaultMarkdownPaths(paths: readonly string[]): Promise<void> {
    return this.vault.seedMarkdownPaths(paths);
  }

  private async evaluatePlugin(
    entryPath: string,
    sealedPackageRoot: string,
    policy: PluginConstructionDispatch["policy"],
    verifiedFiles: ReadonlyMap<string, VerifiedPluginPackageFile>,
    packageBytes?: ReadonlyMap<string, Uint8Array>,
  ): Promise<PluginConstructor> {
    const bundleBytes = this.readVerifiedModuleBytes(
      entryPath,
      sealedPackageRoot,
      verifiedFiles,
      packageBytes,
    );
    const compatibilityModule = createObsidianCompatibilityModule(
      this.app,
      this.compatibilityEditorFields,
    );
    const moduleCache = new Map<string, CommonJsModuleRecord>();
    const loadSealedModule = (modulePath: string, knownBytes?: Uint8Array): unknown => {
      const cached = moduleCache.get(modulePath);
      if (cached) {
        return cached.exports;
      }
      const moduleRecord: CommonJsModuleRecord = { exports: {} };
      moduleCache.set(modulePath, moduleRecord);
      try {
        const nativeRequire = createRequire(modulePath);
        const pluginRequire = ((request: string) => {
          if (request === "obsidian") {
            return compatibilityModule;
          }
          if (request === "electron") {
            if (
              !policy.requiredAuthorities.includes("network") ||
              !policy.requiredAuthorities.includes("host-environment")
            ) {
              throw new Error(
                "Legacy Electron compatibility requires reviewed network and host authority.",
              );
            }
            const resolver = this.pluginModuleResolver ?? nativeRequire;
            return createElectronCompatibilityModule(
              resolver(request),
              this.electronCompatibilityActivity,
            );
          }
          if (this.pluginModuleResolver && isCompatibilityHostModule(request)) {
            return this.pluginModuleResolver(request);
          }
          const resolved = this.resolveSealedPluginModule(
            nativeRequire,
            request,
            undefined,
            sealedPackageRoot,
            policy,
          );
          return resolved.builtin ? nativeRequire(request) : loadSealedModule(resolved.path);
        }) as NodeJS.Require;

        pluginRequire.resolve = ((request: string, options?: { paths?: string[] }) => {
          if (request === "obsidian") {
            return "obsidian";
          }
          if (request === "electron") {
            return "electron";
          }
          if (this.pluginModuleResolver && isCompatibilityHostModule(request)) {
            return this.pluginModuleResolver.resolve(request, options);
          }
          const resolved = this.resolveSealedPluginModule(
            nativeRequire,
            request,
            options,
            sealedPackageRoot,
            policy,
          );
          return resolved.builtin ? nativeRequire.resolve(request, options) : resolved.path;
        }) as NodeJS.RequireResolve;
        pluginRequire.cache = nativeRequire.cache;
        pluginRequire.extensions = nativeRequire.extensions;
        pluginRequire.main = nativeRequire.main;

        if (path.extname(modulePath) === ".node") {
          throw withPluginDiagnosticCode(
            new Error("Native addons are not part of a reviewed sealed plugin package."),
            "managed-package-changed",
          );
        }
        const bytes =
          knownBytes ??
          this.readVerifiedModuleBytes(modulePath, sealedPackageRoot, verifiedFiles, packageBytes);
        if (path.extname(modulePath) === ".json") {
          moduleRecord.exports = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
          return moduleRecord.exports;
        }
        const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const sourceUrl = pathToFileURL(modulePath).href;
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
          modulePath,
          path.dirname(modulePath),
          sleep,
        );
        return moduleRecord.exports;
      } catch (error) {
        moduleCache.delete(modulePath);
        throw error;
      }
    };

    const candidate = this.resolvePluginConstructor(loadSealedModule(entryPath, bundleBytes));
    if (typeof candidate !== "function") {
      throw new Error("Plugin bundle does not export a constructor.");
    }
    return candidate as PluginConstructor;
  }

  private readVerifiedModuleBytes(
    filePath: string,
    sealedPackageRoot: string,
    verifiedFiles: ReadonlyMap<string, VerifiedPluginPackageFile>,
    packageBytes?: ReadonlyMap<string, Uint8Array>,
  ): Uint8Array {
    const relativePath = path.relative(sealedPackageRoot, filePath).split(path.sep).join("/");
    const expected = verifiedFiles.get(relativePath);
    if (!expected || expected.size > maxPluginBundleBytes) {
      throw withPluginDiagnosticCode(
        new Error("Plugin dependency is absent from the verified sealed package manifest."),
        "managed-package-changed",
      );
    }
    if (packageBytes) {
      const bytes = packageBytes.get(relativePath);
      if (
        !bytes ||
        bytes.byteLength !== expected.size ||
        createHash("sha256").update(bytes).digest("hex") !== expected.sha256
      ) {
        throw withPluginDiagnosticCode(
          new Error("Trusted plugin package bytes failed their main-process identity check."),
          "managed-package-changed",
        );
      }
      return new Uint8Array(bytes);
    }
    if (constants.O_NOFOLLOW === undefined && process.platform !== "win32") {
      throw new Error("Plugin dependency verification requires no-follow file opens.");
    }
    try {
      const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = fstatSync(descriptor, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(expected.size)) {
          throw new Error("Plugin dependency is not the reviewed bounded regular file.");
        }
        const buffer = Buffer.alloc(expected.size + 1);
        let offset = 0;
        while (offset < buffer.byteLength) {
          const bytesRead = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        const after = fstatSync(descriptor, { bigint: true });
        const current = lstatSync(filePath, { bigint: true });
        const bytes = Buffer.from(buffer.subarray(0, offset));
        if (
          offset !== expected.size ||
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.nlink !== 1n ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs ||
          before.dev !== current.dev ||
          before.ino !== current.ino ||
          before.size !== current.size ||
          before.mtimeNs !== current.mtimeNs ||
          before.ctimeNs !== current.ctimeNs ||
          createHash("sha256").update(bytes).digest("hex") !== expected.sha256
        ) {
          throw new Error("Plugin dependency changed after sealed package verification.");
        }
        return bytes;
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      if (attachedPluginDiagnosticCode(error)) {
        throw error;
      }
      throw withPluginDiagnosticCode(
        new Error("Plugin dependency changed after sealed package verification.", {
          cause: error,
        }),
        "managed-package-changed",
      );
    }
  }

  private resolveSealedPluginModule(
    nativeRequire: NodeJS.Require,
    request: string,
    options: { paths?: string[] } | undefined,
    sealedPackageRoot: string,
    policy: PluginConstructionDispatch["policy"],
  ): { builtin: true; path: string } | { builtin: false; path: string } {
    const authority = builtinAuthority(request);
    if (authority) {
      if (!policy.requiredAuthorities.includes(authority)) {
        throw new PluginConstructionRefusal(this.authorityMismatchPolicy(policy));
      }
      return { builtin: true, path: request };
    }

    let canonicalResolved: string;
    try {
      canonicalResolved = realpathSync(nativeRequire.resolve(request, options));
    } catch (error) {
      throw withPluginDiagnosticCode(
        new Error("Plugin module resolution failed inside the sealed package root.", {
          cause: error,
        }),
        "package-path-escape",
      );
    }
    if (!isPathInside(sealedPackageRoot, canonicalResolved)) {
      throw withPluginDiagnosticCode(
        new Error("Plugin module resolution escaped the sealed package root."),
        "package-path-escape",
      );
    }
    if (
      path.extname(canonicalResolved) === ".node" &&
      !policy.requiredAuthorities.includes("dynamic-code")
    ) {
      throw new PluginConstructionRefusal(this.authorityMismatchPolicy(policy));
    }
    return { builtin: false, path: canonicalResolved };
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

  private assertConstructionDispatch(dispatch: PluginConstructionDispatch): void {
    const policy = dispatch?.policy;
    if (
      !dispatch ||
      typeof dispatch.pluginDirectory !== "string" ||
      !path.isAbsolute(dispatch.pluginDirectory) ||
      !policy ||
      policy.decision !== "allow" ||
      policy.denialCode !== null ||
      policy.sealedPackageRootId === null ||
      policy.stagedPackageTreeSha256 === null ||
      policy.boundary === null ||
      policy.authorityProfileId === null ||
      policy.authorityDigest === null ||
      !policy.constructionAttemptId ||
      policy.packageIdentityDigest !== authorityJsonSha256(policy.packageIdentity) ||
      policy.stagedPackageTreeSha256 !== policy.packageIdentity.packageTreeSha256
    ) {
      throw new Error("Plugin construction requires a complete main-process allow dispatch.");
    }
    const { policyDigest: _policyDigest, ...payload } = policy;
    if (policy.policyDigest !== authorityJsonSha256(payload)) {
      throw new PluginConstructionRefusal(this.stalePolicy(policy));
    }
    if (this.consumedConstructionAttempts.size >= maxConsumedPluginConstructionAttempts) {
      throw new PluginConstructionRefusal(this.replayLedgerExhaustedPolicy(policy));
    }
    if (this.consumedConstructionAttempts.has(policy.constructionAttemptId)) {
      throw new PluginConstructionRefusal(this.stalePolicy(policy));
    }
    this.consumedConstructionAttempts.add(policy.constructionAttemptId);
  }

  private directLoadRefusalPolicy(
    request: PluginConstructionRequest,
  ): PluginConstructionDispatch["policy"] {
    const denied = {
      constructionAttemptId: "unresolved-direct-load",
      constructionPath: request.constructionPath,
      vaultId: "unresolved",
      vaultGeneration: 0,
      epoch: {
        policyEpoch: 0,
        grantEpoch: 0,
        grantRevision: 0,
        safeModeEpoch: 0,
        packageStoreEpoch: 0,
        authorityProfileRevision: 0,
      },
      packageIdentity: { ...request.packageIdentity },
      packageIdentityDigest: request.packageIdentityDigest,
      sealedPackageRootId: null,
      stagedPackageTreeSha256: null,
      authorityProfileId: null,
      authorityDigest: null,
      staticScanDigest: null,
      expectedStaticCapabilities: [],
      requiredAuthorities: [],
      boundary: null,
      decision: "deny" as const,
      denialCode: "authority-profile-missing" as const,
      issuedAt: "1970-01-01T00:00:00.000Z",
    };
    return { ...denied, policyDigest: authorityJsonSha256(denied) };
  }

  private stalePolicy(
    policy: PluginConstructionDispatch["policy"],
  ): PluginConstructionDispatch["policy"] {
    const { policyDigest: _policyDigest, ...payload } = policy;
    const denied = {
      ...payload,
      sealedPackageRootId: null,
      stagedPackageTreeSha256: null,
      decision: "deny" as const,
      denialCode: "policy-epoch-stale" as const,
    };
    return { ...denied, policyDigest: authorityJsonSha256(denied) };
  }

  private replayLedgerExhaustedPolicy(
    policy: PluginConstructionDispatch["policy"],
  ): PluginConstructionDispatch["policy"] {
    const { policyDigest: _policyDigest, ...payload } = policy;
    const denied = {
      ...payload,
      sealedPackageRootId: null,
      stagedPackageTreeSha256: null,
      decision: "deny" as const,
      denialCode: "replay-ledger-exhausted" as const,
    };
    return { ...denied, policyDigest: authorityJsonSha256(denied) };
  }

  private identityMismatchPolicy(
    policy: PluginConstructionDispatch["policy"],
  ): PluginConstructionDispatch["policy"] {
    const { policyDigest: _policyDigest, ...payload } = policy;
    const denied = {
      ...payload,
      sealedPackageRootId: null,
      stagedPackageTreeSha256: null,
      decision: "deny" as const,
      denialCode: "package-identity-mismatch" as const,
    };
    return { ...denied, policyDigest: authorityJsonSha256(denied) };
  }

  private authorityMismatchPolicy(
    policy: PluginConstructionDispatch["policy"],
  ): PluginConstructionDispatch["policy"] {
    const { policyDigest: _policyDigest, ...payload } = policy;
    const denied = {
      ...payload,
      sealedPackageRootId: null,
      stagedPackageTreeSha256: null,
      decision: "deny" as const,
      denialCode: "authority-profile-mismatch" as const,
    };
    return { ...denied, policyDigest: authorityJsonSha256(denied) };
  }

  private async verifyPackageIdentity(
    rootPath: string,
    policy: PluginConstructionDispatch["policy"],
  ): Promise<ReadonlyMap<string, VerifiedPluginPackageFile>> {
    const expected: ExactPluginPackageIdentity = policy.packageIdentity;
    const files: Array<{ path: string; sha256: string; size: number }> = [];
    let aggregateBytes = 0;
    const visit = async (directoryPath: string, relativeDirectory: string): Promise<void> => {
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      entries.sort((left, right) => compareCanonicalPluginPackagePaths(left.name, right.name));
      for (const entry of entries) {
        const relativePath = path.posix.join(relativeDirectory, entry.name);
        if (!isPluginDistributionPathIncluded(relativePath)) {
          continue;
        }
        if (entry.isSymbolicLink() || path.isAbsolute(relativePath)) {
          throw new PluginConstructionRefusal(this.identityMismatchPolicy(policy));
        }
        const absolutePath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          await visit(absolutePath, relativePath);
          continue;
        }
        if (!entry.isFile()) {
          throw new Error("Sealed plugin package contains a non-regular entry.");
        }
        const snapshot = await readStableFileWithinLimit(absolutePath, 64 * 1024 * 1024);
        const current = await fs.lstat(absolutePath, { bigint: true });
        if (
          snapshot?.status !== "ready" ||
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.nlink !== 1n ||
          current.size !== BigInt(snapshot.snapshot.size)
        ) {
          throw new PluginConstructionRefusal(this.identityMismatchPolicy(policy));
        }
        const bytes = snapshot.snapshot.bytes;
        aggregateBytes += bytes.byteLength;
        if (files.length >= 4_096 || aggregateBytes > 64 * 1024 * 1024) {
          throw new Error("Sealed plugin package exceeds its bounded closure budget.");
        }
        files.push({
          path: relativePath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
        });
      }
    };
    await visit(rootPath, "");
    files.sort((left, right) => compareCanonicalPluginPackagePaths(left.path, right.path));
    const byPath = new Map(files.map((file) => [file.path, file]));
    const actual = {
      manifestSha256: byPath.get("manifest.json")?.sha256,
      mainSha256: byPath.get("main.js")?.sha256,
      stylesSha256: byPath.get("styles.css")?.sha256 ?? null,
      packageTreeSha256: authorityJsonSha256({ schemaVersion: 1, files }),
    };
    if (
      actual.manifestSha256 !== expected.manifestSha256 ||
      actual.mainSha256 !== expected.mainSha256 ||
      actual.stylesSha256 !== expected.stylesSha256 ||
      actual.packageTreeSha256 !== expected.packageTreeSha256
    ) {
      throw new PluginConstructionRefusal(this.identityMismatchPolicy(policy));
    }
    return new Map(
      files.map(({ path: relativePath, sha256, size }) => [relativePath, { sha256, size }]),
    );
  }

  private readManifest(
    manifestPath: string,
    sealedPackageRoot: string,
    verifiedFiles: ReadonlyMap<string, VerifiedPluginPackageFile>,
    packageBytes?: ReadonlyMap<string, Uint8Array>,
  ): PluginManifest {
    const manifest = parsePluginManifest(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          this.readVerifiedModuleBytes(
            manifestPath,
            sealedPackageRoot,
            verifiedFiles,
            packageBytes,
          ),
        ),
      ),
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

  private async assertSealedPackageRoot(candidatePath: string): Promise<string> {
    const absoluteCandidate = path.resolve(candidatePath);
    const filesystemRoot = path.parse(absoluteCandidate).root;
    let current = filesystemRoot;
    for (const segment of path
      .relative(filesystemRoot, absoluteCandidate)
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, segment);
      const component = await fs.lstat(current);
      if (!component.isDirectory() || component.isSymbolicLink()) {
        throw withPluginDiagnosticCode(
          new Error("Plugin execution requires a real sealed package directory chain."),
          "package-path-escape",
        );
      }
    }
    const stat = await fs.lstat(absoluteCandidate);
    const canonicalCandidate = await fs.realpath(candidatePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw withPluginDiagnosticCode(
        new Error("Plugin execution requires a real sealed package root."),
        "package-path-escape",
      );
    }
    return canonicalCandidate;
  }

  private record(kind: RuntimeEventKind, message: string): void {
    this.events.push({ sequence: ++this.eventSequence, kind, message });
  }
}
