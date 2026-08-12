export const nativeMenuCommandIds = [
  "ui.command-palette",
  "settings.open-keybindings",
  "workspace.open-vault",
  "workspace.create-note",
  "workspace.close-tab",
  "workspace.split-right",
  "workspace.split-down",
  "workspace.move-tab-to-other-pane",
  "workspace.close-pane",
  "workspace.next-tab",
  "workspace.previous-tab",
  "workspace.focus-note-filter",
  "editor.save-note",
  "editor.revert-note",
  "editor.toggle-reading-view",
  "editor.toggle-source-mode",
  "appearance.toggle-theme",
  "appearance.reload-custom-css",
  "support.export-bundle",
] as const;

export type NativeMenuCommandId = (typeof nativeMenuCommandIds)[number];
