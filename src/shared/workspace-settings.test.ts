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
      linkStyle: "preserve",
      automaticLinkUpdates: "ask",
      confirmDelete: "always",
      newTabBehavior: "focus",
      editorMode: "live",
      documentView: "live",
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
