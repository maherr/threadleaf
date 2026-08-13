import type { MenuItemConstructorOptions } from "electron";
import type { AppSettings } from "../shared/key-bindings";
import type { NativeMenuCommandId } from "../shared/native-menu";

export interface ApplicationMenuOptions {
  dispatch(commandId: NativeMenuCommandId): void;
  platform: NodeJS.Platform;
  settings: AppSettings;
}

const electronKeyNames: Readonly<Record<string, string>> = {
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

export function electronAcceleratorForBinding(binding: string | null): string | undefined {
  if (!binding) {
    return undefined;
  }
  const tokens = binding.split("+");
  const key = tokens.pop();
  if (!key) {
    return undefined;
  }
  return [
    ...tokens.map((token) => (token === "Mod" ? "CmdOrCtrl" : token)),
    electronKeyNames[key] ?? key,
  ].join("+");
}

export function createApplicationMenuTemplate(
  options: ApplicationMenuOptions,
): MenuItemConstructorOptions[] {
  const action = (label: string, commandId: NativeMenuCommandId): MenuItemConstructorOptions => {
    const accelerator = electronAcceleratorForBinding(
      options.settings.keyBindings[commandId] ?? null,
    );
    return {
      label,
      ...(accelerator ? { accelerator } : {}),
      click: () => options.dispatch(commandId),
    };
  };
  const fileMenu: MenuItemConstructorOptions[] = [
    action("New Note", "workspace.create-note"),
    action("Open Today's Daily Note", "workspace.open-daily-note"),
    action("Open Vault…", "workspace.open-vault"),
    action("File Recovery…", "workspace.open-file-recovery"),
    { type: "separator" },
    action("Save Note", "editor.save-note"),
    action("Close Tab", "workspace.close-tab"),
  ];
  if (options.platform !== "darwin") {
    fileMenu.push(
      { type: "separator" },
      action("Settings…", "settings.open-keybindings"),
      { type: "separator" },
      { role: "quit" },
    );
  }

  const template: MenuItemConstructorOptions[] = [];
  if (options.platform === "darwin") {
    template.push({
      label: "Threadleaf",
      submenu: [
        { role: "about" },
        action("Settings…", "settings.open-keybindings"),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }
  template.push(
    { label: "File", submenu: fileMenu },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        action("Insert Template…", "editor.insert-template"),
        action("Insert Current Date", "editor.insert-current-date"),
        action("Insert Current Time", "editor.insert-current-time"),
      ],
    },
    {
      label: "Workspace",
      submenu: [
        action("Command Palette…", "ui.command-palette"),
        action("Search Vault", "workspace.focus-note-filter"),
        action("Toggle Note Bookmark", "workspace.toggle-note-bookmark"),
        { type: "separator" },
        action("Split Right", "workspace.split-right"),
        action("Split Down", "workspace.split-down"),
        action("Move Tab to Other Pane", "workspace.move-tab-to-other-pane"),
        action("Close Pane", "workspace.close-pane"),
        { type: "separator" },
        action("Next Tab", "workspace.next-tab"),
        action("Previous Tab", "workspace.previous-tab"),
      ],
    },
    {
      label: "View",
      submenu: [
        action("Open Vault Graph", "workspace.open-graph-view"),
        action("Open Local Graph", "workspace.open-local-graph"),
        { type: "separator" },
        action("Toggle Reading View", "editor.toggle-reading-view"),
        action("Toggle Live Preview or Source", "editor.toggle-source-mode"),
        action("Toggle Light or Dark Theme", "appearance.toggle-theme"),
        action("Reload Themes and CSS Snippets", "appearance.reload-custom-css"),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      role: "help",
      submenu: [
        action("Save Privacy-Safe Support Bundle…", "support.export-bundle"),
        ...(options.platform === "darwin"
          ? []
          : ([{ type: "separator" }, { role: "about" }] satisfies MenuItemConstructorOptions[])),
      ],
    },
  );
  return template;
}
