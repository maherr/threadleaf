import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileManager, TFile, Vault } from "./obsidian-compat";
import { Workspace } from "./obsidian-workspace-compat";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

async function createVault(files: Record<string, string> = {}): Promise<Vault> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-workspace-filemanager-"));
  temporaryDirectories.push(rootPath);
  for (const [relativePath, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(rootPath, relativePath)), { recursive: true });
    await fs.writeFile(path.join(rootPath, relativePath), content, "utf8");
  }
  return new Vault(rootPath);
}

async function withDocument<T>(callback: (document: Document) => T | Promise<T>): Promise<T> {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url: "https://threadleaf.invalid/",
  });
  const previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: dom.window.document,
    writable: true,
  });
  try {
    return await callback(dom.window.document);
  } finally {
    if (previousDocument === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
        writable: true,
      });
    }
    dom.window.close();
  }
}

function registerLeaf(
  workspace: Workspace,
  document: Document,
  id: string,
  view: Record<string, unknown>,
) {
  const containerEl = document.createElement("div");
  document.body.append(containerEl);
  const leaf = {
    app: null as unknown,
    containerEl,
    getViewState: () => ({ state: {}, type: "fixture" }),
    id,
    openFile: vi.fn(async () => undefined),
    view,
  };
  workspace.registerLeaf(leaf);
  return leaf;
}

function installLeafFactory(workspace: Workspace, document: Document): void {
  let sequence = 0;
  workspace.setLeafFactory((providedContainer) => {
    sequence += 1;
    const leaf = {
      app: null as unknown,
      containerEl: providedContainer ?? document.createElement("div"),
      getViewState: () => ({ state: {}, type: "empty" }),
      id: `fixture-leaf-${sequence}`,
      openFile: vi.fn(async () => undefined),
      view: null,
    };
    workspace.registerLeaf(leaf);
    return leaf;
  });
}

describe("Obsidian workspace compatibility wedge", () => {
  it("getActiveFile returns the active file and retains the most recent file for non-file views", async () => {
    await withDocument((document) => {
      const workspace = new Workspace();
      const note = { path: "Notes/Active.md" };
      const fileLeaf = registerLeaf(workspace, document, "file", { file: note });
      const utilityLeaf = registerLeaf(workspace, document, "utility", {
        getViewType: () => "graph",
      });

      workspace.setActiveLeaf(fileLeaf);
      expect(workspace.getActiveFile()).toBe(note);
      workspace.setActiveLeaf(utilityLeaf);
      expect(workspace.getActiveFile()).toBe(note);
    });
  });

  it("activeEditor is the exact active editor-bearing view, remains writable, and is null otherwise", async () => {
    await withDocument((document) => {
      const workspace = new Workspace();
      const editorView = { app: {}, editor: {}, file: { path: "Notes/Active.md" } };
      const editorLeaf = registerLeaf(workspace, document, "editor", editorView);
      const utilityLeaf = registerLeaf(workspace, document, "utility", { file: null });

      workspace.setActiveLeaf(editorLeaf);
      expect(workspace.activeEditor).toBe(editorView);
      const embeddedEditor = { editor: {}, file: { path: "Boards/Active.md" } };
      workspace.activeEditor = embeddedEditor;
      expect(workspace.activeEditor).toBe(embeddedEditor);
      workspace.setActiveLeaf(utilityLeaf);
      expect(workspace.activeEditor).toBeNull();
    });
  });

  it("openLinkText resolves from the source, opens on the selected leaf, and leaves misses untouched", async () => {
    await withDocument(async (document) => {
      const workspace = new Workspace();
      const target = { path: "Notes/Target.md" };
      const getFirstLinkpathDest = vi.fn((linktext: string) =>
        linktext.startsWith("Target") ? target : null,
      );
      const leaf = registerLeaf(workspace, document, "active", { file: null });
      leaf.app = { metadataCache: { getFirstLinkpathDest } };
      const openState = { state: { line: 7 } };

      await expect(
        workspace.openLinkText("Target#Heading", "Notes/Source.md", false, openState),
      ).resolves.toBeUndefined();
      expect(getFirstLinkpathDest).toHaveBeenCalledWith("Target#Heading", "Notes/Source.md");
      expect(leaf.openFile).toHaveBeenCalledWith(target, openState);

      await workspace.openLinkText("Missing", "Notes/Source.md");
      expect(leaf.openFile).toHaveBeenCalledOnce();
    });
  });

  it("getRightLeaf returns null without a factory and stable or split right-sidebar leaves with one", async () => {
    await withDocument((document) => {
      const workspace = new Workspace();
      expect(workspace.getRightLeaf(false)).toBeNull();

      installLeafFactory(workspace, document);
      const first = workspace.getRightLeaf(false);
      expect(first).not.toBeNull();
      expect(workspace.getRightLeaf(false)).toBe(first);
      const split = workspace.getRightLeaf(true);
      expect(split).not.toBeNull();
      expect(split).not.toBe(first);
      expect(workspace.getLayout().right.children).toHaveLength(2);
      expect(workspace.getLayout().main.children).toEqual([]);
    });
  });

  it("revealLeaf activates a registered leaf without claiming a foreign leaf", async () => {
    await withDocument(async (document) => {
      const workspace = new Workspace();
      const first = registerLeaf(workspace, document, "first", { file: null });
      const second = registerLeaf(workspace, document, "second", { file: null });
      workspace.setActiveLeaf(first);

      await expect(workspace.revealLeaf(second)).resolves.toBeUndefined();
      expect(workspace.activeLeaf).toBe(second);
      expect(second.containerEl.hidden).toBe(false);
      expect(first.containerEl.hidden).toBe(true);

      const foreign = { id: "foreign" };
      await workspace.revealLeaf(foreign);
      expect(workspace.activeLeaf).toBe(second);
    });
  });

  it("getUnpinnedLeaf mirrors the current leaf and returns null when none exists", async () => {
    await withDocument((document) => {
      const workspace = new Workspace();
      expect(workspace.getUnpinnedLeaf()).toBeNull();
      installLeafFactory(workspace, document);
      const created = workspace.getUnpinnedLeaf();
      expect(created).not.toBeNull();
      expect(workspace.getUnpinnedLeaf()).toBe(created);

      const freshWorkspace = new Workspace();
      const freshLeaf = registerLeaf(freshWorkspace, document, "fresh-active", { file: null });
      expect(freshWorkspace.getUnpinnedLeaf()).toBe(freshLeaf);
    });
  });

  it("splitActiveLeaf returns null without capability and creates the requested split shape", async () => {
    await withDocument((document) => {
      const workspace = new Workspace();
      expect(workspace.splitActiveLeaf()).toBeNull();
      installLeafFactory(workspace, document);
      const original = workspace.getLeaf(true);
      const split = workspace.splitActiveLeaf("horizontal");

      expect(original).not.toBeNull();
      expect(split).not.toBeNull();
      expect(split).not.toBe(original);
      expect(workspace.getLayout().main.direction).toBe("horizontal");
      expect(workspace.getLayout().main.children).toHaveLength(2);
    });
  });

  it("layoutReady is a boolean property, never a method-shaped compatibility trap", async () => {
    const workspace = new Workspace();
    const descriptor = Object.getOwnPropertyDescriptor(Workspace.prototype, "layoutReady");

    expect(descriptor?.get).toEqual(expect.any(Function));
    expect(workspace.layoutReady).toBe(false);
    expect(typeof workspace.layoutReady).toBe("boolean");
    await workspace.markLayoutReady();
    expect(workspace.layoutReady).toBe(true);
    expect(typeof workspace.layoutReady).not.toBe("function");
  });
});

describe("Obsidian FileManager compatibility wedge", () => {
  it("getNewFileParent returns root or a configured, existing source-relative folder", async () => {
    const vault = await createVault({
      "Notes/Current.md": "current",
      "Templates/.keep": "",
    });
    const fileManager = new FileManager(vault);

    expect(fileManager.getNewFileParent("Notes/Current.md").path).toBe("");
    vi.spyOn(vault, "getConfig").mockImplementation((key) => {
      if (key === "newFileLocation") {
        return "current";
      }
      return undefined;
    });
    expect(fileManager.getNewFileParent("Notes/Current.md").path).toBe("Notes");

    vi.mocked(vault.getConfig).mockImplementation((key) => {
      if (key === "newFileLocation") {
        return "folder";
      }
      return key === "newFileFolderPath" ? "Templates" : undefined;
    });
    expect(fileManager.getNewFileParent("Notes/Current.md").path).toBe("Templates");
  });

  it("generateMarkdownLink emits a wiki link with exact subpath, alias, and unique-path shape", async () => {
    const vault = await createVault({
      "Folder/Note.md": "first",
      "Other/Note.md": "second",
      "Other/Source.md": "source",
    });
    const fileManager = new FileManager(vault);
    const file = vault.getFileByPath("Folder/Note.md");
    if (!file) {
      throw new Error("Link fixture file was not discovered.");
    }

    expect(
      fileManager.generateMarkdownLink(file, "Other/Source.md", "#Heading", "Display text"),
    ).toBe("[[Folder/Note#Heading|Display text]]");
    expect(fileManager.generateMarkdownLink(file, "Other/Source.md")).toBe("[[Folder/Note]]");
    expect(() =>
      fileManager.generateMarkdownLink(new TFile(file.path, null), "Other/Source.md"),
    ).toThrow("active compatibility vault");
  });

  it("promptForDeletion cancels without mutation and trashes only after explicit confirmation", async () => {
    const vault = await createVault({ "Delete me.md": "content" });
    const fileManager = new FileManager(vault);
    const file = vault.getFileByPath("Delete me.md");
    if (!file) {
      throw new Error("Deletion fixture file was not discovered.");
    }
    vi.stubGlobal("confirm", undefined);
    const trashFile = vi.spyOn(fileManager, "trashFile").mockResolvedValue();
    await expect(fileManager.promptForDeletion(file)).resolves.toBe(false);
    expect(trashFile).not.toHaveBeenCalled();

    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.stubGlobal("confirm", confirm);

    await expect(fileManager.promptForDeletion(file)).resolves.toBe(false);
    expect(trashFile).not.toHaveBeenCalled();
    await expect(fileManager.promptForDeletion(file)).resolves.toBe(true);
    expect(trashFile).toHaveBeenCalledOnce();
    expect(trashFile).toHaveBeenCalledWith(file);
  });

  it("promptForFileDeletion is an exact boolean-preserving alias", async () => {
    const vault = await createVault({ "Alias.md": "content" });
    const fileManager = new FileManager(vault);
    const file = vault.getFileByPath("Alias.md");
    if (!file) {
      throw new Error("Alias deletion fixture file was not discovered.");
    }
    const promptForDeletion = vi.spyOn(fileManager, "promptForDeletion").mockResolvedValue(false);

    await expect(fileManager.promptForFileDeletion(file)).resolves.toBe(false);
    expect(promptForDeletion).toHaveBeenCalledOnce();
    expect(promptForDeletion).toHaveBeenCalledWith(file);
  });

  it("createNewMarkdownFile creates an empty unique Markdown file inside the supplied folder", async () => {
    const vault = await createVault({
      "Notes/Topic.md": "existing",
    });
    const fileManager = new FileManager(vault);
    const parent = vault.getFolderByPath("Notes");
    if (!parent) {
      throw new Error("Creation fixture folder was not discovered.");
    }
    const create = vi
      .spyOn(vault, "create")
      .mockImplementation(async (filePath) => new TFile(filePath, vault));

    const created = await fileManager.createNewMarkdownFile(parent, "Topic");
    expect(created).toBeInstanceOf(TFile);
    expect(created.path).toBe("Notes/Topic 1.md");
    expect(create).toHaveBeenCalledWith("Notes/Topic 1.md", "");

    const foreignVault = await createVault();
    await expect(
      fileManager.createNewMarkdownFile(foreignVault.getRoot(), "Foreign"),
    ).rejects.toThrow("active compatibility vault");
  });
});
