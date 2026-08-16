import type { ActionRegistry } from "../application/action-registry";
import type { VaultReadPort } from "../kernel/ports";
import type {
  PluginEditorContext,
  PluginMutationWaitOptions,
  PluginResourceDiagnostic,
  RuntimeSnapshot,
} from "../shared/contracts";
import type { PluginConstructionDispatch, PluginConstructionRequest } from "../shared/plugins";
import type { CompatibilityVaultWritePort } from "./obsidian-compat";

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
  loadPlugin(request: PluginConstructionRequest): Promise<RuntimeSnapshot>;
  markLayoutReady(): Promise<RuntimeSnapshot>;
  openPluginSettings(pluginId: string): Promise<RuntimeSnapshot>;
  openPluginView(viewType: string, filePath?: string): Promise<RuntimeSnapshot>;
  reloadPlugin(request?: PluginConstructionRequest): Promise<RuntimeSnapshot>;
  /**
   * Render `content` through exactly `pluginId`'s currently registered Markdown post processors
   * inside the trusted compatibility renderer and return the settled (already-awaited, non-live)
   * result via `RuntimeSnapshot.markdownProjection`. Rejects if the plugin is not loaded, its
   * processor throws, or the operation deadline elapses; never returns a partial or unprocessed
   * projection silently.
   *
   * Optional so existing fixtures and fakes that predate this capability keep satisfying the
   * port; every production implementation (`PluginHost`, `IsolatedPluginRuntime`,
   * `RecoveringPluginRuntime`, `ElectronPluginRuntime`) always provides it.
   */
  renderMarkdownProjection?(
    pluginId: string,
    sourcePath: string,
    content: string,
  ): Promise<RuntimeSnapshot>;
  runCommand(commandId: string, editorContext?: PluginEditorContext): Promise<RuntimeSnapshot>;
  waitForPluginMutations(options?: PluginMutationWaitOptions): Promise<RuntimeSnapshot>;
  unloadAllPlugins(): Promise<RuntimeSnapshot>;
  unloadPlugin(pluginId?: string): Promise<RuntimeSnapshot>;
  close(): Promise<void>;
}

export interface PluginConstructionPolicyResolverPort {
  resolveAndConsume(request: PluginConstructionRequest): Promise<PluginConstructionDispatch>;
}

export type PluginRuntimeFactory = (
  vaultPath: string,
  actions: ActionRegistry,
  vault?: VaultReadPort & CompatibilityVaultWritePort,
) => Promise<PluginRuntimePort>;
