import { ipcRenderer } from "electron";
import { installLegacyCodeMirror5Global } from "../runtime/legacy-codemirror5";
import { installObsidianDomCompatibility } from "../runtime/obsidian-dom";
import {
  type PluginOpenFileRequest,
  type PluginRendererResponse,
  type PluginSurfaceChangedRequest,
  type PluginVaultCreateBinaryResponse,
  type PluginVaultCreateFolderResponse,
  type PluginVaultCreateResponse,
  type PluginVaultRenameResponse,
  type PluginVaultTrashResponse,
  type PluginVaultWriteBinaryResponse,
  type PluginVaultWriteResponse,
  parsePluginRendererRequest,
  pluginRendererChannels,
} from "../shared/plugin-runtime-protocol";
import { installActiveWindowGlobal } from "./active-window";
import { PluginRendererService } from "./plugin-renderer-service";

installActiveWindowGlobal(window, globalThis);
installObsidianDomCompatibility(window, globalThis);
installLegacyCodeMirror5Global(window);

const service = new PluginRendererService({
  openFile: (request: PluginOpenFileRequest) =>
    ipcRenderer.invoke(pluginRendererChannels.openFile, request) as Promise<unknown>,
  surfaceChanged: (request: PluginSurfaceChangedRequest) =>
    ipcRenderer.invoke(pluginRendererChannels.surfaceChanged, request) as Promise<unknown>,
  createBinary: (request) =>
    ipcRenderer.invoke(
      pluginRendererChannels.vaultCreateBinary,
      request,
    ) as Promise<PluginVaultCreateBinaryResponse>,
  createFolder: (request) =>
    ipcRenderer.invoke(
      pluginRendererChannels.vaultCreateFolder,
      request,
    ) as Promise<PluginVaultCreateFolderResponse>,
  createText: (request) =>
    ipcRenderer.invoke(
      pluginRendererChannels.vaultCreate,
      request,
    ) as Promise<PluginVaultCreateResponse>,
  renameFile: (request) =>
    ipcRenderer.invoke(
      pluginRendererChannels.vaultRename,
      request,
    ) as Promise<PluginVaultRenameResponse>,
  trashFile: (request) =>
    ipcRenderer.invoke(
      pluginRendererChannels.vaultTrash,
      request,
    ) as Promise<PluginVaultTrashResponse>,
  writeBinary: (request) =>
    ipcRenderer.invoke(
      pluginRendererChannels.vaultWriteBinary,
      request,
    ) as Promise<PluginVaultWriteBinaryResponse>,
  writeText: (request) =>
    ipcRenderer.invoke(
      pluginRendererChannels.vaultWrite,
      request,
    ) as Promise<PluginVaultWriteResponse>,
});

function rendererErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (process.env.THREADLEAF_PLUGIN_E2E_DIAGNOSTICS !== "1" || !(error instanceof Error)) {
    return message;
  }
  const causes: string[] = [];
  let cause: unknown = error.cause;
  while (cause instanceof Error && causes.length < 6) {
    causes.push(`${cause.name}: ${cause.message}`);
    cause = cause.cause;
  }
  return causes.length > 0 ? `${message} Developer cause: ${causes.join(" <- ")}` : message;
}

ipcRenderer.on(pluginRendererChannels.request, async (_event, value: unknown) => {
  let response: PluginRendererResponse;
  let requestId = "invalid-request";
  try {
    const request = parsePluginRendererRequest(value);
    requestId = request.id;
    response = { id: request.id, ok: true, value: await service.handle(request) };
  } catch (error) {
    response = {
      id: requestId,
      ok: false,
      error: rendererErrorMessage(error),
    };
  }
  ipcRenderer.send(pluginRendererChannels.response, response);
});

window.addEventListener("beforeunload", () => {
  void service.close();
});

ipcRenderer.send(pluginRendererChannels.ready);
