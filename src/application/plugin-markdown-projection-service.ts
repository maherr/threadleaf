import type { PluginMarkdownProjectionResponse, RuntimeSnapshot } from "../shared/contracts";

/**
 * The minimal plugin-runtime surface {@link renderPluginMarkdownProjection} needs. A
 * `WorkspaceRuntime` satisfies this by pairing its own `vaultId` with `this.pluginHost`'s
 * existing `getSnapshot` and `renderMarkdownProjection` methods; tests may supply a stub.
 */
export interface PluginMarkdownProjectionRuntime {
  readonly vaultId: string;
  getSnapshot(): Promise<RuntimeSnapshot>;
  renderMarkdownProjection(
    pluginId: string,
    sourcePath: string,
    content: string,
  ): Promise<RuntimeSnapshot>;
}

function unavailable(
  vaultId: string,
  pluginId: string,
  reason: Extract<PluginMarkdownProjectionResponse, { status: "unavailable" }>["reason"],
  message: string,
): PluginMarkdownProjectionResponse {
  return { status: "unavailable", vaultId, pluginId, reason, message };
}

function currentPlugins(snapshot: RuntimeSnapshot): RuntimeSnapshot["plugins"] {
  return snapshot.plugins ?? (snapshot.plugin ? [snapshot.plugin] : []);
}

/**
 * Request an explicit settled Markdown post-processor projection for exactly `pluginId` against
 * `content`, bound to `expectedVaultId`. This is a bounded, plugin-exact settled Reading
 * projection: it runs the plugin's already-registered processors to completion in the isolated
 * compatibility renderer and returns their sanitizer-bound HTML, never a live callback or
 * partially processed content.
 *
 * Every non-`ready` result names a specific, honest cause instead of silently falling back to
 * unprocessed content:
 * - `stale-vault` when the active vault changed before or after the render (checked both before
 *   the round trip and again after, so a vault switch mid-flight cannot apply a stale result);
 * - `plugin-disabled` when `pluginId` is not currently loaded (not installed, not enabled, or
 *   unloaded through recovery) -- reported from a fresh snapshot rather than a cached guess;
 * - `processor-error` when the plugin's registered processor threw, the render returned a
 *   different plugin's or path's projection, or the compatibility renderer failed for any other
 *   reason;
 * - `timeout` when the renderer did not settle the projection before its operation deadline.
 */
export async function renderPluginMarkdownProjection(
  runtime: PluginMarkdownProjectionRuntime,
  pluginId: string,
  sourceNotePath: string,
  content: string,
  expectedVaultId: string,
): Promise<PluginMarkdownProjectionResponse> {
  if (expectedVaultId !== runtime.vaultId) {
    return { status: "stale-vault", vaultId: runtime.vaultId };
  }

  let beforeSnapshot: RuntimeSnapshot;
  try {
    beforeSnapshot = await runtime.getSnapshot();
  } catch {
    return unavailable(
      runtime.vaultId,
      pluginId,
      "processor-error",
      "The compatibility runtime could not report its current plugin state.",
    );
  }
  if (expectedVaultId !== runtime.vaultId) {
    return { status: "stale-vault", vaultId: runtime.vaultId };
  }
  const plugin = currentPlugins(beforeSnapshot)?.find((candidate) => candidate.id === pluginId);
  if (!plugin || plugin.state !== "loaded") {
    return unavailable(
      runtime.vaultId,
      pluginId,
      "plugin-disabled",
      plugin
        ? `${plugin.name} is not currently active in the compatibility runtime.`
        : `${pluginId} is not installed or enabled in this vault.`,
    );
  }

  let snapshot: RuntimeSnapshot;
  try {
    snapshot = await runtime.renderMarkdownProjection(pluginId, sourceNotePath, content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /timed out/u.test(message) ? "timeout" : "processor-error";
    return unavailable(
      runtime.vaultId,
      pluginId,
      reason,
      reason === "timeout"
        ? `${plugin.name} did not settle a Markdown projection before its operation deadline.`
        : `${plugin.name}'s registered Markdown post processor failed while rendering this note.`,
    );
  }
  if (expectedVaultId !== runtime.vaultId) {
    return { status: "stale-vault", vaultId: runtime.vaultId };
  }

  const projection = snapshot.markdownProjection;
  if (!projection || projection.pluginId !== pluginId) {
    return unavailable(
      runtime.vaultId,
      pluginId,
      "processor-error",
      `${plugin.name} did not return a settled Markdown projection for this note.`,
    );
  }
  return {
    status: "ready",
    vaultId: runtime.vaultId,
    pluginId,
    sourcePath: projection.sourcePath,
    contentSha256: projection.contentSha256,
    html: projection.html,
    postProcessorCount: projection.postProcessorCount,
  };
}
