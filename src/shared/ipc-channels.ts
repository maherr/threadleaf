export const ipcChannels = {
  snapshot: "threadleaf:snapshot",
  snapshotChanged: "threadleaf:snapshot-changed",
  openNote: "threadleaf:open-note",
  runCommand: "threadleaf:run-command",
  reloadPlugin: "threadleaf:reload-plugin",
  unloadPlugin: "threadleaf:unload-plugin",
} as const;
