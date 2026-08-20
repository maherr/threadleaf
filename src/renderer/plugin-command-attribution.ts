export function commandsOwnedByPlugin<T extends { id: string }>(
  commands: readonly T[],
  pluginId: string | null | undefined,
): T[] {
  if (!pluginId) return [];
  const prefix = `${pluginId}:`;
  return commands.filter((command) => command.id.startsWith(prefix));
}
