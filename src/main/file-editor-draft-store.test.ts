import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PersistedEditorDraft } from "../application/editor-draft";
import { FileEditorDraftStore } from "./file-editor-draft-store";

let sandboxPath: string;
let draftDirectory: string;
const vaultId = "a".repeat(64);

function draft(draftId = "9ee6115a-d87e-4c87-8cb8-b444695200cf"): PersistedEditorDraft {
  return {
    version: 3,
    draftId,
    vaultId,
    paneId: "primary",
    path: "Active.md",
    baseRevision: "b".repeat(64),
    content: "unsaved text",
    textRepresentation: { hasBom: false, lineEndingKinds: "", defaultLineEnding: "lf" },
    selection: { anchor: 3, head: 8 },
    updatedAt: "2026-08-12T08:00:00.000Z",
  };
}

beforeEach(async () => {
  sandboxPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-editor-drafts-"));
  draftDirectory = path.join(sandboxPath, "private", "editor-drafts");
});

afterEach(async () => {
  await fs.rm(sandboxPath, { recursive: true, force: true });
});

describe("FileEditorDraftStore", () => {
  it("returns null without creating private state", async () => {
    const store = new FileEditorDraftStore(draftDirectory);
    await expect(store.load(vaultId)).resolves.toBeNull();
    await expect(fs.stat(draftDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically replaces a draft with private file permissions", async () => {
    const store = new FileEditorDraftStore(draftDirectory);
    await store.save(draft());
    await store.save({
      ...draft(),
      content: "newer unsaved text",
      selection: { anchor: 18, head: 18 },
      updatedAt: "2026-08-12T08:00:01.000Z",
    });

    await expect(store.load(vaultId)).resolves.toMatchObject({
      content: "newer unsaved text",
      selection: { anchor: 18, head: 18 },
    });
    const stat = await fs.stat(path.join(draftDirectory, `${vaultId}.json`));
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("clears only the exact draft identity", async () => {
    const store = new FileEditorDraftStore(draftDirectory);
    await store.save(draft());

    await expect(store.clear(vaultId, "27fe59f8-2e21-46bf-a01f-58935f6b4f1d")).resolves.toBe(false);
    await expect(store.load(vaultId)).resolves.toEqual(draft());
    await expect(store.clear(vaultId, draft().draftId)).resolves.toBe(true);
    await expect(store.load(vaultId)).resolves.toBeNull();
  });

  it("keeps primary and secondary pane drafts independent", async () => {
    const store = new FileEditorDraftStore(draftDirectory);
    const secondary = {
      ...draft("27fe59f8-2e21-46bf-a01f-58935f6b4f1d"),
      paneId: "secondary" as const,
      path: "Other.md",
      content: "secondary text",
      selection: { anchor: 4, head: 4 },
    };
    await store.save(draft());
    await store.save(secondary);

    await expect(store.load(vaultId, "primary")).resolves.toEqual(draft());
    await expect(store.load(vaultId, "secondary")).resolves.toEqual(secondary);
    await expect(store.clear(vaultId, secondary.draftId, "secondary")).resolves.toBe(true);
    await expect(store.load(vaultId, "secondary")).resolves.toBeNull();
    await expect(store.load(vaultId, "primary")).resolves.toEqual(draft());
  });

  it("preserves malformed bytes for diagnosis", async () => {
    const store = new FileEditorDraftStore(draftDirectory);
    const filePath = path.join(draftDirectory, `${vaultId}.json`);
    await fs.mkdir(draftDirectory, { recursive: true });
    await fs.writeFile(filePath, "not json\n", "utf8");

    await expect(store.load(vaultId)).rejects.toThrow();
    await expect(store.clear(vaultId, draft().draftId)).rejects.toThrow();
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("not json\n");
  });
});
