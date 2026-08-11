import { describe, expect, it } from "vitest";
import {
  bindingFromKeyboardEvent,
  createDefaultAppSettings,
  displayKeyBinding,
  eventMatchesKeyBinding,
  normalizeKeyBinding,
  parseAppSettings,
  shortcutTargetForEvent,
  updateKeyBinding,
} from "./key-bindings";

const ctrl = {
  key: "k",
  ctrlKey: true,
  metaKey: false,
  altKey: false,
  shiftKey: false,
};

describe("key bindings", () => {
  it("normalizes supported chords and rejects unsafe or ambiguous input", () => {
    expect(normalizeKeyBinding("shift + mod + l")).toBe("Mod+Shift+L");
    expect(normalizeKeyBinding("mod+,")).toBe("Mod+Comma");
    expect(normalizeKeyBinding("mod+shift+tab")).toBe("Mod+Shift+Tab");
    expect(() => normalizeKeyBinding("Shift+K")).toThrow("Mod or Alt");
    expect(() => normalizeKeyBinding("Mod+Mod+K")).toThrow("repeated");
    expect(() => normalizeKeyBinding("Ctrl+K")).toThrow("Unsupported shortcut modifier");
    expect(() => normalizeKeyBinding("Mod+Space")).toThrow("Unsupported shortcut key");
  });

  it("fills new defaults, normalizes saved values, and rejects collisions", () => {
    const parsed = parseAppSettings({
      version: 1,
      keyBindings: {
        "ui.command-palette": "alt + k",
        "future.plugin-command": "mod + f8",
      },
    });

    expect(parsed.keyBindings["ui.command-palette"]).toBe("Alt+K");
    expect(parsed.keyBindings["workspace.open-vault"]).toBe("Mod+O");
    expect(parsed.keyBindings["workspace.create-note"]).toBe("Mod+N");
    expect(parsed.keyBindings["workspace.move-note"]).toBe("Mod+Shift+M");
    expect(parsed.keyBindings["workspace.close-tab"]).toBe("Mod+W");
    expect(parsed.keyBindings["workspace.next-tab"]).toBe("Alt+ArrowRight");
    expect(parsed.keyBindings["workspace.previous-tab"]).toBe("Alt+ArrowLeft");
    expect(parsed.keyBindings["editor.toggle-reading-view"]).toBe("Mod+E");
    expect(parsed.keyBindings["future.plugin-command"]).toBe("Mod+F8");
    expect(() =>
      parseAppSettings({
        version: 1,
        keyBindings: {
          "ui.command-palette": "Mod+O",
        },
      }),
    ).toThrow("already assigned");
  });

  it("updates one target without mutating the previous settings", () => {
    const original = createDefaultAppSettings();
    const updated = updateKeyBinding(original, "editor.revert-note", "Alt+R");

    expect(updated.keyBindings["editor.revert-note"]).toBe("Alt+R");
    expect(original.keyBindings["editor.revert-note"]).toBeNull();
    expect(() => updateKeyBinding(original, "editor.revert-note", "Mod+S")).toThrow(
      "editor.save-note",
    );
  });

  it("captures portable bindings and matches the platform primary modifier exactly", () => {
    expect(bindingFromKeyboardEvent(ctrl, false)).toBe("Mod+K");
    expect(bindingFromKeyboardEvent({ ...ctrl, key: "," }, false)).toBe("Mod+Comma");
    expect(bindingFromKeyboardEvent({ ...ctrl, key: "Tab" }, false)).toBe("Mod+Tab");
    expect(bindingFromKeyboardEvent({ ...ctrl, ctrlKey: false }, false)).toBeNull();
    expect(bindingFromKeyboardEvent(ctrl, true)).toBeNull();

    expect(eventMatchesKeyBinding(ctrl, "Mod+K", false)).toBe(true);
    expect(eventMatchesKeyBinding({ ...ctrl, metaKey: true }, "Mod+K", false)).toBe(false);
    expect(eventMatchesKeyBinding({ ...ctrl, ctrlKey: false, metaKey: true }, "Mod+K", true)).toBe(
      true,
    );
    expect(shortcutTargetForEvent(createDefaultAppSettings().keyBindings, ctrl, false)).toBe(
      "ui.command-palette",
    );
    expect(
      shortcutTargetForEvent(
        createDefaultAppSettings().keyBindings,
        {
          ...ctrl,
          key: "ArrowLeft",
          ctrlKey: false,
          altKey: true,
        },
        false,
      ),
    ).toBe("workspace.previous-tab");
  });

  it("formats bindings for the active platform", () => {
    expect(displayKeyBinding("Mod+Shift+L", false)).toBe("Ctrl Shift L");
    expect(displayKeyBinding("Mod+Shift+L", true)).toBe("⌘⇧L");
    expect(displayKeyBinding("Mod+Comma", true)).toBe("⌘,");
    expect(displayKeyBinding(null, false)).toBe("Unassigned");
  });
});
