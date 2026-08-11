export const ipcChannels = {
  snapshot: "threadleaf:snapshot",
  snapshotChanged: "threadleaf:snapshot-changed",
  chooseVault: "threadleaf:choose-vault",
  openNote: "threadleaf:open-note",
  saveNote: "threadleaf:save-note",
  runCommand: "threadleaf:run-command",
  reloadPlugin: "threadleaf:reload-plugin",
  unloadPlugin: "threadleaf:unload-plugin",
} as const;
