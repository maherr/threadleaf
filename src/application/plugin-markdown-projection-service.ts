import { createHash } from "node:crypto";
import { normalizePath } from "../runtime/obsidian-compat";
import type { PluginMarkdownProjectionResponse, RuntimeSnapshot } from "../shared/contracts";
import { parsePluginDiagnosticMessage } from "../shared/plugin-diagnostics";
import { DEFAULT_VAULT_NOTE_EMBED_MAX_BYTES } from "./note-embed-service";

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

/**
 * Matches the note-embed service's own per-source-note cap (`DEFAULT_VAULT_NOTE_EMBED_MAX_BYTES`,
 * 2 MiB): both bound one note's content entering a compatibility-adjacent read/render path.
 */
const maxContentBytes = DEFAULT_VAULT_NOTE_EMBED_MAX_BYTES;

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
 * A cheap, typed signal for "this render hit its operation deadline", read from the same
 * `resourceDiagnostics` the compatibility-host resource policy already produces. This is
 * necessary, not cosmetic: `RecoveringPluginRuntime` absorbs a `FatalPluginRuntimeError` deadline
 * breach internally (see its `recover()`) and returns a *resolved* snapshot from a fresh renderer
 * -- `markdownProjection` is simply absent, `renderMarkdownProjection` never rejects. A
 * message-regex match on a caught error would therefore never fire for a real deadline breach in
 * the production `IsolatedPluginRuntime -> RecoveringPluginRuntime -> ElectronPluginRuntime`
 * chain; only this snapshot-level check can distinguish a real timeout from an ordinary
 * processor failure or identity mismatch.
 */
function timedOutFor(snapshot: RuntimeSnapshot, pluginId: string): boolean {
  return (snapshot.resourceDiagnostics ?? []).some(
    (diagnostic) =>
      diagnostic.reason === "operation-deadline" &&
      diagnostic.operation === "render-markdown" &&
      (diagnostic.pluginId === undefined || diagnostic.pluginId === pluginId),
  );
}

/**
 * Request an explicit settled Markdown post-processor projection for exactly `pluginId` against
 * `content`, bound to `expectedVaultId`. This is a bounded, plugin-exact settled Reading
 * projection: it runs the plugin's already-registered processors to completion in the isolated
 * compatibility renderer and returns their settled HTML, never a live callback or partially
 * processed content. The returned `html` is UNSANITIZED plugin output -- sanitizing it before
 * display is the caller's obligation (see `sanitizePluginMarkdownProjection` in
 * `src/renderer/markdown-preview.ts`).
 *
 * Every non-`ready` result names a specific, honest cause instead of silently falling back to
 * unprocessed content:
 * - `stale-vault` when the active vault changed before or after the render (checked before the
 *   round trip and again after, so a vault switch mid-flight cannot apply a stale result);
 * - `too-large` when `content` exceeds {@link maxContentBytes} (checked before any round trip, so
 *   an oversized note is never sent to the compatibility renderer at all);
 * - `plugin-disabled` when `pluginId` is not currently loaded (not installed, not enabled, or
 *   unloaded through recovery) -- reported from a fresh snapshot rather than a cached guess;
 * - `timeout` when the renderer did not settle the projection before its operation deadline
 *   (detected from the typed `resourceDiagnostics` signal, not a message guess -- see
 *   {@link timedOutFor});
 * - `processor-error` for every other failure: the plugin's registered processor threw, its
 *   settled HTML exceeded the compatibility host's own output cap, or the render returned a
 *   projection whose plugin ID, source path, or content hash does not match this exact request.
 *   That last check is load-bearing: it is what actually enforces the "bound to
 *   `pluginId` + `sourcePath` + `contentSha256`" identity `PluginMarkdownProjectionSnapshot`
 *   promises, rather than only asserting it in a comment.
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

  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > maxContentBytes) {
    return unavailable(
      runtime.vaultId,
      pluginId,
      "too-large",
      `The note is larger than the ${Math.floor(maxContentBytes / (1024 * 1024))} MiB settled-projection limit.`,
    );
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
  if (plugin?.state !== "loaded") {
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
    // A typed diagnostic code, not a message-text guess: pluginDiagnosticError always throws its
    // stable per-code template (see plugin-diagnostics.ts) rather than forwarding a cause's raw
    // text as UI-facing wording, and the non-enumerable code itself does not survive IPC. The
    // `[code].` suffix in that reconstructed message does survive, and parsePluginDiagnosticMessage
    // is the codebase's own established way to recover it reliably. Unlike a deadline breach
    // (absorbed by RecoveringPluginRuntime's recovery, never a rejection -- see timedOutFor),
    // PluginHost's own outbound-cap throw is an ordinary synchronous rejection from *this*
    // renderer, so it reliably reaches this catch block.
    const reason =
      parsePluginDiagnosticMessage(message)?.code === "runtime-render-too-large"
        ? "too-large"
        : "processor-error";
    return unavailable(
      runtime.vaultId,
      pluginId,
      reason,
      reason === "too-large"
        ? `${plugin.name}'s settled Markdown projection was too large to return.`
        : `${plugin.name}'s registered Markdown post processor failed while rendering this note.`,
    );
  }
  if (expectedVaultId !== runtime.vaultId) {
    return { status: "stale-vault", vaultId: runtime.vaultId };
  }

  const expectedSourcePath = normalizePath(sourceNotePath);
  const expectedContentSha256 = createHash("sha256").update(content, "utf8").digest("hex");
  const projection = snapshot.markdownProjection;
  if (
    !projection ||
    projection.pluginId !== pluginId ||
    projection.sourcePath !== expectedSourcePath ||
    projection.contentSha256 !== expectedContentSha256
  ) {
    if (timedOutFor(snapshot, pluginId)) {
      return unavailable(
        runtime.vaultId,
        pluginId,
        "timeout",
        `${plugin.name} did not settle a Markdown projection before its operation deadline.`,
      );
    }
    return unavailable(
      runtime.vaultId,
      pluginId,
      "processor-error",
      `${plugin.name} did not return a settled Markdown projection for this exact note and content.`,
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
