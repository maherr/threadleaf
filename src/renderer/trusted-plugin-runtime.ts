import moment from "moment";
import type { VaultReadPort, VaultTextSnapshot } from "../kernel/ports";
import type { CompatibilityVaultWritePort } from "../runtime/obsidian-compat";
import { installObsidianDomCompatibility } from "../runtime/obsidian-dom";
import type { EditorCompatibilityFields } from "../runtime/obsidian-editor-compat";
import { rendererEditorCompatibilityFields } from "../runtime/obsidian-editor-compat";
import type { PluginHost } from "../runtime/plugin-host";
import type { RuntimeSnapshot } from "../shared/contracts";
import {
  optionalPayloadString,
  optionalPluginEditorContext,
  optionalPluginMutationWaitOptions,
  type PluginRendererRequest,
  type PluginRendererResponse,
  type PluginVaultCreateBinaryResponse,
  type PluginVaultCreateFolderResponse,
  type PluginVaultCreateResponse,
  type PluginVaultRenameResponse,
  type PluginVaultTrashResponse,
  type PluginVaultWriteBinaryResponse,
  type PluginVaultWriteResponse,
  parsePluginRendererRequest,
  pluginRendererChannels,
  requirePayloadContent,
  requirePayloadString,
  requirePluginConstructionDispatch,
} from "../shared/plugin-runtime-protocol";
import { type TrustedHostModuleTable, trustedHostModules } from "./trusted-host-modules";

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (_event: unknown, value: unknown) => void): void;
  send(channel: string, ...args: unknown[]): void;
}

interface TrustedRuntimeBridge {
  hostBundle: string;
  ipcRenderer: IpcRendererLike;
  nodeIsBuiltin(request: string): boolean;
  nodeRequire(request: string): unknown;
  nodeResolve(request: string, options?: { paths?: string[] }): string;
  nodeResolveFrom(modulePath: string, request: string, options?: { paths?: string[] }): string;
}

interface TrustedPluginHostFactory {
  createTrustedPluginHost(options: {
    editorFields: EditorCompatibilityFields;
    onEditorExtensionsChange(extensions: readonly unknown[]): void;
    pluginModuleResolver: NodeJS.Require;
    reader?: VaultReadPort;
    vaultPath: string;
    writer?: CompatibilityVaultWritePort;
  }): PluginHost;
}

interface PluginHostLike {
  app: unknown;
  close(): Promise<void>;
  closePluginView(): Promise<unknown>;
  getSnapshot(): Promise<unknown>;
  loadAuthorizedPlugin(dispatch: unknown): Promise<unknown>;
  markLayoutReady(): Promise<unknown>;
  openPluginSettings(pluginId: string): Promise<unknown>;
  openPluginView(viewType: string, filePath?: string): Promise<unknown>;
  reloadAuthorizedPlugin(dispatch: unknown): Promise<unknown>;
  renderMarkdownProjection(pluginId: string, sourcePath: string, content: string): Promise<unknown>;
  runCommand(commandId: string, editorContext?: unknown): Promise<unknown>;
  unloadAllPlugins(): Promise<unknown>;
  unloadPlugin(pluginId?: string): Promise<unknown>;
  vault: { rootPath: string };
  waitForPluginMutations(options?: unknown): Promise<unknown>;
}

type EditorExtensionSink = (extensions: readonly unknown[]) => void;
type EditorDispatcher = (paneId: "primary" | "secondary", content: string) => void;

let editorExtensionSink: EditorExtensionSink | null = null;
let editorDispatcher: EditorDispatcher | null = null;

export function setTrustedEditorExtensionSink(sink: EditorExtensionSink | null): void {
  editorExtensionSink = sink;
}

export function setTrustedEditorDispatcher(dispatcher: EditorDispatcher | null): void {
  editorDispatcher = dispatcher;
}

function createTrustedNativeRequire(
  bridge: TrustedRuntimeBridge,
  modulePath?: string,
): NodeJS.Require {
  const nativeRequire = ((request: string) => bridge.nodeRequire(request)) as NodeJS.Require;
  nativeRequire.resolve = ((request: string, options?: { paths?: string[] }) =>
    modulePath
      ? bridge.nodeResolveFrom(modulePath, request, options)
      : bridge.nodeResolve(request, options)) as NodeJS.Require["resolve"];
  nativeRequire.resolve.paths = () => null;
  return nativeRequire;
}

function createTrustedModuleFacade(bridge: TrustedRuntimeBridge): {
  createRequire(modulePath: string): NodeJS.Require;
  isBuiltin(request: string): boolean;
} {
  return {
    createRequire: (modulePath) => createTrustedNativeRequire(bridge, modulePath),
    isBuiltin: (request) => bridge.nodeIsBuiltin(request),
  };
}

export function trustedRendererNodeRequire(): NodeJS.Require | null {
  const bridge = (globalThis as unknown as { __threadleafTrustedRuntime?: TrustedRuntimeBridge })
    .__threadleafTrustedRuntime;
  if (!bridge) {
    return null;
  }
  const resolver = ((request: string) => {
    if (request === "module" || request === "node:module") {
      return createTrustedModuleFacade(bridge);
    }
    return bridge.nodeRequire(request);
  }) as NodeJS.Require;
  resolver.resolve = ((request: string, options?: { paths?: string[] }) =>
    bridge.nodeResolve(request, options)) as NodeJS.Require["resolve"];
  resolver.resolve.paths = () => null;
  return resolver;
}

const nodeRequire = trustedRendererNodeRequire();
const trustedRuntime = (
  globalThis as unknown as { __threadleafTrustedRuntime?: TrustedRuntimeBridge }
).__threadleafTrustedRuntime;
const ipcRenderer = trustedRuntime?.ipcRenderer;

function installTrustedWorkspaceProbe(): void {
  if (!ipcRenderer) {
    return;
  }
  Object.defineProperty(window, "__threadleafTrustedHostModules", {
    configurable: true,
    enumerable: false,
    value: trustedHostModules,
    writable: false,
  });
  Object.defineProperty(window, "__threadleafTrustedWorkspaceTest", {
    configurable: true,
    enumerable: false,
    value: {
      rendererIdentity: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    writable: false,
  });
  Object.defineProperty(window, "__threadleafTrustedWorkspaceDispatch", {
    configurable: true,
    enumerable: false,
    value: (paneId: "primary" | "secondary", content: string): void => {
      editorDispatcher?.(paneId, content);
    },
    writable: false,
  });
}

function createModuleResolver(
  packageRequire: NodeJS.Require,
  hostModules: TrustedHostModuleTable,
): NodeJS.Require {
  const resolver = ((request: string) => {
    const hostModule = (hostModules as Record<string, unknown>)[request];
    if (hostModule !== undefined) {
      return hostModule;
    }
    if (
      Object.keys(hostModules).some((root) => request === root || request.startsWith(`${root}/`))
    ) {
      throw new Error(
        `Trusted CodeMirror/Lezer module is not exposed by the renderer table: ${request}`,
      );
    }
    return packageRequire(request);
  }) as NodeJS.Require;
  const resolve = ((request: string, options?: { paths?: string[] }) => {
    const hostModule = (hostModules as Record<string, unknown>)[request];
    if (hostModule !== undefined) {
      return request;
    }
    if (
      Object.keys(hostModules).some((root) => request === root || request.startsWith(`${root}/`))
    ) {
      throw new Error(
        `Trusted CodeMirror/Lezer module is not exposed by the renderer table: ${request}`,
      );
    }
    return packageRequire.resolve(request, options);
  }) as NodeJS.Require["resolve"];
  resolve.paths = packageRequire.resolve.paths;
  resolver.resolve = resolve;
  return resolver;
}

class TrustedPluginRendererService {
  private host: PluginHostLike | null = null;
  private restoreCompatibilityGlobals: (() => void) | null = null;
  private restoreTrustedNodeGlobals: (() => void) | null = null;

  async handle(request: PluginRendererRequest): Promise<unknown> {
    switch (request.operation) {
      case "initialize": {
        const vaultPath = requirePayloadString(request, "vaultPath");
        const packageJsonPath = requirePayloadString(request, "packageJsonPath");
        const hostFactoryPath = requirePayloadString(request, "hostFactoryPath");
        if (
          !nodeRequire ||
          !pathIsAbsolute(vaultPath) ||
          !pathIsAbsolute(packageJsonPath) ||
          !pathIsAbsolute(hostFactoryPath)
        ) {
          throw new Error("Trusted workspace initialization requires absolute Node paths.");
        }
        await this.close();
        this.restoreTrustedNodeGlobals = this.installTrustedNodeGlobals();
        const packageRequire = nodeRequire;
        const factory = this.evaluateHostFactory() as TrustedPluginHostFactory;
        this.host = factory.createTrustedPluginHost({
          editorFields: rendererEditorCompatibilityFields,
          onEditorExtensionsChange: (extensions) => editorExtensionSink?.(extensions),
          pluginModuleResolver: createModuleResolver(packageRequire, trustedHostModules),
          reader: this.createVaultReader(vaultPath),
          vaultPath,
          writer: this.createVaultWriter(),
        }) as PluginHostLike;
        this.restoreCompatibilityGlobals = this.installCompatibilityGlobals(this.host);
        installTrustedWorkspaceProbe();
        return this.host.getSnapshot();
      }
      case "get-snapshot":
        return this.requireHost().getSnapshot();
      case "load-plugin":
        await this.requireHost().closePluginView();
        return this.requireHost().loadAuthorizedPlugin(requirePluginConstructionDispatch(request));
      case "reload-plugin":
        await this.requireHost().closePluginView();
        return this.requireHost().reloadAuthorizedPlugin(
          requirePluginConstructionDispatch(request),
        );
      case "render-markdown":
        return this.requireHost().renderMarkdownProjection(
          requirePayloadString(request, "pluginId"),
          requirePayloadString(request, "sourcePath"),
          requirePayloadContent(request, "content"),
        );
      case "run-command":
        return this.requireHost().runCommand(
          requirePayloadString(request, "commandId"),
          optionalPluginEditorContext(request),
        );
      case "wait-for-mutations":
        return this.requireHost().waitForPluginMutations(
          optionalPluginMutationWaitOptions(request),
        );
      case "unload-plugin":
        return this.requireHost().unloadPlugin(optionalPayloadString(request, "pluginId"));
      case "unload-all":
        return this.requireHost().unloadAllPlugins();
      case "mark-layout-ready":
        return this.requireHost().markLayoutReady();
      case "open-settings":
        return this.requireHost().openPluginSettings(requirePayloadString(request, "pluginId"));
      case "open-view":
        return this.requireHost().openPluginView(
          requirePayloadString(request, "viewType"),
          optionalPayloadString(request, "filePath"),
        );
      case "close-view":
        return this.requireHost().closePluginView();
      case "close":
        await this.close();
        return null;
    }
  }

  private evaluateHostFactory(): TrustedPluginHostFactory {
    if (!trustedRuntime) {
      throw new Error("Trusted workspace host bundle is unavailable.");
    }
    const moduleRecord: { exports: unknown } = { exports: {} };
    const compiled = new Function(
      "module",
      "exports",
      "require",
      `${trustedRuntime.hostBundle}\n//# sourceURL=threadleaf-trusted-plugin-host.cjs`,
    );
    compiled(moduleRecord, moduleRecord.exports, nodeRequire);
    return moduleRecord.exports as TrustedPluginHostFactory;
  }

  async close(): Promise<void> {
    const host = this.host;
    this.host = null;
    try {
      await host?.close();
    } finally {
      this.restoreCompatibilityGlobals?.();
      this.restoreCompatibilityGlobals = null;
      this.restoreTrustedNodeGlobals?.();
      this.restoreTrustedNodeGlobals = null;
    }
  }

  private installTrustedNodeGlobals(): () => void {
    const bufferModule = nodeRequire?.("buffer") as { Buffer?: unknown } | undefined;
    const values = {
      ...(nodeRequire ? { Buffer: bufferModule?.Buffer, process: nodeRequire("process") } : {}),
    } as const;
    const descriptors = Object.entries(values).map(([name, value]) => ({
      descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
      name,
      value,
    }));
    for (const { name, value } of descriptors) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        enumerable: false,
        value,
        writable: false,
      });
    }
    return () => {
      for (const { descriptor, name } of descriptors) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, name);
        }
      }
    };
  }

  private createVaultWriter(): CompatibilityVaultWritePort {
    if (!ipcRenderer) {
      throw new Error("Trusted workspace writer requires Electron IPC.");
    }
    return {
      createBinary: (relativePath, content) =>
        ipcRenderer.invoke(pluginRendererChannels.vaultCreateBinary, {
          content: new Uint8Array(content).buffer,
          filePath: relativePath,
          vaultPath: this.requireHost().vault.rootPath,
        }) as Promise<PluginVaultCreateBinaryResponse>,
      createFolder: (relativePath) =>
        ipcRenderer.invoke(pluginRendererChannels.vaultCreateFolder, {
          folderPath: relativePath,
          vaultPath: this.requireHost().vault.rootPath,
        }) as Promise<PluginVaultCreateFolderResponse>,
      createText: (relativePath, content) =>
        ipcRenderer.invoke(pluginRendererChannels.vaultCreate, {
          content,
          filePath: relativePath,
          vaultPath: this.requireHost().vault.rootPath,
        }) as Promise<PluginVaultCreateResponse>,
      renameFile: (sourcePath, targetPath, expectedRevision) =>
        ipcRenderer.invoke(pluginRendererChannels.vaultRename, {
          expectedRevision,
          sourcePath,
          targetPath,
          vaultPath: this.requireHost().vault.rootPath,
        }) as Promise<PluginVaultRenameResponse>,
      trashFile: (sourcePath, expectedRevision) =>
        ipcRenderer.invoke(pluginRendererChannels.vaultTrash, {
          expectedRevision,
          filePath: sourcePath,
          vaultPath: this.requireHost().vault.rootPath,
        }) as Promise<PluginVaultTrashResponse>,
      writeBinary: (relativePath, content, expectedRevision) =>
        ipcRenderer.invoke(pluginRendererChannels.vaultWriteBinary, {
          content: new Uint8Array(content).buffer,
          expectedRevision,
          filePath: relativePath,
          vaultPath: this.requireHost().vault.rootPath,
        }) as Promise<PluginVaultWriteBinaryResponse>,
      writeText: (relativePath, content, expectedRevision) =>
        ipcRenderer.invoke(pluginRendererChannels.vaultWrite, {
          content,
          expectedRevision,
          filePath: relativePath,
          vaultPath: this.requireHost().vault.rootPath,
        }) as Promise<PluginVaultWriteResponse>,
    };
  }

  private createVaultReader(vaultPath: string): VaultReadPort {
    if (!ipcRenderer) {
      throw new Error("Trusted workspace reader requires Electron IPC.");
    }
    return {
      getName: () => vaultPath.replaceAll("\\", "/").split("/").at(-1) ?? "Vault",
      listMarkdownPaths: (relativeDirectory = "") =>
        ipcRenderer.invoke(pluginRendererChannels.vaultListMarkdownPaths, {
          relativeDirectory,
          vaultPath,
        }) as Promise<string[]>,
      readText: (relativePath) =>
        ipcRenderer.invoke(pluginRendererChannels.vaultReadText, {
          filePath: relativePath,
          vaultPath,
        }) as Promise<VaultTextSnapshot>,
    };
  }

  private installCompatibilityGlobals(host: PluginHostLike): () => void {
    const bufferModule = nodeRequire?.("buffer") as { Buffer?: unknown } | undefined;
    const values = {
      ...(nodeRequire ? { Buffer: bufferModule?.Buffer, process: nodeRequire("process") } : {}),
      app: host.app,
      moment,
    } as const;
    const descriptors = Object.entries(values).map(([name, value]) => ({
      descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
      name,
      value,
    }));
    for (const { name, value } of descriptors) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        enumerable: true,
        value,
        writable: false,
      });
    }
    return () => {
      for (const { descriptor, name } of descriptors) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, name);
        }
      }
    };
  }

  private requireHost(): PluginHostLike {
    if (!this.host) {
      throw new Error("Trusted workspace plugin host has not been initialized.");
    }
    return this.host;
  }
}

function pathIsAbsolute(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
}

if (ipcRenderer) {
  installObsidianDomCompatibility(window, globalThis);
  const service = new TrustedPluginRendererService();
  ipcRenderer.on(pluginRendererChannels.request, async (_event, value) => {
    let response: PluginRendererResponse;
    let requestId = "invalid-request";
    try {
      const request = parsePluginRendererRequest(value);
      requestId = request.id;
      response = {
        id: request.id,
        ok: true,
        value: (await service.handle(request)) as RuntimeSnapshot | null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Threadleaf trusted plugin request failed:", error);
      response = {
        id: requestId,
        ok: false,
        error: message,
      };
    }
    ipcRenderer.send(pluginRendererChannels.response, response);
  });
}
