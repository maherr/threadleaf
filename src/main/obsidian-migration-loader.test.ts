import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadObsidianMigrationPreview } from "./obsidian-migration-loader";

let sandboxPath: string;
let vaultPath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-migration-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(vaultPath);
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

async function writeJson(relativePath: string, value: unknown): Promise<string> {
  const filePath = path.join(vaultPath, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

async function writePlugin(
  id: string,
  options: { data?: unknown; manifest?: Record<string, unknown>; main?: string } = {},
): Promise<void> {
  const directory = path.join(vaultPath, ".obsidian", "plugins", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify(
      options.manifest ?? {
        id,
        name: id === "threadleaf-fixture" ? "Threadleaf fixture" : id,
        version: "0.1.0",
        minAppVersion: "1.0.0",
        isDesktopOnly: false,
      },
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(directory, "main.js"),
    options.main ?? "module.exports = class {};\n",
    "utf8",
  );
  if (options.data !== undefined) {
    await fs.writeFile(path.join(directory, "data.json"), JSON.stringify(options.data), "utf8");
  }
}

describe("Obsidian migration preview", () => {
  it("treats a vault without Obsidian state as a valid empty preview", async () => {
    const preview = await loadObsidianMigrationPreview({
      vaultPath,
      vaultId: "a".repeat(64),
      selectedPluginIds: [],
    });

    expect(preview).toMatchObject({
      detected: false,
      readOnly: true,
      plugins: [],
      hotkeys: [],
      appearance: {
        sourceColorScheme: null,
        colorSchemeCandidate: null,
        sourceThemeName: null,
        themeIdCandidate: null,
      },
      workspace: { sourcePath: null, leafCount: 0, restorablePaths: [] },
      warnings: [],
    });
    expect(preview.sources).toHaveLength(5);
    expect(preview.sources.every((source) => source.state === "absent")).toBe(true);
  });

  it("summarizes behavior candidates without changing or exposing source values", async () => {
    const sourceFiles: string[] = [];
    sourceFiles.push(
      await writeJson(".obsidian/community-plugins.json", ["threadleaf-fixture", "missing-plugin"]),
    );
    sourceFiles.push(
      await writeJson(".obsidian/appearance.json", {
        theme: "obsidian",
        cssTheme: "Minimal",
        enabledCssSnippets: ["headings"],
      }),
    );
    sourceFiles.push(
      await writeJson(".obsidian/hotkeys.json", {
        "command-palette:open": [{ modifiers: ["Mod"], key: "P" }],
        "threadleaf-fixture:run": [{ modifiers: ["Mod", "Shift"], key: "R" }],
      }),
    );
    sourceFiles.push(
      await writeJson(".obsidian/workspace.json", {
        active: "active-leaf",
        main: {
          type: "tabs",
          children: [
            {
              type: "leaf",
              id: "active-leaf",
              state: { type: "markdown", state: { file: "Present.md", mode: "source" } },
            },
            {
              type: "leaf",
              id: "missing-leaf",
              state: { type: "excalidraw", state: { file: "Missing.excalidraw.md" } },
            },
          ],
        },
        left: {
          type: "tabs",
          children: [{ type: "leaf", id: "search", state: { type: "search", state: {} } }],
        },
        right: { type: "tabs", children: [] },
        lastOpenFiles: ["Present.md", "Older.md"],
      }),
    );
    await fs.writeFile(path.join(vaultPath, "Present.md"), "# Present\n", "utf8");
    await fs.mkdir(path.join(vaultPath, ".obsidian", "themes", "Minimal"), { recursive: true });
    await fs.writeFile(
      path.join(vaultPath, ".obsidian", "themes", "Minimal", "theme.css"),
      "body {}\n",
      "utf8",
    );
    await fs.mkdir(path.join(vaultPath, ".obsidian", "snippets"), { recursive: true });
    await fs.writeFile(
      path.join(vaultPath, ".obsidian", "snippets", "headings.css"),
      "h1 {}\n",
      "utf8",
    );
    const privateValue = "migration-preview-must-never-render-this-secret";
    await writePlugin("threadleaf-fixture", {
      data: { apiToken: privateValue, nested: { enabled: true }, list: [1, 2] },
    });
    sourceFiles.push(
      path.join(vaultPath, ".obsidian", "plugins", "threadleaf-fixture", "data.json"),
    );
    const before = new Map<string, Buffer>(
      await Promise.all(
        sourceFiles.map(async (filePath) => [filePath, await fs.readFile(filePath)] as const),
      ),
    );

    const preview = await loadObsidianMigrationPreview({
      vaultPath,
      vaultId: "b".repeat(64),
      selectedPluginIds: ["threadleaf-fixture"],
    });

    expect(preview.detected).toBe(true);
    expect(preview.plugins).toHaveLength(2);
    expect(preview.plugins[0]).toMatchObject({
      id: "threadleaf-fixture",
      enabledInObsidian: true,
      selectedInThreadleaf: true,
      packageState: "ready",
      compatibility: { status: "verified", level: 4, testedVersion: "0.1.0" },
      settings: { state: "shared", rootKind: "object", topLevelEntryCount: 3 },
    });
    expect(preview.plugins[1]).toMatchObject({
      id: "missing-plugin",
      enabledInObsidian: true,
      packageState: "missing",
    });
    expect(preview.hotkeys).toEqual([
      expect.objectContaining({
        commandId: "command-palette:open",
        targetId: "ui.command-palette",
        candidateBinding: "Mod+P",
        state: "ready",
      }),
      expect.objectContaining({
        commandId: "threadleaf-fixture:run",
        owner: "plugin",
        targetId: null,
        state: "review",
      }),
    ]);
    expect(preview.appearance).toEqual({
      sourceColorScheme: "obsidian",
      colorSchemeCandidate: "dark",
      sourceThemeName: "Minimal",
      themeIdCandidate: "obsidian-theme:Minimal",
      themeAvailable: true,
      sourceSnippetNames: ["headings"],
      snippetIdsCandidate: ["obsidian-snippet:headings.css"],
      missingSnippetNames: [],
    });
    expect(preview.workspace).toMatchObject({
      sourcePath: ".obsidian/workspace.json",
      leafCount: 3,
      restorablePaths: ["Present.md"],
      missingPaths: ["Missing.excalidraw.md"],
      activePath: "Present.md",
      recentFileCount: 2,
      unsupportedViewTypes: [{ type: "search", count: 1 }],
    });
    expect(JSON.stringify(preview)).not.toContain(privateValue);
    for (const [filePath, bytes] of before) {
      await expect(fs.readFile(filePath)).resolves.toEqual(bytes);
    }
  });

  it("reports malformed, oversized, and escaping inputs without following them", async () => {
    const obsidianPath = path.join(vaultPath, ".obsidian");
    await fs.mkdir(obsidianPath);
    await fs.writeFile(path.join(obsidianPath, "community-plugins.json"), "[not-json", "utf8");
    await fs.writeFile(path.join(obsidianPath, "hotkeys.json"), " ".repeat(513 * 1024), "utf8");
    const outsideAppearance = path.join(sandboxPath, "appearance.json");
    await fs.writeFile(outsideAppearance, '{"theme":"obsidian"}', "utf8");
    await fs.symlink(outsideAppearance, path.join(obsidianPath, "appearance.json"));
    await writeJson(".obsidian/workspace.json", {
      active: "escape",
      main: {
        type: "tabs",
        children: [
          {
            type: "leaf",
            id: "escape",
            state: { type: "markdown", state: { file: "../Outside.md" } },
          },
        ],
      },
      left: { type: "tabs", children: [] },
      right: { type: "tabs", children: [] },
    });
    await fs.writeFile(path.join(sandboxPath, "Outside.md"), "outside-file-private-value", "utf8");

    const preview = await loadObsidianMigrationPreview({
      vaultPath,
      vaultId: "c".repeat(64),
      selectedPluginIds: [],
    });

    expect(
      preview.sources.find((source) => source.path.endsWith("community-plugins.json")),
    ).toMatchObject({ state: "invalid" });
    expect(preview.sources.find((source) => source.path.endsWith("hotkeys.json"))).toMatchObject({
      state: "oversized",
    });
    expect(preview.sources.find((source) => source.path.endsWith("appearance.json"))).toMatchObject(
      {
        state: "invalid",
      },
    );
    expect(preview.workspace.restorablePaths).toEqual([]);
    expect(preview.workspace.activePath).toBeNull();
    expect(JSON.stringify(preview)).not.toContain("Outside.md");
    expect(JSON.stringify(preview)).not.toContain("outside-file-private-value");
    expect(JSON.stringify(preview)).not.toContain("not-json");
    expect(preview.warnings.some((warning) => warning.includes("community-plugins.json"))).toBe(
      true,
    );
    expect(preview.warnings.some((warning) => warning.includes("outside the vault"))).toBe(true);
  });

  it("falls back to a valid mobile workspace when desktop layout is unavailable", async () => {
    await writeJson(".obsidian/workspace-mobile.json", {
      active: "mobile-note",
      main: {
        type: "tabs",
        children: [
          {
            type: "leaf",
            id: "mobile-note",
            state: { type: "markdown", state: { file: "Mobile.md" } },
          },
        ],
      },
      left: { type: "tabs", children: [] },
      right: { type: "tabs", children: [] },
      lastOpenFiles: ["Mobile.md"],
    });
    await fs.writeFile(path.join(vaultPath, "Mobile.md"), "# Mobile\n", "utf8");

    const preview = await loadObsidianMigrationPreview({
      vaultPath,
      vaultId: "d".repeat(64),
      selectedPluginIds: [],
    });

    expect(preview.workspace).toMatchObject({
      sourcePath: ".obsidian/workspace-mobile.json",
      restorablePaths: ["Mobile.md"],
      activePath: "Mobile.md",
      recentFileCount: 1,
    });
  });
});
