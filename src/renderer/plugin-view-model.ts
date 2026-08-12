import type { PluginIntegrationSnapshot } from "../shared/contracts";

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
