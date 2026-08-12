import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadVaultAppearance, validateAppearanceCss } from "./vault-appearance-loader";

let sandboxPath: string;
let vaultPath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-appearance-"));
  vaultPath = path.join(sandboxPath, "vault");
  await fs.mkdir(vaultPath);
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

async function writeTheme(
  folder: string,
  css: string,
  manifest: Record<string, unknown> = { name: folder, version: "1.0.0", author: "Fixture" },
): Promise<void> {
  const directory = path.join(vaultPath, ".obsidian", "themes", folder);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "theme.css"), css, "utf8");
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest), "utf8");
}

async function writeSnippet(filename: string, css: string): Promise<void> {
  const directory = path.join(vaultPath, ".obsidian", "snippets");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, filename), css, "utf8");
}

describe("vault appearance loader", () => {
  it("discovers Obsidian folders and combines only the selected local CSS", async () => {
    await writeTheme("Minimal", ".theme-dark { --background-primary: #101820; }");
    await writeTheme("Paper", ".theme-light { --background-primary: #fffdf7; }");
    await writeSnippet("headings.css", "body { --h1-color: #1769aa; }");
    await writeSnippet("spacing.css", "body { --file-margins: 24px; }");

    const appearance = await loadVaultAppearance({
      vaultPath,
      vaultId: "a".repeat(64),
      preference: {
        colorScheme: "dark",
        themeId: "obsidian-theme:Minimal",
        enabledSnippetIds: ["obsidian-snippet:spacing.css"],
      },
      safeMode: false,
    });

    expect(appearance.themes.map((theme) => theme.name)).toEqual(["Minimal", "Paper"]);
    expect(appearance.themes[0]).toMatchObject({ version: "1.0.0", author: "Fixture" });
    expect(appearance.snippets.map((snippet) => snippet.name)).toEqual(["headings", "spacing"]);
    expect(appearance.activeThemeId).toBe("obsidian-theme:Minimal");
    expect(appearance.activeSnippetIds).toEqual(["obsidian-snippet:spacing.css"]);
    expect(appearance.css).toContain("--background-primary: #101820");
    expect(appearance.css).toContain("--file-margins: 24px");
    expect(appearance.css).not.toContain("#fffdf7");
    expect(appearance.css).not.toContain("--h1-color");
    expect(appearance.warnings).toEqual([]);
  });

  it("preserves missing selections as diagnostics and applies available snippets", async () => {
    await writeSnippet("present.css", "body { --text-normal: #223344; }");

    const appearance = await loadVaultAppearance({
      vaultPath,
      vaultId: "b".repeat(64),
      preference: {
        colorScheme: "system",
        themeId: "obsidian-theme:Missing",
        enabledSnippetIds: ["obsidian-snippet:missing.css", "obsidian-snippet:present.css"],
      },
      safeMode: false,
    });

    expect(appearance.activeThemeId).toBeNull();
    expect(appearance.activeSnippetIds).toEqual(["obsidian-snippet:present.css"]);
    expect(appearance.css).toContain("--text-normal: #223344");
    expect(appearance.warnings).toEqual([
      "The selected custom theme is not available in this vault.",
      "An enabled CSS snippet is not available in this vault (obsidian-snippet:missing.css).",
    ]);
  });

  it("keeps discovery available while safe mode suppresses every custom style", async () => {
    await writeTheme("Minimal", "body { color: white; }");
    await writeSnippet("active.css", "body { font-size: 20px; }");

    const appearance = await loadVaultAppearance({
      vaultPath,
      vaultId: "c".repeat(64),
      preference: {
        colorScheme: "light",
        themeId: "obsidian-theme:Minimal",
        enabledSnippetIds: ["obsidian-snippet:active.css"],
      },
      safeMode: true,
    });

    expect(appearance.themes).toHaveLength(1);
    expect(appearance.snippets).toHaveLength(1);
    expect(appearance.css).toBe("");
    expect(appearance.activeThemeId).toBeNull();
    expect(appearance.activeSnippetIds).toEqual([]);
    expect(appearance.warnings[0]).toContain("safe mode");
  });

  it("rejects network-capable CSS while allowing embedded and variable assets", () => {
    expect(
      validateAppearanceCss('body { background: url("data:image/svg+xml,%3Csvg%3E"); }'),
    ).toContain("data:image");
    expect(validateAppearanceCss(".icon { mask: url(var(--icon)); }")).toContain("var(--icon)");
    expect(() => validateAppearanceCss('@import url("https://example.test/theme.css");')).toThrow(
      "@import",
    );
    expect(() =>
      validateAppearanceCss('body { background: url("https://example.test/a.png"); }'),
    ).toThrow("only embedded");
  });

  it("treats absent appearance directories as an empty catalog", async () => {
    await expect(
      loadVaultAppearance({
        vaultPath,
        vaultId: "d".repeat(64),
        preference: { colorScheme: "system", themeId: null, enabledSnippetIds: [] },
        safeMode: false,
      }),
    ).resolves.toMatchObject({ themes: [], snippets: [], css: "", warnings: [] });
  });

  it("keeps concurrent discovery diagnostics in deterministic theme-then-snippet order", async () => {
    const outsideThemes = path.join(sandboxPath, "outside-themes");
    const outsideSnippets = path.join(sandboxPath, "outside-snippets");
    await fs.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
    await fs.mkdir(outsideThemes);
    await fs.mkdir(outsideSnippets);
    await fs.symlink(outsideThemes, path.join(vaultPath, ".obsidian", "themes"));
    await fs.symlink(outsideSnippets, path.join(vaultPath, ".obsidian", "snippets"));

    const appearance = await loadVaultAppearance({
      vaultPath,
      vaultId: "e".repeat(64),
      preference: { colorScheme: "system", themeId: null, enabledSnippetIds: [] },
      safeMode: false,
    });

    expect(appearance.warnings).toEqual([
      "Could not inspect .obsidian/themes: path resolves outside its appearance directory",
      "Could not inspect .obsidian/snippets: path resolves outside its appearance directory",
    ]);
  });
});
