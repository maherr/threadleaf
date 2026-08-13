import type { ActionRegistry } from "../application/action-registry";
import type {
  PluginEditorContext,
  PluginMutationWaitOptions,
  PluginResourceDiagnostic,
  RuntimeSnapshot,
} from "../shared/contracts";

export class FatalPluginRuntimeError extends Error {
  readonly operation: string;
  readonly resourceDiagnostic: PluginResourceDiagnostic | null;

  constructor(
    operation: string,
    message: string,
    resourceDiagnostic: PluginResourceDiagnostic | null = null,
  ) {
    super(message);
    this.name = "FatalPluginRuntimeError";
    this.operation = operation;
    this.resourceDiagnostic = resourceDiagnostic;
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
  waitForPluginMutations(options?: PluginMutationWaitOptions): Promise<RuntimeSnapshot>;
  unloadAllPlugins(): Promise<RuntimeSnapshot>;
  unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot>;
  close(): Promise<void>;
}

export type PluginRuntimeFactory = (
  vaultPath: string,
  actions: ActionRegistry,
) => Promise<PluginRuntimePort>;
