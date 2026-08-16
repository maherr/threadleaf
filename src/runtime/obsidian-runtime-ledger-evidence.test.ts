import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testConstructionDispatch } from "../test-support/plugin-construction";
import { PluginHost } from "./plugin-host";

const fixtureVault = path.resolve("fixtures/vaults/basic");

describe("Obsidian 1.13.7 runtime ledger evidence", () => {
  /** @compatibility-test-id obsidian-runtime.base-component.v1 */
  /** @compatibility-test-id obsidian-runtime.component.v1 */
  /** @compatibility-test-id obsidian-runtime.plugin.v1 */
  /** @compatibility-test-id obsidian-runtime.platform.v1 */
  /** @compatibility-test-id obsidian-runtime.normalize-path.v1 */
  it('delivers the bounded core slice through the real require("obsidian") binding', async () => {
    const sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-runtime-ledger-"));
    const vaultPath = path.join(sandboxPath, "vault");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "ledger-fixture");
    try {
      await fs.mkdir(pluginPath, { recursive: true });
      await fs.writeFile(
        path.join(pluginPath, "manifest.json"),
        JSON.stringify({ id: "ledger-fixture", name: "Ledger fixture", version: "1.0.0" }),
      );
      await fs.writeFile(
        path.join(pluginPath, "main.js"),
        [
          'const { BaseComponent, Component, Plugin, Platform, normalizePath } = require("obsidian");',
          "class LedgerPlugin extends Plugin {",
          "  async onload() {",
          "    const base = new BaseComponent().setDisabled(true);",
          "    const child = new Component();",
          "    let released = false;",
          "    child.onunload = () => { released = true; };",
          "    const parent = new Component();",
          "    parent.addChild(child);",
          "    parent.load();",
          "    parent.unload();",
          "    globalThis.__threadleafRuntimeLedgerProbe = {",
          "      baseDisabled: base.disabled,",
          "      childReleased: released,",
          "      componentIsComponent: parent instanceof Component,",
          "      pluginIsPlugin: this instanceof Plugin,",
          "      desktop: Platform.isDesktop === true,",
          '      normalized: normalizePath("\\\\Folder\\\\Note.md"),',
          "    };",
          "  }",
          "}",
          "module.exports = LedgerPlugin;",
          "",
        ].join("\n"),
      );
      const host = new PluginHost(fixtureVault);
      try {
        await host.loadAuthorizedPlugin(await testConstructionDispatch(pluginPath));
        expect(
          (globalThis as { __threadleafRuntimeLedgerProbe?: unknown })
            .__threadleafRuntimeLedgerProbe,
        ).toEqual({
          baseDisabled: true,
          childReleased: true,
          componentIsComponent: true,
          pluginIsPlugin: true,
          desktop: true,
          normalized: "Folder/Note.md",
        });
      } finally {
        await host.close();
      }
    } finally {
      Reflect.deleteProperty(globalThis, "__threadleafRuntimeLedgerProbe");
      await fs.rm(sandboxPath, { recursive: true, force: true });
    }
  });
});
