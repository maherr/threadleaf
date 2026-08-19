import { createRequire } from "node:module";
import path from "node:path";
import moment from "moment";
import { PluginHost } from "../runtime/plugin-host";
import type { PluginEnvironmentSnapshot, RuntimeSnapshot } from "../shared/contracts";
import {
  optionalPayloadString,
  optionalPluginEditorContext,
  optionalPluginMutationWaitOptions,
  type PluginRendererEnvironment,
  type PluginRendererRequest,
  type PluginVaultCreateBinaryRequest,
  type PluginVaultCreateBinaryResponse,
  type PluginVaultCreateFolderRequest,
  type PluginVaultCreateFolderResponse,
  type PluginVaultCreateRequest,
  type PluginVaultCreateResponse,
  type PluginVaultRenameRequest,
  type PluginVaultRenameResponse,
  type PluginVaultTrashRequest,
  type PluginVaultTrashResponse,
  type PluginVaultWriteBinaryRequest,
  type PluginVaultWriteBinaryResponse,
  type PluginVaultWriteRequest,
  type PluginVaultWriteResponse,
  requirePayloadContent,
  requirePayloadString,
  requirePayloadStringArray,
  requirePluginConstructionDispatch,
  requirePluginRendererEnvironment,
} from "../shared/plugin-runtime-protocol";

export interface PluginRendererVaultMutations {
  createBinary?(request: PluginVaultCreateBinaryRequest): Promise<PluginVaultCreateBinaryResponse>;
  createFolder(request: PluginVaultCreateFolderRequest): Promise<PluginVaultCreateFolderResponse>;
  createText(request: PluginVaultCreateRequest): Promise<PluginVaultCreateResponse>;
  renameFile?(request: PluginVaultRenameRequest): Promise<PluginVaultRenameResponse>;
  trashFile?(request: PluginVaultTrashRequest): Promise<PluginVaultTrashResponse>;
  writeBinary?(request: PluginVaultWriteBinaryRequest): Promise<PluginVaultWriteBinaryResponse>;
  writeText(request: PluginVaultWriteRequest): Promise<PluginVaultWriteResponse>;
  openFile?(request: { filePath: string; vaultPath: string }): Promise<unknown>;
  surfaceChanged?(request: { vaultPath: string }): Promise<unknown>;
}

const compatibilityEnvironmentStyleIds = {
  appearance: "threadleaf-compat-appearance-source",
  plugin: "threadleaf-compat-plugin-source",
  accessibility: "threadleaf-compat-accessibility",
} as const;

type EnvironmentStyleId =
  (typeof compatibilityEnvironmentStyleIds)[keyof typeof compatibilityEnvironmentStyleIds];

function requireDocument(): Document {
  if (typeof document === "undefined" || !document.head || !document.documentElement) {
    throw new Error("Plugin renderer environment requires a document head and root.");
  }
  return document;
}

function ensureEnvironmentStyle(documentRef: Document, id: EnvironmentStyleId): HTMLStyleElement {
  const existing = documentRef.getElementById(id);
  if (existing && existing.tagName !== "STYLE") {
    throw new Error(`Plugin renderer environment node ${id} is not a style element.`);
  }
  if (existing) {
    return existing as HTMLStyleElement;
  }
  const style = documentRef.createElement("style");
  style.id = id;
  style.dataset.threadleafEnvironmentSource = "true";
  documentRef.head.append(style);
  return style;
}

function realizeEnvironmentStyles(documentRef: Document): void {
  // Reading cssRules forces the browser to parse each stylesheet before the
  // acknowledgement is emitted. Cross-origin sheets are not expected in this
  // isolated renderer, but a defensive catch keeps the local sources realized.
  for (const sheet of Array.from(documentRef.styleSheets)) {
    try {
      void sheet.cssRules.length;
    } catch {
      // A foreign sheet cannot be inspected; the source nodes remain local and
      // are still ordered and acknowledged below.
    }
  }
}

async function settleEnvironmentStyles(documentRef: Document): Promise<void> {
  // Style-node insertion and CSSOM parsing are synchronous. Yield once so
  // pending mutation observers can restore source order, then force a cascade
  // read. Do not depend on animation frames or timers: an unattached macOS
  // WebContentsView may suspend both even with background throttling disabled.
  await Promise.resolve();
  void documentRef.defaultView?.getComputedStyle(documentRef.documentElement).display;
}

function applyAccessibilityState(
  documentRef: Document,
  state: PluginRendererEnvironment["accessibility"],
): void {
  const root = documentRef.documentElement;
  const body = documentRef.body;
  root.dataset.threadleafAccessibility = "true";
  root.dataset.threadleafHighContrast = String(state.highContrast);
  root.dataset.threadleafReducedMotion = String(state.reducedMotion);
  root.dataset.threadleafReducedTransparency = String(state.reducedTransparency);
  root.dataset.threadleafAccent = state.accent;
  for (const target of [root, body]) {
    target.style.setProperty("--threadleaf-ui-font-scale", String(state.uiFontScale), "important");
    target.style.setProperty(
      "--threadleaf-text-font-scale",
      String(state.textFontScale),
      "important",
    );
    target.style.setProperty(
      "--threadleaf-editor-font-size",
      `${String(state.editorFontSize)}px`,
      "important",
    );
    target.style.setProperty(
      "--threadleaf-editor-line-height",
      String(state.editorLineHeight),
      "important",
    );
  }
}

function applyThemeState(documentRef: Document, theme: "dark" | "light"): void {
  const root = documentRef.documentElement;
  root.dataset.theme = theme;
  for (const target of [root, documentRef.body]) {
    target.classList.toggle("theme-dark", theme === "dark");
    target.classList.toggle("theme-light", theme === "light");
  }
}

export class PluginRendererService {
  private host: PluginHost | null = null;
  private restoreCompatibilityGlobals: (() => void) | null = null;
  private readonly vaultMutations: PluginRendererVaultMutations | undefined;
  private environment: PluginRendererEnvironment | null = null;
  private environmentAcknowledgement: PluginEnvironmentSnapshot | null = null;
  private accessibilityOrderObserver: MutationObserver | null = null;
  private hostStyleNodes = new Set<HTMLStyleElement>();

  constructor(vaultMutations?: PluginRendererVaultMutations) {
    this.vaultMutations = vaultMutations;
  }

  async handle(request: PluginRendererRequest) {
    switch (request.operation) {
      case "initialize": {
        const vaultPath = requirePayloadString(request, "vaultPath");
        const packageJsonPath = requirePayloadString(request, "packageJsonPath");
        if (!path.isAbsolute(vaultPath) || !path.isAbsolute(packageJsonPath)) {
          throw new Error("Plugin renderer initialization requires absolute paths.");
        }
        await this.close();
        const vaultMutations = this.vaultMutations;
        const createBinary = vaultMutations?.createBinary;
        const renameFile = vaultMutations?.renameFile;
        const trashFile = vaultMutations?.trashFile;
        const writeBinary = vaultMutations?.writeBinary;
        this.host = new PluginHost(
          vaultPath,
          undefined,
          undefined,
          createRequire(packageJsonPath),
          vaultMutations
            ? {
                writeText: (filePath, content, expectedRevision) =>
                  vaultMutations.writeText({
                    vaultPath,
                    filePath,
                    content,
                    expectedRevision,
                  }),
                createText: (filePath, content) =>
                  vaultMutations.createText({ vaultPath, filePath, content }),
                createFolder: (folderPath) =>
                  vaultMutations.createFolder({ vaultPath, folderPath }),
                ...(renameFile
                  ? {
                      renameFile: (
                        sourcePath: string,
                        targetPath: string,
                        expectedRevision: string,
                      ) => renameFile({ vaultPath, sourcePath, targetPath, expectedRevision }),
                    }
                  : {}),
                ...(trashFile
                  ? {
                      trashFile: (filePath: string, expectedRevision: string) =>
                        trashFile({ vaultPath, filePath, expectedRevision }),
                    }
                  : {}),
                ...(createBinary
                  ? {
                      createBinary: (filePath: string, content: Uint8Array) =>
                        createBinary({
                          vaultPath,
                          filePath,
                          content: new Uint8Array(content).buffer,
                        }),
                    }
                  : {}),
                ...(writeBinary
                  ? {
                      writeBinary: (
                        filePath: string,
                        content: Uint8Array,
                        expectedRevision: string,
                      ) =>
                        writeBinary({
                          vaultPath,
                          filePath,
                          content: new Uint8Array(content).buffer,
                          expectedRevision,
                        }),
                    }
                  : {}),
              }
            : undefined,
          vaultMutations?.openFile || vaultMutations?.surfaceChanged
            ? {
                ...(vaultMutations.openFile
                  ? {
                      onOpenFile: async (filePath: string) => {
                        await vaultMutations.openFile?.({ vaultPath, filePath });
                      },
                    }
                  : {}),
                ...(vaultMutations.surfaceChanged
                  ? {
                      onSurfaceChange: () => {
                        void vaultMutations.surfaceChanged?.({ vaultPath });
                      },
                    }
                  : {}),
              }
            : undefined,
        );
        await this.host.seedVaultMarkdownPaths([]);
        if (typeof document !== "undefined" && document.head) {
          this.hostStyleNodes = new Set(
            Array.from(document.head.querySelectorAll("style")) as HTMLStyleElement[],
          );
        }
        this.restoreCompatibilityGlobals = this.installCompatibilityGlobals(this.host);
        return this.snapshot();
      }
      case "get-snapshot":
        return this.snapshot();
      case "apply-environment":
        return this.applyEnvironment(requirePluginRendererEnvironment(request));
      case "load-plugin":
        await this.requireHost().closePluginView();
        {
          const snapshot = await this.requireHost().loadAuthorizedPlugin(
            requirePluginConstructionDispatch(request),
          );
          await this.ensureAccessibilityLast();
          return this.withEnvironment(snapshot);
        }
      case "reload-plugin":
        await this.requireHost().closePluginView();
        {
          const snapshot = await this.requireHost().reloadAuthorizedPlugin(
            requirePluginConstructionDispatch(request),
          );
          await this.ensureAccessibilityLast();
          return this.withEnvironment(snapshot);
        }
      case "render-markdown":
        return this.withEnvironment(
          await this.requireHost().renderMarkdownProjection(
            requirePayloadString(request, "pluginId"),
            requirePayloadString(request, "sourcePath"),
            requirePayloadContent(request, "content"),
          ),
        );
      case "run-command":
        return this.withEnvironment(
          await this.requireHost().runCommand(
            requirePayloadString(request, "commandId"),
            optionalPluginEditorContext(request),
          ),
        );
      case "seed-vault-markdown-paths":
        await this.requireHost().seedVaultMarkdownPaths(
          requirePayloadStringArray(request, "paths"),
        );
        return this.snapshot();
      case "wait-for-mutations":
        return this.withEnvironment(
          await this.requireHost().waitForPluginMutations(
            optionalPluginMutationWaitOptions(request),
          ),
        );
      case "unload-plugin":
        return this.withEnvironment(
          await this.requireHost().unloadPlugin(optionalPayloadString(request, "pluginId")),
        );
      case "unload-all":
        return this.withEnvironment(await this.requireHost().unloadAllPlugins());
      case "mark-layout-ready":
        return this.withEnvironment(await this.requireHost().markLayoutReady());
      case "open-settings":
        return this.withEnvironment(
          await this.requireHost().openPluginSettings(requirePayloadString(request, "pluginId")),
        );
      case "open-view":
        return this.withEnvironment(
          await this.requireHost().openPluginView(
            requirePayloadString(request, "viewType"),
            optionalPayloadString(request, "filePath"),
          ),
        );
      case "close-view":
        return this.withEnvironment(await this.requireHost().closePluginView());
      case "close":
        await this.close();
        return null;
    }
  }

  async close(): Promise<void> {
    const host = this.host;
    this.host = null;
    this.accessibilityOrderObserver?.disconnect();
    this.accessibilityOrderObserver = null;
    this.hostStyleNodes.clear();
    this.environment = null;
    this.environmentAcknowledgement = null;
    try {
      await host?.close();
    } finally {
      this.restoreCompatibilityGlobals?.();
      this.restoreCompatibilityGlobals = null;
    }
  }

  private installCompatibilityGlobals(host: PluginHost): () => void {
    const targets: object[] = [globalThis];
    if (typeof window !== "undefined" && window !== globalThis) {
      targets.push(window);
    }
    const values = { app: host.app, moment } as const;
    const descriptors = targets.flatMap((target) =>
      Object.entries(values).map(([name, value]) => ({
        descriptor: Object.getOwnPropertyDescriptor(target, name),
        name,
        target,
        value,
      })),
    );
    for (const { name, target, value } of descriptors) {
      Object.defineProperty(target, name, {
        configurable: true,
        enumerable: true,
        value,
        writable: false,
      });
    }
    return () => {
      for (const { descriptor, name, target } of descriptors) {
        if (descriptor) {
          Object.defineProperty(target, name, descriptor);
        } else {
          Reflect.deleteProperty(target, name);
        }
      }
    };
  }

  private requireHost(): PluginHost {
    if (!this.host) {
      throw new Error("Plugin renderer has not been initialized.");
    }
    return this.host;
  }

  private async snapshot(
    acknowledgementOverride?: PluginEnvironmentSnapshot,
  ): Promise<RuntimeSnapshot> {
    return this.withEnvironment(await this.requireHost().getSnapshot(), acknowledgementOverride);
  }

  private withEnvironment(
    snapshot: RuntimeSnapshot,
    acknowledgementOverride?: PluginEnvironmentSnapshot,
  ): RuntimeSnapshot {
    const environmentAcknowledgement = acknowledgementOverride ?? this.environmentAcknowledgement;
    return environmentAcknowledgement
      ? { ...snapshot, pluginEnvironment: { ...environmentAcknowledgement } }
      : snapshot;
  }

  private async applyEnvironment(environment: PluginRendererEnvironment): Promise<RuntimeSnapshot> {
    const host = this.requireHost();
    if (
      this.environment &&
      (this.environment.vaultId !== environment.vaultId ||
        this.environment.vaultGeneration !== environment.vaultGeneration)
    ) {
      throw new Error("Plugin renderer environment identity changed while the renderer was bound.");
    }
    if (this.environment && environment.sequence <= this.environment.sequence) {
      const staleAcknowledgement: PluginEnvironmentSnapshot = {
        status: "stale",
        vaultId: environment.vaultId,
        vaultGeneration: environment.vaultGeneration,
        sequence: environment.sequence,
        cssChangeTriggered: false,
      };
      return this.snapshot(staleAcknowledgement);
    }

    const initial = this.environment === null;
    const documentRef = requireDocument();
    const appearance = ensureEnvironmentStyle(
      documentRef,
      compatibilityEnvironmentStyleIds.appearance,
    );
    const plugin = ensureEnvironmentStyle(documentRef, compatibilityEnvironmentStyleIds.plugin);
    const accessibility = ensureEnvironmentStyle(
      documentRef,
      compatibilityEnvironmentStyleIds.accessibility,
    );
    appearance.textContent = environment.appearanceCss;
    plugin.textContent = environment.pluginCss;
    accessibility.textContent = environment.accessibilityCss;
    applyThemeState(documentRef, environment.theme);
    applyAccessibilityState(documentRef, environment.accessibility);
    this.placeSourceNodes(documentRef, appearance, plugin, accessibility);
    this.installAccessibilityOrderObserver(documentRef);
    realizeEnvironmentStyles(documentRef);
    await settleEnvironmentStyles(documentRef);
    await this.ensureAccessibilityLast();
    const cssChangeTriggered = !initial;
    if (cssChangeTriggered) {
      host.app.workspace.trigger("css-change");
    }
    this.environment = structuredClone(environment);
    this.environmentAcknowledgement = {
      status: "applied",
      vaultId: environment.vaultId,
      vaultGeneration: environment.vaultGeneration,
      sequence: environment.sequence,
      cssChangeTriggered,
    };
    return this.snapshot();
  }

  private placeSourceNodes(
    documentRef: Document,
    appearance: HTMLStyleElement,
    plugin: HTMLStyleElement,
    accessibility: HTMLStyleElement,
  ): void {
    const sourceIds = new Set<string>(Object.values(compatibilityEnvironmentStyleIds));
    const firstDynamicStyle = Array.from(documentRef.head.querySelectorAll("style")).find(
      (style) => !sourceIds.has(style.id) && !this.hostStyleNodes.has(style),
    );
    if (firstDynamicStyle) {
      documentRef.head.insertBefore(appearance, firstDynamicStyle);
      documentRef.head.insertBefore(plugin, firstDynamicStyle);
    } else {
      documentRef.head.append(appearance, plugin);
    }
    documentRef.head.append(accessibility);
  }

  private installAccessibilityOrderObserver(documentRef: Document): void {
    const MutationObserverConstructor = documentRef.defaultView?.MutationObserver;
    if (this.accessibilityOrderObserver || !MutationObserverConstructor) {
      return;
    }
    this.accessibilityOrderObserver = new MutationObserverConstructor(() => {
      void this.ensureAccessibilityLast();
    });
    this.accessibilityOrderObserver.observe(documentRef.head, { childList: true });
  }

  private async ensureAccessibilityLast(): Promise<void> {
    if (typeof document === "undefined" || !document.head) {
      return;
    }
    const accessibility = document.getElementById(compatibilityEnvironmentStyleIds.accessibility);
    if (accessibility && document.head.lastElementChild !== accessibility) {
      document.head.append(accessibility);
    }
    if (accessibility) {
      realizeEnvironmentStyles(document);
    }
    await Promise.resolve();
  }
}
