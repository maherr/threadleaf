import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeSnapshot, ThreadleafBridge } from "../shared/contracts";
import { ipcChannels } from "../shared/ipc-channels";

const preloadHarness = vi.hoisted(() => ({
  bridge: undefined as unknown,
  calls: [] as unknown[][],
  listeners: new Map<string, (...args: unknown[]) => void>(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, bridge: unknown) => {
      preloadHarness.bridge = bridge;
    },
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => {
      preloadHarness.calls.push(args);
      return Promise.resolve({} as RuntimeSnapshot);
    },
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      preloadHarness.listeners.set(channel, listener);
    },
    removeListener: (channel: string) => {
      preloadHarness.listeners.delete(channel);
    },
    send: () => undefined,
  },
}));

import "./preload";

type AnyFunction = (...args: never[]) => unknown;
type LastParameter<F extends AnyFunction> =
  Parameters<F> extends [...unknown[], infer Last] ? Last : never;
type RequiredString<T> = [T] extends [string] ? true : never;
type ParameterAt<F extends AnyFunction, Index extends number> = Parameters<F>[Index];

const requiredVaultIdContracts: {
  exportSupportBundle: RequiredString<LastParameter<ThreadleafBridge["exportSupportBundle"]>>;
  getWorkspaceLayout: RequiredString<LastParameter<ThreadleafBridge["getWorkspaceLayout"]>>;
  searchVault: RequiredString<ParameterAt<ThreadleafBridge["searchVault"], 1>>;
  moveAttachment: RequiredString<LastParameter<ThreadleafBridge["moveAttachment"]>>;
  runCommand: RequiredString<LastParameter<ThreadleafBridge["runCommand"]>>;
  waitForPluginMutations: RequiredString<LastParameter<ThreadleafBridge["waitForPluginMutations"]>>;
  reloadPlugin: RequiredString<LastParameter<ThreadleafBridge["reloadPlugin"]>>;
  unloadPlugin: RequiredString<LastParameter<ThreadleafBridge["unloadPlugin"]>>;
  markPluginLayoutReady: RequiredString<LastParameter<ThreadleafBridge["markPluginLayoutReady"]>>;
  openPluginSettings: RequiredString<LastParameter<ThreadleafBridge["openPluginSettings"]>>;
  openPluginView: RequiredString<LastParameter<ThreadleafBridge["openPluginView"]>>;
  closePluginView: RequiredString<LastParameter<ThreadleafBridge["closePluginView"]>>;
  setPluginSurfaceBounds: RequiredString<LastParameter<ThreadleafBridge["setPluginSurfaceBounds"]>>;
  setPluginSurfaceVisible: RequiredString<
    LastParameter<ThreadleafBridge["setPluginSurfaceVisible"]>
  >;
  setPluginSurfaceTheme: RequiredString<LastParameter<ThreadleafBridge["setPluginSurfaceTheme"]>>;
  setPluginSurfaceAccessibility: RequiredString<
    LastParameter<ThreadleafBridge["setPluginSurfaceAccessibility"]>
  >;
  openNote: RequiredString<LastParameter<ThreadleafBridge["openNote"]>>;
} = {
  exportSupportBundle: true,
  getWorkspaceLayout: true,
  // @ts-expect-error Current main still exposes searchVault without expectedVaultId.
  searchVault: true,
  moveAttachment: true,
  runCommand: true,
  waitForPluginMutations: true,
  reloadPlugin: true,
  unloadPlugin: true,
  markPluginLayoutReady: true,
  openPluginSettings: true,
  openPluginView: true,
  closePluginView: true,
  // @ts-expect-error Current main still exposes plugin surface methods without expectedVaultId.
  setPluginSurfaceBounds: true,
  // @ts-expect-error Current main still exposes plugin surface methods without expectedVaultId.
  setPluginSurfaceVisible: true,
  setPluginSurfaceTheme: true,
  // @ts-expect-error Current main still exposes plugin surface methods without expectedVaultId.
  setPluginSurfaceAccessibility: true,
  openNote: true,
};

const vaultScopedContractMethods = [
  "exportSupportBundle",
  "getWorkspaceLayout",
  "setWorkspaceDockCollapsed",
  "popOutPluginView",
  "reattachPluginView",
  "getAppearance",
  "setVaultAppearance",
  "getAppearancePackages",
  "previewAppearancePackage",
  "previewLocalAppearancePackage",
  "applyAppearancePackage",
  "cancelAppearancePackageReview",
  "getPlugins",
  "searchPluginPackages",
  "previewPluginPackage",
  "applyPluginPackage",
  "cancelPluginPackageReview",
  "setCompatibilityMode",
  "setPluginCapabilityGrant",
  "setPluginEnabled",
  "reloadPlugins",
  "getMigrationPreview",
  "applyMigration",
  "rollbackMigration",
  "searchVault",
  "getVaultGraph",
  "loadVaultImage",
  "loadVaultAttachment",
  "loadVaultNoteEmbed",
  "loadCanvas",
  "saveCanvas",
  "loadCanvasAttachment",
  "getNoteWorkflows",
  "setNoteWorkflows",
  "getWorkspaceSettings",
  "setWorkspaceSettings",
  "setWorkspaceMode",
  "resetWorkspaceSettings",
  "openDailyNote",
  "renderNoteTemplate",
  "formatNoteWorkflowValue",
  "runCommand",
  "waitForPluginMutations",
  "reloadPlugin",
  "unloadPlugin",
  "markPluginLayoutReady",
  "openPluginSettings",
  "openPluginView",
  "closePluginView",
  "setPluginSurfaceBounds",
  "setPluginSurfaceVisible",
  "setPluginSurfaceTheme",
  "setPluginSurfaceAccessibility",
  "openNote",
  "goBack",
  "goForward",
  "closeNote",
  "toggleTabPin",
  "splitWorkspace",
  "focusWorkspacePane",
  "closeWorkspacePane",
  "moveNoteToWorkspacePane",
  "reorderWorkspaceTab",
  "moveNote",
  "moveAttachment",
  "deleteNote",
  "getVaultTrash",
  "restoreNote",
  "getNoteBookmarks",
  "setNoteBookmark",
  "createNote",
  "saveNote",
  "setNoteProperty",
  "removeNoteProperty",
  "getEditorDraft",
  "saveEditorDraft",
  "clearEditorDraft",
] as const;

const delayedVaultScopedContractMethods = vaultScopedContractMethods;

const globalBridgeMethods = [
  "publishNote",
  "getAppUpdate",
  "checkForAppUpdate",
  "downloadAppUpdate",
  "installAppUpdate",
  "getSnapshot",
  "markStartupShellReady",
  "getSettings",
  "getAccessibilityPreferences",
  "setAccessibilityPreferences",
  "resetAccessibilityPreferences",
  "setKeyBinding",
  "resetKeyBindings",
  "chooseVault",
  "onAppearance",
  "onMenuCommand",
  "onSnapshot",
  "onWorkspaceLayout",
  "onSettings",
  "onAccessibilityPreferences",
  "onAppUpdate",
] as const;

function bridge(): ThreadleafBridge {
  if (!preloadHarness.bridge) {
    throw new Error("The preload bridge was not exposed.");
  }
  return preloadHarness.bridge as ThreadleafBridge;
}

function emitVaultB(): void {
  preloadHarness.listeners.get(ipcChannels.snapshotChanged)?.({}, {
    vault: { id: "vault-b" },
  } as RuntimeSnapshot);
}

describe("Threadleaf preload vault contracts", () => {
  it("keeps the vault-scoped method inventory explicit and IDs mandatory", () => {
    const source = readFileSync(new URL("../shared/contracts.ts", import.meta.url), "utf8");
    const interfaceSource = source.slice(source.indexOf("export interface ThreadleafBridge"));
    const declaredMethods = [...interfaceSource.matchAll(/^ {2}([A-Za-z0-9_]+)\(/gm)].map(
      ([, method]) => method,
    );
    expect([...globalBridgeMethods, ...vaultScopedContractMethods].sort()).toEqual(
      [...declaredMethods].sort(),
    );
    for (const method of Object.keys(requiredVaultIdContracts)) {
      expect(delayedVaultScopedContractMethods).toContain(method);
    }
    expect(source).not.toContain("expectedVaultId?");
    for (const method of vaultScopedContractMethods) {
      const start = source.indexOf(`  ${method}(`);
      expect(start, `${method} must be declared in ThreadleafBridge`).toBeGreaterThanOrEqual(0);
      const end = source.indexOf(";", start);
      const signature = source.slice(start, end);
      if (method === "saveEditorDraft") {
        expect(signature).toContain("EditorDraftSnapshot");
      } else {
        expect(signature, `${method} must carry expectedVaultId`).toContain("expectedVaultId");
      }
    }
  });

  it("does not relabel delayed A requests after a B snapshot for every vault-scoped family", async () => {
    const currentBridge = bridge();
    const unsubscribe = currentBridge.onSnapshot(() => undefined);
    type DelayedMethod = (typeof vaultScopedContractMethods)[number] | "publishNote";
    const delayedCalls: Array<{
      method: DelayedMethod;
      args: readonly unknown[];
      withoutId?: readonly unknown[];
      expectedArgument: number;
      requestVaultId?: "vaultId" | "expectedVaultId";
    }> = [
      {
        method: "exportSupportBundle",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "getWorkspaceLayout",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "setWorkspaceDockCollapsed",
        args: ["left", true, "vault-a"],
        withoutId: ["left", true, undefined],
        expectedArgument: 3,
      },
      {
        method: "popOutPluginView",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "reattachPluginView",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "getAppearance",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "setVaultAppearance",
        args: ["vault-a", {}],
        withoutId: [undefined, {}],
        expectedArgument: 1,
      },
      {
        method: "getAppearancePackages",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "previewAppearancePackage",
        args: ["vault-a", { action: "install", kind: "theme", packageId: "fixture" }],
        withoutId: [undefined, { action: "install", kind: "theme", packageId: "fixture" }],
        expectedArgument: 1,
      },
      {
        method: "previewLocalAppearancePackage",
        args: ["vault-a", "theme"],
        withoutId: [undefined, "theme"],
        expectedArgument: 1,
      },
      {
        method: "applyAppearancePackage",
        args: ["vault-a", "review"],
        withoutId: [undefined, "review"],
        expectedArgument: 1,
      },
      {
        method: "cancelAppearancePackageReview",
        args: ["vault-a", "review"],
        withoutId: [undefined, "review"],
        expectedArgument: 1,
      },
      {
        method: "getPlugins",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "searchPluginPackages",
        args: ["vault-a", "query"],
        withoutId: [undefined, "query"],
        expectedArgument: 1,
      },
      {
        method: "previewPluginPackage",
        args: ["vault-a", { action: "install", pluginId: "fixture" }],
        withoutId: [undefined, { action: "install", pluginId: "fixture" }],
        expectedArgument: 1,
      },
      {
        method: "applyPluginPackage",
        args: ["vault-a", "review"],
        withoutId: [undefined, "review"],
        expectedArgument: 1,
      },
      {
        method: "cancelPluginPackageReview",
        args: ["vault-a", "review"],
        withoutId: [undefined, "review"],
        expectedArgument: 1,
      },
      {
        method: "setCompatibilityMode",
        args: ["vault-a", "enabled"],
        withoutId: [undefined, "enabled"],
        expectedArgument: 1,
      },
      {
        method: "setPluginCapabilityGrant",
        args: ["vault-a", "fixture", "a".repeat(64), true],
        withoutId: [undefined, "fixture", "a".repeat(64), true],
        expectedArgument: 1,
      },
      {
        method: "setPluginEnabled",
        args: ["vault-a", "fixture", true],
        withoutId: [undefined, "fixture", true],
        expectedArgument: 1,
      },
      {
        method: "reloadPlugins",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "getMigrationPreview",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "applyMigration",
        args: ["vault-a", {}],
        withoutId: [undefined, {}],
        expectedArgument: 1,
      },
      {
        method: "rollbackMigration",
        args: ["vault-a", "transaction"],
        withoutId: [undefined, "transaction"],
        expectedArgument: 1,
      },
      {
        method: "searchVault",
        args: ["same.md", "vault-a"],
        withoutId: ["same.md", undefined],
        expectedArgument: 2,
      },
      {
        method: "getVaultGraph",
        args: [
          { mode: "global", rootPath: null, depth: 1, query: "", includeOrphans: false },
          "vault-a",
        ],
        withoutId: [
          { mode: "global", rootPath: null, depth: 1, query: "", includeOrphans: false },
          undefined,
        ],
        expectedArgument: 2,
      },
      {
        method: "loadVaultImage",
        args: ["same.md", "image.png", "vault-a"],
        withoutId: ["same.md", "image.png", undefined],
        expectedArgument: 3,
      },
      {
        method: "loadVaultAttachment",
        args: ["same.md", "file.pdf", "vault-a"],
        withoutId: ["same.md", "file.pdf", undefined],
        expectedArgument: 3,
      },
      {
        method: "loadVaultNoteEmbed",
        args: ["same.md", "Embed.md", null, "vault-a"],
        withoutId: ["same.md", "Embed.md", null, undefined],
        expectedArgument: 4,
      },
      {
        method: "loadCanvas",
        args: ["Board.canvas", "vault-a"],
        withoutId: ["Board.canvas", undefined],
        expectedArgument: 2,
      },
      {
        method: "saveCanvas",
        args: ["Board.canvas", "{}", "rev", "vault-a"],
        withoutId: ["Board.canvas", "{}", "rev", undefined],
        expectedArgument: 4,
      },
      {
        method: "loadCanvasAttachment",
        args: ["Board.canvas", "image.png", "vault-a"],
        withoutId: ["Board.canvas", "image.png", undefined],
        expectedArgument: 3,
      },
      {
        method: "getNoteWorkflows",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "setNoteWorkflows",
        args: ["vault-a", {}],
        withoutId: [undefined, {}],
        expectedArgument: 1,
      },
      {
        method: "getWorkspaceSettings",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "setWorkspaceSettings",
        args: ["vault-a", {}],
        withoutId: [undefined, {}],
        expectedArgument: 1,
      },
      {
        method: "setWorkspaceMode",
        args: ["vault-a", { editorMode: "live", documentView: "live" }],
        withoutId: [undefined, { editorMode: "live", documentView: "live" }],
        expectedArgument: 1,
      },
      {
        method: "resetWorkspaceSettings",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "openDailyNote",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "renderNoteTemplate",
        args: ["Templates/base.md", "same.md", "vault-a"],
        withoutId: ["Templates/base.md", "same.md", undefined],
        expectedArgument: 3,
      },
      {
        method: "formatNoteWorkflowValue",
        args: ["date", "vault-a"],
        withoutId: ["date", undefined],
        expectedArgument: 2,
      },
      {
        method: "runCommand",
        args: ["same-command-id", undefined, "vault-a"],
        withoutId: ["same-command-id", undefined, undefined],
        expectedArgument: 3,
      },
      {
        method: "waitForPluginMutations",
        args: [undefined, "vault-a"],
        withoutId: [undefined, undefined],
        expectedArgument: 2,
      },
      {
        method: "reloadPlugin",
        args: [undefined, "vault-a"],
        withoutId: [undefined, undefined],
        expectedArgument: 2,
      },
      {
        method: "unloadPlugin",
        args: [undefined, "vault-a"],
        withoutId: [undefined, undefined],
        expectedArgument: 2,
      },
      {
        method: "markPluginLayoutReady",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "openPluginSettings",
        args: ["fixture", "vault-a"],
        withoutId: ["fixture", undefined],
        expectedArgument: 2,
      },
      {
        method: "openPluginView",
        args: ["drawing", undefined, "vault-a"],
        withoutId: ["drawing", undefined, undefined],
        expectedArgument: 3,
      },
      {
        method: "closePluginView",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "setPluginSurfaceBounds",
        args: [{ x: 0, y: 0, width: 1, height: 1 }, "vault-a"],
        withoutId: [{ x: 0, y: 0, width: 1, height: 1 }, undefined],
        expectedArgument: 2,
      },
      {
        method: "setPluginSurfaceVisible",
        args: [true, "vault-a"],
        withoutId: [true, undefined],
        expectedArgument: 2,
      },
      {
        method: "setPluginSurfaceTheme",
        args: ["dark", "vault-a"],
        withoutId: ["dark", undefined],
        expectedArgument: 2,
      },
      {
        method: "setPluginSurfaceAccessibility",
        args: [
          {
            highContrast: false,
            reducedMotion: false,
            reducedTransparency: false,
            accent: "blue",
            uiFontScale: 1,
            textFontScale: 1,
            editorFontSize: 15,
            editorLineHeight: 1.6,
          },
          "vault-a",
        ],
        withoutId: [
          {
            highContrast: false,
            reducedMotion: false,
            reducedTransparency: false,
            accent: "blue",
            uiFontScale: 1,
            textFontScale: 1,
            editorFontSize: 15,
            editorLineHeight: 1.6,
          },
          undefined,
        ],
        expectedArgument: 2,
      },
      {
        method: "openNote",
        args: ["same.md", undefined, true, "vault-a"],
        withoutId: ["same.md", undefined, true, undefined],
        expectedArgument: 4,
      },
      {
        method: "goBack",
        args: ["vault-a", "primary"],
        withoutId: [undefined, "primary"],
        expectedArgument: 1,
      },
      {
        method: "goForward",
        args: ["vault-a", "primary"],
        withoutId: [undefined, "primary"],
        expectedArgument: 1,
      },
      {
        method: "closeNote",
        args: ["same.md", "vault-a", "primary"],
        withoutId: ["same.md", undefined, "primary"],
        expectedArgument: 2,
      },
      {
        method: "toggleTabPin",
        args: ["same.md", "primary", "vault-a"],
        withoutId: ["same.md", "primary", undefined],
        expectedArgument: 3,
      },
      {
        method: "splitWorkspace",
        args: ["vertical", "vault-a"],
        withoutId: ["vertical", undefined],
        expectedArgument: 2,
      },
      {
        method: "focusWorkspacePane",
        args: ["primary", "vault-a"],
        withoutId: ["primary", undefined],
        expectedArgument: 2,
      },
      {
        method: "closeWorkspacePane",
        args: ["primary", "vault-a"],
        withoutId: ["primary", undefined],
        expectedArgument: 2,
      },
      {
        method: "moveNoteToWorkspacePane",
        args: ["same.md", "primary", "secondary", "vault-a"],
        withoutId: ["same.md", "primary", "secondary", undefined],
        expectedArgument: 4,
      },
      {
        method: "reorderWorkspaceTab",
        args: ["same.md", "primary", 0, "vault-a"],
        withoutId: ["same.md", "primary", 0, undefined],
        expectedArgument: 4,
      },
      {
        method: "moveNote",
        args: ["same.md", "other.md", "rev", "vault-a", "confirmation"],
        withoutId: ["same.md", "other.md", "rev", undefined, "confirmation"],
        expectedArgument: 4,
      },
      {
        method: "moveAttachment",
        args: ["same.png", "other.png", "rev", "vault-a", "confirmation"],
        withoutId: ["same.png", "other.png", "rev", undefined, "confirmation"],
        expectedArgument: 4,
      },
      {
        method: "deleteNote",
        args: ["same.md", "rev", "vault-a"],
        withoutId: ["same.md", "rev", undefined],
        expectedArgument: 3,
      },
      {
        method: "getVaultTrash",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "restoreNote",
        args: ["same.md", "rev", "vault-a"],
        withoutId: ["same.md", "rev", undefined],
        expectedArgument: 3,
      },
      {
        method: "getNoteBookmarks",
        args: ["vault-a"],
        withoutId: [undefined],
        expectedArgument: 1,
      },
      {
        method: "setNoteBookmark",
        args: ["same.md", true, "vault-a"],
        withoutId: ["same.md", true, undefined],
        expectedArgument: 3,
      },
      {
        method: "createNote",
        args: ["same.md", "", "vault-a"],
        withoutId: ["same.md", "", undefined],
        expectedArgument: 3,
      },
      {
        method: "saveNote",
        args: ["same.md", "", "rev", "vault-a"],
        withoutId: ["same.md", "", "rev", undefined],
        expectedArgument: 4,
      },
      {
        method: "setNoteProperty",
        args: ["same.md", "tags", "x", "text", "rev", "vault-a"],
        withoutId: ["same.md", "tags", "x", "text", "rev", undefined],
        expectedArgument: 6,
      },
      {
        method: "removeNoteProperty",
        args: ["same.md", "tags", "rev", "vault-a"],
        withoutId: ["same.md", "tags", "rev", undefined],
        expectedArgument: 4,
      },
      {
        method: "getEditorDraft",
        args: ["vault-a", "primary"],
        withoutId: [undefined, "primary"],
        expectedArgument: 1,
      },
      {
        method: "saveEditorDraft",
        args: [{ vaultId: "vault-a" }],
        withoutId: [undefined],
        expectedArgument: 1,
        requestVaultId: "vaultId",
      },
      {
        method: "clearEditorDraft",
        args: ["vault-a", "draft", "primary"],
        withoutId: [undefined, "draft", "primary"],
        expectedArgument: 1,
      },
      {
        method: "publishNote",
        args: [
          {
            version: 1,
            expectedVaultId: "vault-a",
            sourcePath: "same.md",
            expectedRevision: "rev",
            html: "<!doctype html>",
          },
        ],
        withoutId: [
          {
            version: 1,
            expectedVaultId: undefined,
            sourcePath: "same.md",
            expectedRevision: "rev",
            html: "<!doctype html>",
          },
        ],
        expectedArgument: 1,
        requestVaultId: "expectedVaultId",
      },
    ];

    const delayedMethodNames = new Set(delayedCalls.map(({ method }) => method));
    expect(delayedMethodNames).toEqual(
      new Set([...delayedVaultScopedContractMethods, "publishNote"]),
    );

    const invoke = (method: DelayedMethod, args: readonly unknown[]) => {
      const operation = currentBridge[method] as unknown as (
        ...values: unknown[]
      ) => Promise<unknown>;
      return operation(...args);
    };

    for (const delayed of delayedCalls) {
      preloadHarness.calls.length = 0;
      const pending = invoke(delayed.method, delayed.args);
      emitVaultB();
      await pending;
      const request = preloadHarness.calls.at(-1);
      expect(request, delayed.method).toBeDefined();
      if (delayed.requestVaultId) {
        expect(request?.[delayed.expectedArgument], delayed.method).toMatchObject({
          [delayed.requestVaultId]: "vault-a",
        });
      } else {
        expect(request?.[delayed.expectedArgument], delayed.method).toBe("vault-a");
      }
      expect(
        preloadHarness.calls.some(([channel]) => channel === ipcChannels.snapshot),
        `${delayed.method} must not fetch a mutable current vault`,
      ).toBe(false);
      if (delayed.withoutId) {
        preloadHarness.calls.length = 0;
        const missingId = invoke(delayed.method, delayed.withoutId);
        emitVaultB();
        await missingId;
        const missingRequest = preloadHarness.calls.at(-1);
        expect(missingRequest, `${delayed.method} missing ID`).toBeDefined();
        if (delayed.method === "saveEditorDraft") {
          expect(
            missingRequest?.[delayed.expectedArgument],
            `${delayed.method} missing ID`,
          ).toBeUndefined();
        } else if (delayed.requestVaultId) {
          expect(
            missingRequest?.[delayed.expectedArgument],
            `${delayed.method} missing ID`,
          ).toEqual(expect.objectContaining({ [delayed.requestVaultId]: undefined }));
        } else {
          expect(
            missingRequest?.[delayed.expectedArgument],
            `${delayed.method} missing ID`,
          ).toBeUndefined();
        }
        expect(
          preloadHarness.calls.some(([channel]) => channel === ipcChannels.snapshot),
          `${delayed.method} missing ID must not fetch a mutable current vault`,
        ).toBe(false);
      }
    }

    unsubscribe();
  });
});
