import type { ActionRegistry } from "../application/action-registry";
import type { PluginEditorContext, RuntimeSnapshot } from "../shared/contracts";

export class FatalPluginRuntimeError extends Error {
  readonly operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = "FatalPluginRuntimeError";
    this.operation = operation;
  }
}

export function isFatalPluginRuntimeError(error: unknown): error is FatalPluginRuntimeError {
  return error instanceof FatalPluginRuntimeError;
}

export interface PluginRuntimePort {
  closePluginView(): Promise<RuntimeSnapshot>;
  getSnapshot(): Promise<RuntimeSnapshot>;
  loadPlugin(pluginDirectory: string, expectedBundleSha256?: string): Promise<RuntimeSnapshot>;
  markLayoutReady(): Promise<RuntimeSnapshot>;
  openPluginSettings(pluginId: string): Promise<RuntimeSnapshot>;
  openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot>;
  reloadPlugin(pluginId?: string): Promise<RuntimeSnapshot>;
  runCommand(commandId: string, editorContext?: PluginEditorContext): Promise<RuntimeSnapshot>;
  unloadAllPlugins(): Promise<RuntimeSnapshot>;
  unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot>;
  close(): Promise<void>;
}

export type PluginRuntimeFactory = (
  vaultPath: string,
  actions: ActionRegistry,
) => Promise<PluginRuntimePort>;
