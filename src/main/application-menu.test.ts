import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createDefaultAppSettings } from "../shared/key-bindings";
import type { NativeMenuCommandId } from "../shared/native-menu";
import { createApplicationMenuTemplate, electronAcceleratorForBinding } from "./application-menu";

function submenu(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  const item = template.find((candidate) => candidate.label === label);
  if (!item || !Array.isArray(item.submenu)) {
    throw new Error(`Missing ${label} menu.`);
  }
  return item.submenu;
}

function item(
  template: MenuItemConstructorOptions[],
  menuLabel: string,
  itemLabel: string,
): MenuItemConstructorOptions {
  const match = submenu(template, menuLabel).find((candidate) => candidate.label === itemLabel);
  if (!match) {
    throw new Error(`Missing ${menuLabel} > ${itemLabel}.`);
  }
  return match;
}

describe("application menu", () => {
  it("translates saved cross-platform shortcuts into Electron accelerators", () => {
    expect(electronAcceleratorForBinding("Mod+Shift+L")).toBe("CmdOrCtrl+Shift+L");
    expect(electronAcceleratorForBinding("Mod+Comma")).toBe("CmdOrCtrl+,");
    expect(electronAcceleratorForBinding("Alt+ArrowRight")).toBe("Alt+Right");
    expect(electronAcceleratorForBinding(null)).toBeUndefined();
  });

  it("builds Linux desktop menus from the persisted shortcut settings", () => {
    const dispatch = vi.fn<(commandId: NativeMenuCommandId) => void>();
    const settings = createDefaultAppSettings();
    settings.keyBindings["workspace.create-note"] = "Alt+N";
    const template = createApplicationMenuTemplate({ dispatch, platform: "linux", settings });

    expect(template.map(({ label, role }) => label ?? role)).toEqual([
      "File",
      "Edit",
      "Workspace",
      "View",
      "help",
    ]);
    expect(item(template, "File", "New Note").accelerator).toBe("Alt+N");
    expect(item(template, "File", "Open Today's Daily Note").accelerator).toBeUndefined();
    expect(item(template, "File", "Save Note").accelerator).toBe("CmdOrCtrl+S");
    expect(item(template, "File", "Export Note as HTML…").accelerator).toBeUndefined();
    expect(submenu(template, "Edit").map(({ label, role, type }) => label ?? role ?? type)).toEqual(
      [
        "undo",
        "redo",
        "separator",
        "cut",
        "copy",
        "paste",
        "selectAll",
        "separator",
        "Insert Template…",
        "Insert Current Date",
        "Insert Current Time",
      ],
    );
    expect(item(template, "Edit", "Insert Template…").accelerator).toBeUndefined();
    expect(item(template, "Workspace", "Split Right").accelerator).toBeUndefined();
    expect(item(template, "Workspace", "Toggle Pin for Current Tab").accelerator).toBeUndefined();
    expect(item(template, "Workspace", "Quick Switcher…").accelerator).toBe("CmdOrCtrl+Shift+O");
    expect(item(template, "Workspace", "Go Back in Note History").accelerator).toBe("CmdOrCtrl+[");
    expect(item(template, "Workspace", "Go Forward in Note History").accelerator).toBe(
      "CmdOrCtrl+]",
    );

    item(template, "Workspace", "Split Right").click?.({} as never, undefined, {} as never);
    expect(dispatch).toHaveBeenCalledWith("workspace.split-right");
    item(template, "Workspace", "Toggle Pin for Current Tab").click?.(
      {} as never,
      undefined,
      {} as never,
    );
    expect(dispatch).toHaveBeenCalledWith("workspace.toggle-tab-pin");
  });

  it("places settings and quit in the macOS application menu", () => {
    const template = createApplicationMenuTemplate({
      dispatch: vi.fn(),
      platform: "darwin",
      settings: createDefaultAppSettings(),
    });

    expect(template[0]?.label).toBe("Threadleaf");
    expect(
      submenu(template, "Threadleaf").map(({ label, role, type }) => label ?? role ?? type),
    ).toEqual([
      "about",
      "Settings…",
      "separator",
      "services",
      "separator",
      "hide",
      "hideOthers",
      "unhide",
      "separator",
      "quit",
    ]);
    expect(submenu(template, "File").some(({ role }) => role === "quit")).toBe(false);
  });
});
