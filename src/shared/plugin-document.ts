import type { PluginIntegrationSnapshot } from "./contracts";

/** The native scene format currently covered by Threadleaf's measured custom-document workflow. */
export function isNativeExcalidrawPath(filePath: string): boolean {
  return filePath.toLocaleLowerCase("en-US").endsWith(".excalidraw");
}

/**
 * Resolve the custom view a loaded compatibility plugin registered for a vault path.
 *
 * Excalidraw Markdown documents predate the extension registry and keep their explicit
 * public contract. Native and other plugin-owned files use the ordinary registered-extension
 * path. A view must be present in the same integration snapshot as the registration so a stale
 * extension row cannot expose a view that is no longer loaded.
 */
export function pluginViewTypeForPath(
  filePath: string,
  integrations: PluginIntegrationSnapshot | null | undefined,
): string | null {
  const viewTypes = integrations?.viewTypes ?? [];
  if (viewTypes.length === 0) {
    return null;
  }
  const lowerPath = filePath.toLocaleLowerCase("en-US");
  if (lowerPath.endsWith(".excalidraw.md") && viewTypes.includes("excalidraw")) {
    return "excalidraw";
  }
  const extension = lowerPath.includes(".") ? (lowerPath.split(".").at(-1) ?? "") : "";
  const registeredView = integrations?.extensions.find(
    (registration) => registration.extension.toLocaleLowerCase("en-US") === extension,
  )?.viewType;
  return registeredView && viewTypes.includes(registeredView) ? registeredView : null;
}

/**
 * Resolve the deliberately narrow custom-file contract admitted to workspace tabs.
 *
 * A plugin may register other extensions for previews or future integrations, but that does not
 * make every opaque file a durable workspace document. Expanding this boundary requires its own
 * persistence, history, byte-limit, and renderer proof rather than inheriting Excalidraw's proof.
 */
export function workspacePluginViewTypeForPath(
  filePath: string,
  integrations: PluginIntegrationSnapshot | null | undefined,
): string | null {
  return isNativeExcalidrawPath(filePath) ? pluginViewTypeForPath(filePath, integrations) : null;
}
