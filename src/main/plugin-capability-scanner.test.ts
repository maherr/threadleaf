import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scanPluginCapabilities } from "./plugin-capability-scanner";

const encoder = new TextEncoder();

function scan(source: string) {
  return scanPluginCapabilities(encoder.encode(source));
}

describe("plugin capability scanner", () => {
  it("reports stable symbolic evidence without copying bundle source", () => {
    const source = [
      'const fs = require("node:fs/promises");',
      'const child = require("child_process");',
      "app.vault.cachedRead(file);",
      "app.vault.modify(file, next);",
      "fetch(endpoint);",
      "navigator.clipboard.writeText(value);",
      "this.addCommand(command);",
      "this.registerEditorExtension(EditorView.lineWrapping);",
      "process.env.HOME;",
      "window.open(target);",
      "eval(sourceText);",
    ].join("\n");

    const report = scan(source);

    expect(report.bundleSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.capabilities).toEqual([
      "vault-read",
      "vault-write",
      "network",
      "filesystem",
      "subprocess",
      "host-environment",
      "clipboard",
      "external-navigation",
      "editor-extension",
      "workspace-ui",
      "dynamic-code",
    ]);
    expect(report.findings.flatMap((finding) => finding.evidence).join("\n")).not.toContain("HOME");
    expect(scan(source)).toEqual(report);
  });

  it("does not claim authority that has no observed bundle reference", () => {
    const report = scan("module.exports = class FixturePlugin {};");

    expect(report.capabilities).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.staticOnly).toBe(true);
  });

  it("distinguishes literal module imports from dynamically selected modules", () => {
    expect(scan('require("fs");').capabilities).toEqual(["filesystem"]);
    expect(scan("require(moduleName);").capabilities).toEqual(["dynamic-code"]);
  });

  it("reports ambient require aliases before reviewed capability equality is checked", () => {
    for (const source of [
      'window.require("node:child_process");',
      'globalThis.require("node:child_process");',
      'global.require("node:child_process");',
    ]) {
      expect(scan(source).capabilities).toEqual(["subprocess"]);
    }
  });

  it("binds grants to the exact bundle bytes, including a UTF-8 byte-order mark", () => {
    const source = encoder.encode("module.exports = class FixturePlugin {};");
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...source]);

    const report = scanPluginCapabilities(bytes);

    expect(report.bundleSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(report.bundleSha256).not.toBe(createHash("sha256").update(source).digest("hex"));
  });
});
