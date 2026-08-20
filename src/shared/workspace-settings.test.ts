import { describe, expect, it } from "vitest";
import { createDefaultAppSettings, parseAppSettings } from "./key-bindings";
import {
  createDefaultVaultWorkspaceSettings,
  defaultNotePath,
  parseVaultWorkspaceMode,
  parseVaultWorkspaceSettings,
} from "./workspace-settings";

describe("workspace settings", () => {
  it("returns bounded defaults and prefixes only bare new-note names", () => {
    expect(createDefaultVaultWorkspaceSettings()).toEqual({
      defaultNoteFolder: "",
      attachmentFolder: "",
      linkStyle: "preserve",
      automaticLinkUpdates: "ask",
      confirmDelete: "always",
      newTabBehavior: "focus",
      editorMode: "live",
      documentView: "live",
      showInlineTitle: true,
      readableLineLength: true,
      showLineNumbers: false,
      spellcheck: true,
      tabSize: 2,
      showStatusBar: true,
      restorePolicy: "restore",
    });
    expect(defaultNotePath("Notes/Inbox", "New note.md")).toBe("Notes/Inbox/New note.md");
    expect(defaultNotePath("Notes/Inbox", "Projects/New note.md")).toBe("Projects/New note.md");
  });

  it("rejects paths that could escape or target private vault state", () => {
    const defaults = createDefaultVaultWorkspaceSettings();
    expect(() =>
      parseVaultWorkspaceSettings({ ...defaults, defaultNoteFolder: "../outside" }),
    ).toThrow("cannot leave");
    expect(() =>
      parseVaultWorkspaceSettings({ ...defaults, defaultNoteFolder: ".obsidian" }),
    ).toThrow("hidden or private");
    expect(() => parseVaultWorkspaceSettings({ ...defaults, linkStyle: "html" })).toThrow(
      "Link style",
    );
    expect(() =>
      parseVaultWorkspaceSettings({ ...defaults, attachmentFolder: ".obsidian/assets" }),
    ).toThrow("hidden or private");
    expect(() => parseVaultWorkspaceSettings({ ...defaults, tabSize: 3 })).toThrow(
      "Editor tab size",
    );
  });

  it("migrates older vault preferences to the current visible defaults", () => {
    const defaults = createDefaultVaultWorkspaceSettings();
    const {
      attachmentFolder: _attachmentFolder,
      readableLineLength: _readableLineLength,
      showInlineTitle: _showInlineTitle,
      showLineNumbers: _showLineNumbers,
      showStatusBar: _showStatusBar,
      spellcheck: _spellcheck,
      tabSize: _tabSize,
      ...older
    } = defaults;
    expect(parseVaultWorkspaceSettings(older)).toEqual(defaults);
  });

  it("validates a mode update without accepting unrelated workspace fields", () => {
    expect(parseVaultWorkspaceMode({ editorMode: "source", documentView: "reading" })).toEqual({
      editorMode: "source",
      documentView: "reading",
    });
    expect(() => parseVaultWorkspaceMode({ editorMode: "reading", documentView: "live" })).toThrow(
      "Editor mode",
    );
    expect(() => parseVaultWorkspaceMode({ editorMode: "live", documentView: "plugin" })).toThrow(
      "Document view",
    );
  });

  it("migrates prior app settings without inventing vault preferences", () => {
    const previous = createDefaultAppSettings();
    const migrated = parseAppSettings({
      version: 5,
      keyBindings: previous.keyBindings,
      appearanceByVault: {},
      pluginsByVault: {},
      noteWorkflowsByVault: {},
    });
    expect(migrated.version).toBe(5);
    expect(migrated.workspaceByVault).toEqual({});
  });
});
