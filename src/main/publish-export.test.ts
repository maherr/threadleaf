import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publishNoteExportVersion } from "../shared/publish-export";
import {
  ensureHtmlExtension,
  isPublishExportTargetOutsideVault,
  parsePublishNoteExportRequest,
  readDevelopmentPublishExportPath,
  suggestedPublishedNoteFilename,
} from "./publish-export";

let sandboxPath: string;

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(join(os.tmpdir(), "threadleaf-publish-export-"));
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

function validRequest() {
  return {
    version: publishNoteExportVersion,
    expectedVaultId: "a".repeat(64),
    sourcePath: "Notes/Publish me.md",
    expectedRevision: "b".repeat(64),
    html: '<!doctype html><html data-threadleaf-publish-version="1"><body>Safe</body></html>',
  } as const;
}

describe("published note export", () => {
  it("accepts only development-only absolute override paths and adds the HTML extension", () => {
    const target = join(sandboxPath, "published-note");
    expect(
      readDevelopmentPublishExportPath(false, { THREADLEAF_PUBLISH_EXPORT_PATH: target }),
    ).toBe(`${target}.html`);
    expect(readDevelopmentPublishExportPath(false, {})).toBeUndefined();
    expect(
      readDevelopmentPublishExportPath(true, { THREADLEAF_PUBLISH_EXPORT_PATH: target }),
    ).toBeUndefined();
    expect(() =>
      readDevelopmentPublishExportPath(false, {
        THREADLEAF_PUBLISH_EXPORT_PATH: "relative/export.html",
      }),
    ).toThrow("must be absolute");
  });

  it("rejects vault-contained targets, including paths through symlinked parents", async () => {
    const vaultPath = join(sandboxPath, "vault");
    const outsidePath = join(sandboxPath, "outside");
    await fs.mkdir(vaultPath);
    await fs.mkdir(outsidePath);
    await fs.symlink(vaultPath, join(outsidePath, "vault-link"));

    await expect(
      isPublishExportTargetOutsideVault(vaultPath, join(vaultPath, "published.html")),
    ).resolves.toBe(false);
    await expect(
      isPublishExportTargetOutsideVault(
        vaultPath,
        join(outsidePath, "vault-link", "published.html"),
      ),
    ).resolves.toBe(false);
    await expect(
      isPublishExportTargetOutsideVault(vaultPath, join(outsidePath, "published.html")),
    ).resolves.toBe(true);
  });

  it("creates portable filenames without path or platform-reserved characters", () => {
    expect(suggestedPublishedNoteFilename("Folder/My: Note.md")).toBe("My- Note.html");
    expect(suggestedPublishedNoteFilename("Folder/CON.md")).toBe("note-CON.html");
    expect(suggestedPublishedNoteFilename("Folder/....md")).toBe("note.html");
    expect(ensureHtmlExtension("report.HTML")).toBe("report.HTML");
    expect(ensureHtmlExtension("report")).toBe("report.html");
  });

  it("parses a bounded request and rejects stale-shaped or private-path input", () => {
    expect(parsePublishNoteExportRequest(validRequest())).toEqual(validRequest());
    expect(() =>
      parsePublishNoteExportRequest({ ...validRequest(), sourcePath: ".obsidian/Private.md" }),
    ).toThrow("visible normalized Markdown path");
    expect(() =>
      parsePublishNoteExportRequest({ ...validRequest(), sourcePath: "../Outside.md" }),
    ).toThrow("traversal");
    expect(() =>
      parsePublishNoteExportRequest({ ...validRequest(), expectedRevision: "short" }),
    ).toThrow("invalid note revision");
    expect(() =>
      parsePublishNoteExportRequest({ ...validRequest(), html: "<html></html>" }),
    ).toThrow("invalid standalone HTML");
  });
});
