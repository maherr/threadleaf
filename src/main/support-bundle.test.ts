import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppUpdateSnapshot } from "../shared/app-updates";
import type { RuntimeSnapshot } from "../shared/contracts";
import { type AppSettingsSnapshot, defaultKeyBindings } from "../shared/key-bindings";
import {
  createSupportBundleData,
  createSupportBundleMarkdown,
  isSupportBundleTargetOutsideVault,
  readDevelopmentSupportBundlePath,
} from "./support-bundle";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const vaultId = "a".repeat(64);
const pluginBundleHash = "b".repeat(64);

const privateCanaries = [
  "PRIVATE_VAULT_NAME",
  "/private/vault/path",
  "PRIVATE_STARTUP_NAME",
  "/private/startup/path",
  "PRIVATE_NOTE_PATH.md",
  "PRIVATE_NOTE_TITLE",
  "PRIVATE_NOTE_CONTENT",
  "PRIVATE_NOTE_REVISION",
  "PRIVATE_TAG",
  "PRIVATE_HEADING",
  "PRIVATE_LINK_LABEL",
  "PRIVATE_LINK_TARGET",
  "PRIVATE_BACKLINK.md",
  "PRIVATE_PLUGIN_ID",
  "PRIVATE_PLUGIN_NAME",
  "PRIVATE_PLUGIN_VERSION",
  "PRIVATE_PLUGIN_ERROR",
  "PRIVATE_COMMAND_ID",
  "PRIVATE_COMMAND_NAME",
  "PRIVATE_COMMAND_OWNER",
  "PRIVATE_ACTION_ID",
  "PRIVATE_ACTION_NAME",
  "PRIVATE_NOTICE",
  "PRIVATE_EVENT_MESSAGE",
  "PRIVATE_EXTENSION",
  "PRIVATE_VIEW_TYPE",
  "PRIVATE_SETTING_TAB_PLUGIN",
  "PRIVATE_SURFACE_TEXT",
  "PRIVATE_SURFACE_PATH",
  "PRIVATE_SETTINGS_WARNING",
  "PRIVATE_THEME_ID",
  "PRIVATE_SNIPPET_ID",
  "PRIVATE_UPDATE_MESSAGE",
  "PRIVATE_AVAILABLE_VERSION",
  vaultId,
  pluginBundleHash,
] as const;

function runtimeFixture(): RuntimeSnapshot {
  return {
    vault: {
      id: vaultId,
      name: "PRIVATE_VAULT_NAME",
      path: "/private/vault/path",
      markdownFileCount: 42,
      mode: "kernel-backed",
      source: "environment",
      warning: "PRIVATE_VAULT_WARNING",
    },
    startup: {
      phase: "opening",
      source: "environment",
      targetName: "PRIVATE_STARTUP_NAME",
      targetPath: "/private/startup/path",
    },
    plugin: null,
    plugins: [
      {
        id: "PRIVATE_PLUGIN_ID",
        name: "PRIVATE_PLUGIN_NAME",
        version: "PRIVATE_PLUGIN_VERSION",
        state: "loaded",
        compatibilityLevel: 4,
        stylesheetDiscovered: true,
        error: null,
      },
      {
        id: "PRIVATE_PLUGIN_ID_TWO",
        name: "PRIVATE_PLUGIN_NAME_TWO",
        version: "PRIVATE_PLUGIN_VERSION_TWO",
        state: "loaded",
        compatibilityLevel: 2,
        stylesheetDiscovered: false,
        error: null,
      },
      {
        id: "PRIVATE_PLUGIN_ID_THREE",
        name: "PRIVATE_PLUGIN_NAME_THREE",
        version: "PRIVATE_PLUGIN_VERSION_THREE",
        state: "failed",
        compatibilityLevel: 0,
        stylesheetDiscovered: false,
        error: "PRIVATE_PLUGIN_ERROR",
      },
    ],
    commands: [
      {
        id: "PRIVATE_COMMAND_ID",
        name: "PRIVATE_COMMAND_NAME",
        ownerId: "PRIVATE_COMMAND_OWNER",
      },
      {
        id: "PRIVATE_COMMAND_ID_TWO",
        name: "PRIVATE_COMMAND_NAME_TWO",
        ownerId: "PRIVATE_COMMAND_OWNER_TWO",
      },
    ],
    actions: [
      { id: "PRIVATE_ACTION_ID", name: "PRIVATE_ACTION_NAME", source: "workspace" },
      { id: "PRIVATE_ACTION_ID_TWO", name: "PRIVATE_ACTION_NAME_TWO", source: "plugin" },
      { id: "PRIVATE_ACTION_ID_THREE", name: "PRIVATE_ACTION_NAME_THREE", source: "system" },
    ],
    notices: ["PRIVATE_NOTICE", "PRIVATE_NOTICE_TWO"],
    events: [
      { sequence: 1, kind: "runtime", message: "PRIVATE_EVENT_MESSAGE" },
      { sequence: 2, kind: "runtime", message: "PRIVATE_EVENT_MESSAGE_TWO" },
      { sequence: 3, kind: "plugin", message: "PRIVATE_EVENT_MESSAGE_THREE" },
      { sequence: 4, kind: "command", message: "PRIVATE_EVENT_MESSAGE_FOUR" },
      { sequence: 5, kind: "notice", message: "PRIVATE_EVENT_MESSAGE_FIVE" },
      { sequence: 6, kind: "error", message: "PRIVATE_EVENT_MESSAGE_SIX" },
    ],
    integrations: {
      editorSuggests: 2,
      extensions: [
        { extension: "PRIVATE_EXTENSION", viewType: "PRIVATE_VIEW_TYPE" },
        { extension: "PRIVATE_EXTENSION_TWO", viewType: "PRIVATE_VIEW_TYPE_TWO" },
      ],
      markdownPostProcessors: 3,
      ribbonItems: 4,
      settingTabs: 5,
      settingTabPluginIds: ["PRIVATE_SETTING_TAB_PLUGIN"],
      statusBarItems: 6,
      viewTypes: ["PRIVATE_VIEW_TYPE", "PRIVATE_VIEW_TYPE_TWO"],
    },
    editorUpdate: {
      baseContent: "PRIVATE_BASE_CONTENT",
      content: "PRIVATE_EDITOR_CONTENT",
      focused: true,
      id: "PRIVATE_EDITOR_ID",
      path: "PRIVATE_EDITOR_PATH.md",
      revision: "PRIVATE_EDITOR_REVISION",
      selection: { anchor: 3, head: 8 },
    },
    pluginSurface: {
      displayText: "PRIVATE_SURFACE_TEXT",
      filePath: "PRIVATE_SURFACE_PATH",
      viewType: "PRIVATE_VIEW_TYPE",
    },
    workspace: {
      state: "degraded",
      indexGeneration: 7,
      files: [
        {
          path: "PRIVATE_NOTE_PATH.md",
          title: "PRIVATE_NOTE_TITLE",
          tags: ["PRIVATE_TAG"],
          backlinkCount: 1,
          outgoingCount: 1,
          unresolvedCount: 1,
        },
      ],
      panes: [
        {
          id: "primary",
          active: true,
          tabs: [{ path: "PRIVATE_NOTE_PATH.md", title: "PRIVATE_NOTE_TITLE", active: true }],
          activeNote: {
            path: "PRIVATE_NOTE_PATH.md",
            title: "PRIVATE_NOTE_TITLE",
            content: "PRIVATE_NOTE_CONTENT",
            revision: "PRIVATE_NOTE_REVISION",
            tags: ["PRIVATE_TAG"],
            headings: [{ level: 1, text: "PRIVATE_HEADING", line: 1 }],
            outgoing: [
              {
                label: "PRIVATE_LINK_LABEL",
                status: "unresolved",
                target: "PRIVATE_LINK_TARGET",
              },
            ],
            backlinks: ["PRIVATE_BACKLINK.md"],
            properties: [
              {
                name: "PRIVATE_PROPERTY",
                type: "text",
                value: "PRIVATE_PROPERTY_VALUE",
                rawValue: "PRIVATE_PROPERTY_VALUE",
              },
            ],
            propertyEditor: { editable: false, message: "PRIVATE_PROPERTY_MESSAGE" },
          },
        },
      ],
      activePaneId: "primary",
      splitDirection: null,
      tabs: [{ path: "PRIVATE_NOTE_PATH.md", title: "PRIVATE_NOTE_TITLE", active: true }],
      activeNote: {
        path: "PRIVATE_NOTE_PATH.md",
        title: "PRIVATE_NOTE_TITLE",
        content: "PRIVATE_NOTE_CONTENT",
        revision: "PRIVATE_NOTE_REVISION",
        tags: ["PRIVATE_TAG"],
        headings: [{ level: 1, text: "PRIVATE_HEADING", line: 1 }],
        outgoing: [
          {
            label: "PRIVATE_LINK_LABEL",
            status: "unresolved",
            target: "PRIVATE_LINK_TARGET",
          },
        ],
        backlinks: ["PRIVATE_BACKLINK.md"],
        properties: [
          {
            name: "PRIVATE_PROPERTY",
            type: "text",
            value: "PRIVATE_PROPERTY_VALUE",
            rawValue: "PRIVATE_PROPERTY_VALUE",
          },
        ],
        propertyEditor: { editable: false, message: "PRIVATE_PROPERTY_MESSAGE" },
      },
      recoveryActionCount: 2,
      watcher: {
        lastSequence: 9,
        lastRescanReason: "PRIVATE_RESCAN_REASON",
        error: "PRIVATE_WATCHER_ERROR",
      },
    },
  };
}

function settingsFixture(): AppSettingsSnapshot {
  return {
    settings: {
      version: 5,
      keyBindings: {
        ...defaultKeyBindings,
        "ui.command-palette": "Mod+Shift+P",
        PRIVATE_BINDING_TARGET: "Mod+Alt+P",
      },
      appearanceByVault: {
        [vaultId]: {
          colorScheme: "dark",
          themeId: "obsidian-theme:PRIVATE_THEME_ID",
          enabledSnippetIds: ["obsidian-snippet:PRIVATE_SNIPPET_ID"],
        },
      },
      pluginsByVault: {
        [vaultId]: {
          compatibilityMode: "enabled",
          enabledPluginIds: ["PRIVATE_PLUGIN_ID"],
          capabilityGrantsByPlugin: {
            PRIVATE_PLUGIN_ID: {
              bundleSha256: pluginBundleHash,
              capabilities: ["vault-read", "workspace-ui"],
            },
          },
        },
      },
      noteWorkflowsByVault: {
        [vaultId]: {
          templateFolder: "PRIVATE_TEMPLATE_FOLDER",
          templateDateFormat: "PRIVATE_DATE_FORMAT",
          templateTimeFormat: "PRIVATE_TIME_FORMAT",
          dailyNoteFolder: "PRIVATE_DAILY_FOLDER",
          dailyNoteDateFormat: "PRIVATE_DAILY_FORMAT",
          dailyNoteTemplate: "PRIVATE_DAILY_TEMPLATE.md",
        },
      },
    },
    warning: "PRIVATE_SETTINGS_WARNING",
  };
}

const updateFixture: AppUpdateSnapshot = {
  phase: "available",
  currentVersion: "0.1.0-alpha.1",
  availableVersion: "PRIVATE_AVAILABLE_VERSION",
  checkedAt: "PRIVATE_CHECKED_AT",
  disabledReason: null,
  message: "PRIVATE_UPDATE_MESSAGE",
  progress: {
    bytesPerSecond: 123,
    percent: 45,
    transferred: 456,
    total: 789,
  },
  canCheck: true,
  canDownload: true,
  canInstall: false,
};

const supportInput = {
  appearanceSafeMode: true,
  environment: {
    appVersion: "0.1.0-alpha.1",
    architecture: "x64",
    chromiumVersion: "140.0.0",
    electronVersion: "43.3.0",
    nodeVersion: "22.0.0",
    osRelease: "6.18.0",
    packaged: false,
    platform: "linux",
    updateTrust: "none" as const,
  },
  generatedAt: "2026-08-12T17:00:00.000Z",
  pluginSafeMode: false,
  runtime: runtimeFixture(),
  settings: settingsFixture(),
  update: updateFixture,
};

describe("support bundle", () => {
  it("accepts an absolute development export path only in unpackaged builds", () => {
    expect(
      readDevelopmentSupportBundlePath(false, {
        THREADLEAF_SUPPORT_BUNDLE_PATH: " /tmp/threadleaf-support.md ",
      }),
    ).toBe("/tmp/threadleaf-support.md");
    expect(readDevelopmentSupportBundlePath(false, {})).toBeUndefined();
    expect(
      readDevelopmentSupportBundlePath(true, {
        THREADLEAF_SUPPORT_BUNDLE_PATH: "/tmp/threadleaf-support.md",
      }),
    ).toBeUndefined();
    expect(() =>
      readDevelopmentSupportBundlePath(false, {
        THREADLEAF_SUPPORT_BUNDLE_PATH: "relative-report.md",
      }),
    ).toThrow("must be absolute");
  });

  it("refuses direct and symlinked export targets inside the active vault", async () => {
    const directory = await mkdtemp(join(tmpdir(), "threadleaf-support-boundary-"));
    scratchDirectories.push(directory);
    const vaultPath = join(directory, "vault");
    const outsidePath = join(directory, "outside");
    await Promise.all([mkdir(vaultPath), mkdir(outsidePath)]);
    await symlink(vaultPath, join(outsidePath, "vault-link"));

    await expect(
      isSupportBundleTargetOutsideVault(vaultPath, join(vaultPath, "support.md")),
    ).resolves.toBe(false);
    await expect(
      isSupportBundleTargetOutsideVault(vaultPath, join(outsidePath, "vault-link", "support.md")),
    ).resolves.toBe(false);
    await expect(
      isSupportBundleTargetOutsideVault(vaultPath, join(outsidePath, "support.md")),
    ).resolves.toBe(true);
  });

  it("exports only the fixed aggregate diagnostics schema", () => {
    expect(createSupportBundleData(supportInput)).toEqual({
      schemaVersion: 1,
      generatedAt: "2026-08-12T17:00:00.000Z",
      privacy: {
        aggregateOnly: true,
        excluded: [
          "note and attachment contents",
          "note, attachment, vault, and save paths",
          "vault names and identifiers",
          "file, bundle, and revision hashes",
          "plugin IDs, names, settings, errors, and code",
          "theme and snippet IDs",
          "runtime notice, event, and error messages",
          "hostnames, usernames, home directories, network addresses, and locale",
        ],
      },
      application: {
        version: "0.1.0-alpha.1",
        packaged: false,
        updateTrust: "none",
        platform: "linux",
        architecture: "x64",
        osRelease: "6.18.0",
        runtimes: { electron: "43.3.0", chromium: "140.0.0", node: "22.0.0" },
      },
      vault: {
        mode: "kernel-backed",
        source: "environment",
        opening: true,
        noteCount: 42,
        workspaceState: "degraded",
        openTabCount: 1,
        activeNoteOpen: true,
        recoveryActionCount: 2,
        indexGeneration: 7,
        watcher: { sequence: 9, rescanObserved: true, errorObserved: true },
      },
      plugins: {
        safeMode: false,
        runtimeCount: 3,
        states: { empty: 0, loaded: 2, unloaded: 0, failed: 1 },
        compatibilityLevels: { "0": 1, "1": 0, "2": 1, "3": 0, "4": 1 },
        commandCount: 2,
        integrations: {
          editorSuggests: 2,
          editorExtensions: 2,
          markdownPostProcessors: 3,
          ribbonItems: 4,
          settingTabs: 5,
          statusBarItems: 6,
          viewTypes: 2,
        },
        surfaceOpen: true,
      },
      appearance: {
        safeMode: true,
        colorScheme: "dark",
        customThemeSelected: true,
        enabledSnippetCount: 1,
      },
      preferences: {
        schemaVersion: 5,
        warningObserved: true,
        customBindingCount: 2,
        savedAppearanceVaultCount: 1,
        savedPluginVaultCount: 1,
        savedNoteWorkflowVaultCount: 1,
        currentPluginMode: "enabled",
        enabledPluginCount: 1,
        pluginGrantCount: 1,
      },
      runtimeSignals: {
        actions: 3,
        notices: 2,
        events: { runtime: 2, plugin: 1, command: 1, notice: 1, error: 1 },
      },
      updates: {
        phase: "available",
        disabledReason: null,
        canCheck: true,
        canDownload: true,
        canInstall: false,
      },
    });
  });

  it("keeps private runtime and settings values out of the Markdown report", () => {
    const report = createSupportBundleMarkdown(supportInput);

    expect(report).toContain("# Threadleaf beta support bundle");
    expect(report).toContain("## Feedback");
    expect(report).toContain("## Aggregate diagnostics");
    expect(report).toContain('"noteCount": 42');
    for (const canary of privateCanaries) {
      expect(report).not.toContain(canary);
    }
  });
});
