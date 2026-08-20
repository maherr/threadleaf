import type { PluginHost } from "../runtime/plugin-host";
import type {
  PluginConstructionPolicyResolverPort,
  PluginRuntimePort,
} from "../runtime/plugin-runtime-port";
import type {
  PluginEditorContext,
  PluginMutationWaitOptions,
  RuntimeSnapshot,
} from "../shared/contracts";
import type { PluginConstructionRequest } from "../shared/plugins";

export class PolicyEnforcingPluginHost implements PluginRuntimePort {
  constructor(
    private readonly host: PluginHost,
    private readonly resolver: PluginConstructionPolicyResolverPort,
  ) {}

  async loadPlugin(request: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    return this.host.loadAuthorizedPlugin(await this.resolver.resolveAndConsume(request));
  }

  async reloadPlugin(request?: PluginConstructionRequest): Promise<RuntimeSnapshot> {
    if (!request) {
      throw new Error("Plugin reload requires an exact package construction request.");
    }
    return this.host.reloadAuthorizedPlugin(await this.resolver.resolveAndConsume(request));
  }

  getSnapshot() {
    return this.host.getSnapshot();
  }

  closePluginView() {
    return this.host.closePluginView();
  }

  markLayoutReady() {
    return this.host.markLayoutReady();
  }

  openPluginSettings(pluginId: string) {
    return this.host.openPluginSettings(pluginId);
  }

  openPluginView(viewType: string, filePath?: string) {
    return this.host.openPluginView(viewType, filePath);
  }

  renderMarkdownProjection(pluginId: string, sourcePath: string, content: string) {
    return this.host.renderMarkdownProjection(pluginId, sourcePath, content);
  }

  runCommand(commandId: string, editorContext?: PluginEditorContext) {
    return this.host.runCommand(commandId, editorContext);
  }

  runPluginEditorPaste(editorContext: PluginEditorContext, clipboardText: string) {
    return this.host.runPluginEditorPaste(editorContext, clipboardText);
  }

  waitForPluginMutations(options?: PluginMutationWaitOptions) {
    return this.host.waitForPluginMutations(options);
  }

  unloadAllPlugins() {
    return this.host.unloadAllPlugins();
  }

  unloadPlugin(pluginId?: string) {
    return this.host.unloadPlugin(pluginId);
  }

  close() {
    return this.host.close();
  }
}
