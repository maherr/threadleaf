import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import * as codeMirrorState from "@codemirror/state";
import * as codeMirrorView from "@codemirror/view";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { trustedHostModules } from "../renderer/trusted-host-modules";
import { testConstructionDispatch } from "../test-support/plugin-construction";
import { CapacitorAdapter } from "./obsidian-capacitor-compat";
import { rendererEditorCompatibilityFields } from "./obsidian-editor-compat";
import { loadMathJax, loadMermaid, loadPdfJs, loadPrism } from "./obsidian-optional-loaders";
import { PluginHost } from "./plugin-host";

async function withTestDocument<T>(callback: () => Promise<T>): Promise<T> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://threadleaf.test/",
  });
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
    writable: true,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window,
    writable: true,
  });
  try {
    return await callback();
  } finally {
    if (previousDocument) {
      Object.defineProperty(globalThis, "document", previousDocument);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    dom.window.close();
  }
}

function createCanonicalPackageResolver(): NodeJS.Require {
  const packageRequire = createRequire(import.meta.url);
  const resolver = ((request: string) => {
    if (request === "@codemirror/state") return codeMirrorState;
    if (request === "@codemirror/view") return codeMirrorView;
    return packageRequire(request);
  }) as NodeJS.Require;
  resolver.resolve = ((request: string, options?: { paths?: string[] }) => {
    if (request === "@codemirror/state" || request === "@codemirror/view") return request;
    return packageRequire.resolve(request, options);
  }) as NodeJS.Require["resolve"];
  resolver.resolve.paths = packageRequire.resolve.paths;
  return resolver;
}

describe("Obsidian 1.13.7 next runtime ledger slice", () => {
  /** @compatibility-test-id obsidian-runtime.next-public-surface.v1 */
  it('proves the next public surface through the real require("obsidian") binding', async () => {
    await withTestDocument(async () => {
      const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-runtime-next-"));
      const vaultPath = path.join(sandboxPath, "vault");
      const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "next-ledger-fixture");
      const fields = rendererEditorCompatibilityFields;
      let capturedExtensions: readonly unknown[] = [];
      try {
        await fs.mkdir(pluginPath, { recursive: true });
        await fs.writeFile(
          path.join(pluginPath, "manifest.json"),
          JSON.stringify({
            id: "next-ledger-fixture",
            name: "Next ledger fixture",
            version: "1.0.0",
          }),
        );
        await fs.writeFile(
          path.join(pluginPath, "main.js"),
          [
            'const obsidian = require("obsidian");',
            'const state = require("@codemirror/state");',
            "class NextLedgerView extends obsidian.BasesView {",
            '  type = "next-ledger";',
            "  onDataUpdated() {}",
            "}",
            "class NextLedgerPlugin extends obsidian.Plugin {",
            "  async onload() {",
            "    const field = state.StateField.define({",
            "      create: () => 0,",
            "      update: (value, transaction) => value + (transaction.docChanged ? 1 : 0),",
            "    });",
            "    this.registerEditorExtension(field);",
            '    const file = new obsidian.TFile("Notes/Alpha.md", null, { ctime: 1, mtime: 2, size: 7 });',
            '    const entry = new obsidian.BasesEntry(file, { "file.size": 7 });',
            '    const config = new obsidian.BasesViewConfig("Grid", { order: ["file.name", "file.size"], sort: [{ property: "file.name", direction: "ASC" }] });',
            '    const controller = new obsidian.QueryController(this.app, config, ["file.name", "file.size"], [entry]);',
            "    const result = new obsidian.BasesQueryResult(this.app, config, controller.allProperties, controller.data);",
            "    const view = new NextLedgerView(controller);",
            '    const target = document.createElement("button");',
            "    document.body.append(target);",
            "    const hoverParent = { hoverPopover: null };",
            "    const hover = new obsidian.HoverPopover(hoverParent, target, 0, { x: 12, y: 24 });",
            "    hover.show();",
            "    const floating = new obsidian.WorkspaceFloating(new obsidian.WorkspaceParent());",
            '    const response = await obsidian.requestUrl("https://threadleaf.test/data");',
            '    const requestText = await obsidian.request("https://threadleaf.test/data");',
            "    globalThis.__threadleafNextLedgerProbe = {",
            "      editorFields: {",
            "        editor: obsidian.editorEditorField,",
            "        info: obsidian.editorInfoField,",
            "        livePreview: obsidian.editorLivePreviewField,",
            "        alias: obsidian.editorViewField,",
            "        plugin: obsidian.livePreviewState,",
            "      },",
            "      field,",
            "      bases: {",
            "        entryPath: entry.file.path,",
            '        size: entry.getValue("file.size").toString(),',
            "        hasGroupKey: new obsidian.BasesEntryGroup([entry], obsidian.NullValue.value).hasKey(),",
            "        properties: result.properties,",
            '        count: result.getSummaryValue(controller, [entry], "file.size", "count").toString(),',
            "        viewType: view.type,",
            "        viewApp: view.app === this.app,",
            "      },",
            "      hover: {",
            "        state: hover.state,",
            "        top: hover.hoverEl.style.top,",
            "        left: hover.hoverEl.style.left,",
            "      },",
            "      floatingParent: floating.parent instanceof obsidian.WorkspaceParent,",
            "      requestType: typeof obsidian.request,",
            "      requestUrlType: typeof obsidian.requestUrl,",
            "      network: {",
            "        status: response.status,",
            '        header: response.headers["x-ledger"],',
            "        text: await response.text,",
            "        json: await response.json,",
            "        bytes: (await response.arrayBuffer).byteLength,",
            "        requestText,",
            "      },",
            "      editableInheritance: obsidian.EditableFileView.prototype instanceof obsidian.FileView,",
            "      popoverValues: [obsidian.PopoverState.Showing, obsidian.PopoverState.Shown, obsidian.PopoverState.Hiding, obsidian.PopoverState.Hidden],",
            "    };",
            "    hover.hide();",
            "  }",
            "}",
            "module.exports = NextLedgerPlugin;",
            "",
          ].join("\n"),
        );

        const host = new PluginHost(
          vaultPath,
          undefined,
          undefined,
          createCanonicalPackageResolver(),
          undefined,
          {
            compatibilityEditorFields: fields,
            onEditorExtensionsChange: (extensions) => {
              capturedExtensions = extensions;
            },
          },
        );
        const previousFetch = globalThis.fetch;
        globalThis.fetch = (async () => ({
          status: 200,
          headers: new Headers({ "x-ledger": "yes" }),
          arrayBuffer: async () => new TextEncoder().encode('{"ok":true}').buffer,
        })) as unknown as typeof fetch;
        try {
          await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
          const probe = (globalThis as { __threadleafNextLedgerProbe?: Record<string, unknown> })
            .__threadleafNextLedgerProbe;
          expect(probe).toBeDefined();
          const editorFields = probe?.editorFields as Record<string, unknown>;
          expect(editorFields.editor).toBe(fields.editorEditorField);
          expect(editorFields.info).toBe(fields.editorInfoField);
          expect(editorFields.livePreview).toBe(fields.editorLivePreviewField);
          expect(editorFields.alias).toBe(fields.editorInfoField);
          expect(editorFields.plugin).toBe(fields.livePreviewState);
          expect(capturedExtensions).toHaveLength(1);

          const pluginField = probe?.field as codeMirrorState.StateField<number>;
          const editorState = codeMirrorState.EditorState.create({
            doc: "",
            extensions: [
              pluginField,
              fields.editorEditorField,
              fields.editorInfoField,
              fields.editorLivePreviewField,
              fields.livePreviewState,
            ],
          });
          const changedState = editorState.update({ changes: { from: 0, insert: "x" } }).state;
          expect(changedState.field(pluginField)).toBe(1);
          expect(codeMirrorState.EditorState).toBe(
            trustedHostModules["@codemirror/state"].EditorState,
          );
          expect(codeMirrorView.EditorView).toBe(trustedHostModules["@codemirror/view"].EditorView);

          expect(probe?.bases).toEqual({
            entryPath: "Notes/Alpha.md",
            size: "7",
            hasGroupKey: false,
            properties: ["file.name", "file.size"],
            count: "1",
            viewType: "next-ledger",
            viewApp: true,
          });
          expect(probe?.hover).toEqual({ state: 1, top: "24px", left: "12px" });
          expect(probe?.floatingParent).toBe(true);
          expect(probe?.requestType).toBe("function");
          expect(probe?.requestUrlType).toBe("function");
          expect(probe?.network).toEqual({
            status: 200,
            header: "yes",
            text: '{"ok":true}',
            json: { ok: true },
            bytes: 11,
            requestText: '{"ok":true}',
          });
          expect(probe?.editableInheritance).toBe(true);
          expect(probe?.popoverValues).toEqual([0, 1, 2, 3]);
        } finally {
          await host.close();
          globalThis.fetch = previousFetch;
        }
      } finally {
        Reflect.deleteProperty(globalThis, "__threadleafNextLedgerProbe");
        await fs.rm(sandboxPath, { recursive: true, force: true });
      }
    });
  });

  /** @compatibility-test-id obsidian-runtime.desktop-unsupported.v1 @compatibility-status unsupported */
  it("keeps mobile and optional rendering engines explicitly unsupported on desktop", async () => {
    const adapter = new CapacitorAdapter();
    expect(adapter.getName()).toContain("unavailable");
    expect(await adapter.trashSystem("missing.txt")).toBe(false);
    await expect(adapter.read("missing.txt")).rejects.toThrow(/unsupported/u);
    await expect(adapter.rmdir("missing", false)).rejects.toThrow(/unsupported/u);
    await expect(adapter.remove("missing")).rejects.toThrow(/unsupported/u);
    await expect(loadMathJax()).rejects.toThrow(/unsupported/u);
    await expect(loadMermaid()).rejects.toThrow(/unsupported/u);
    await expect(loadPdfJs()).rejects.toThrow(/unsupported/u);
    await expect(loadPrism()).rejects.toThrow(/unsupported/u);
  });
});
