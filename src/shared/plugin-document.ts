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
 * Resolve the custom-file contract admitted to workspace tabs.
 *
 * Only a currently loaded view registration grants this path. The workspace then applies the
 * same bounded binary read, revision, persistence, history, and renderer-isolation contract used
 * by the measured Excalidraw path, rather than treating an arbitrary opaque file as a document.
 */
export function workspacePluginViewTypeForPath(
  filePath: string,
  integrations: PluginIntegrationSnapshot | null | undefined,
): string | null {
  return pluginViewTypeForPath(filePath, integrations);
}
