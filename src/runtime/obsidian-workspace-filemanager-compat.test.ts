import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, CommandRegistry, FileManager, NoticeBus, TFile, Vault } from "./obsidian-compat";
import { Editor, MarkdownView, WorkspaceLeaf } from "./obsidian-ui-compat";
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

describe("Obsidian workspace compatibility wedge", () => {
  it("returns non-null production leaves with tab and split pane semantics, or throws when a pane is unsupported", async () => {
    await withDocument(async () => {
      const unsupportedWorkspace = new Workspace();
      expect(() => unsupportedWorkspace.getLeaf(false)).toThrow(
        "requires an installed compatibility leaf factory",
      );
      expect(() => unsupportedWorkspace.splitActiveLeaf()).toThrow(
        "requires an installed compatibility leaf factory",
      );
      expect(() => unsupportedWorkspace.getRightLeaf(true)).toThrow(
        "requires an installed compatibility leaf factory",
      );
      const wrongShapeWorkspace = new Workspace();
      wrongShapeWorkspace.setLeafFactory(
        (containerEl) =>
          ({
            containerEl,
            getViewState: () => ({ state: {}, type: "empty" }),
            id: "duck-typed-leaf",
            openFile: async () => undefined,
          }) as unknown as WorkspaceLeaf,
      );
      expect(() => wrongShapeWorkspace.getLeaf(false)).toThrow("actual WorkspaceLeaf");

      // A prototype graft passes instanceof without running the constructor;
      // the construction brand must still reject it.
      const graftedWorkspace = new Workspace();
      graftedWorkspace.setLeafFactory((containerEl) =>
        Object.assign(Object.create(WorkspaceLeaf.prototype) as WorkspaceLeaf, {
          containerEl,
          getViewState: () => ({ state: {}, type: "empty" }),
          id: "grafted-prototype-leaf",
          openFile: async () => undefined,
        }),
      );
      expect(() => graftedWorkspace.getLeaf(false)).toThrow("actual WorkspaceLeaf");

      const vault = await createVault();
      const app = new App(vault, new CommandRegistry(), new NoticeBus(() => undefined));
      app.workspace.setLeafFactory((containerEl) => new WorkspaceLeaf(app, containerEl));

      const first = app.workspace.getLeaf(false);
      const tab = app.workspace.getLeaf("tab");
      const booleanTab = app.workspace.getLeaf(true);
      const split = app.workspace.getLeaf("split", "horizontal");
      const parentLeaf = app.workspace.createLeafInParent(app.workspace.rootSplit, 0);
      const secondSplit = app.workspace.splitActiveLeaf("vertical");
      const rightLeaf = app.workspace.getRightLeaf(true);
      if (!rightLeaf) {
        throw new Error("getRightLeaf(true) did not create a WorkspaceLeaf.");
      }

      for (const leaf of [first, tab, booleanTab, split, parentLeaf, secondSplit, rightLeaf]) {
        expect(leaf).toBeInstanceOf(WorkspaceLeaf);
      }
      expect(app.workspace.getLeaf(false)).toBe(first);
      expect(tab.containerEl.dataset.threadleafPaneType).toBe("tab");
      expect(booleanTab.containerEl.dataset.threadleafPaneType).toBe("tab");
      expect(split.containerEl.dataset.threadleafPaneType).toBe("split");
      expect(secondSplit.containerEl.dataset.threadleafPaneType).toBe("split");
      expect(rightLeaf.containerEl.dataset.threadleafPaneType).toBe("split");
      expect(app.workspace.getRightLeaf(false)).toBe(rightLeaf);
      expect(app.workspace.rootSplit.direction).toBe("vertical");
      expect(app.workspace.rootSplit.children).toContain(parentLeaf);
      expect(app.workspace.getUnpinnedLeaf()).toBe(first);

      app.workspace.setActiveLeaf(tab);
      expect(first.containerEl.hidden).toBe(true);
      expect(tab.containerEl.hidden).toBe(false);
      expect(split.containerEl.hidden).toBe(true);
      expect(secondSplit.containerEl.hidden).toBe(true);
      app.workspace.setActiveLeaf(split);
      expect(first.containerEl.hidden).toBe(true);
      expect(tab.containerEl.hidden).toBe(true);
      expect(split.containerEl.hidden).toBe(false);
      expect(() => app.workspace.getLeaf("window")).toThrow("popout leaves are not supported");
    });
  });

  it("keeps side leaves, root iteration, group ids, duplicate state, and recent files coherent", async () => {
    const vault = await createVault({
      "Notes/One.md": "one",
      "Notes/Two.md": "two",
    });
    await withDocument(async () => {
      const app = new App(vault, new CommandRegistry(), new NoticeBus(() => undefined));
      app.workspace.setLeafFactory((containerEl) => new WorkspaceLeaf(app, containerEl));
      const one = vault.getFileByPath("Notes/One.md");
      const two = vault.getFileByPath("Notes/Two.md");
      if (!one || !two) {
        throw new Error("Recent-file fixtures were not discovered.");
      }

      const primary = app.workspace.getLeaf(false);
      await primary.setViewState({ active: false, state: { seed: true }, type: "empty" });
      const grouped = app.workspace.getLeaf("tab");
      await grouped.setViewState({ active: false, state: { grouped: true }, type: "empty" });
      grouped.setGroupMember(primary);
      grouped.setGroup("shared");

      const left = await app.workspace.ensureSideLeaf("markdown", "left", {
        active: false,
        reveal: false,
        state: { file: one.path },
      });
      const right = await app.workspace.ensureSideLeaf("markdown", "right", {
        active: false,
        reveal: false,
        state: { file: two.path },
      });
      const duplicate = await app.workspace.duplicateLeaf(primary, "tab");
      const splitDuplicate = await app.workspace.duplicateLeaf(primary, "horizontal");

      await primary.openFile(one);
      await grouped.openFile(two);
      app.workspace.setActiveLeaf(primary);
      app.workspace.setActiveLeaf(grouped, false, false);

      const rootLeaves: WorkspaceLeaf[] = [];
      app.workspace.iterateRootLeaves((leaf) => rootLeaves.push(leaf));
      const groupLeaves = app.workspace.getGroupLeaves("shared");
      const layout = app.workspace.getLayout();

      expect(app.workspace.getLeftLeaf(false)).toBe(left);
      expect(app.workspace.getRightLeaf(false)).toBe(right);
      expect(rootLeaves).toEqual(
        expect.arrayContaining([primary, grouped, duplicate, splitDuplicate]),
      );
      expect(rootLeaves).not.toContain(left);
      expect(rootLeaves).not.toContain(right);
      expect(groupLeaves).toEqual(
        expect.arrayContaining([primary, grouped, duplicate, splitDuplicate]),
      );
      expect(duplicate.getViewState()).toMatchObject({
        state: { seed: true },
        type: "empty",
      });
      expect(splitDuplicate.getViewState()).toMatchObject({
        state: { seed: true },
        type: "empty",
      });
      expect(app.workspace.getMostRecentLeaf(app.workspace.rootSplit)).toBe(grouped);
      expect(app.workspace.getLastOpenFiles()).toEqual(["Notes/Two.md", "Notes/One.md"]);
      expect(layout.left.children).toHaveLength(1);
      expect(layout.right.children).toHaveLength(1);
      expect(layout.main.children).toHaveLength(4);
    });
  });

  it("returns real TFile and MarkdownFileInfo shapes, and rejects plausible wrong-shaped active values", async () => {
    const vault = await createVault({
      "Notes/Active.md": "active",
    });
    await withDocument(async (document) => {
      const app = new App(vault, new CommandRegistry(), new NoticeBus(() => undefined));
      app.workspace.setLeafFactory((containerEl) => new WorkspaceLeaf(app, containerEl));
      const file = vault.getFileByPath("Notes/Active.md");
      if (!file) {
        throw new Error("Active-file fixture was not discovered.");
      }

      const fileLeaf = app.workspace.getLeaf(false);
      await fileLeaf.openFile(file);
      const activeFile = app.workspace.getActiveFile();
      expect(activeFile).toBeInstanceOf(TFile);
      expect(activeFile).toMatchObject({
        path: "Notes/Active.md",
        vault,
      });
      const activeEditor = app.workspace.activeEditor;
      expect(activeEditor).toMatchObject({
        app,
        file,
        hoverPopover: null,
      });
      expect(activeEditor?.editor).toBeInstanceOf(Editor);
      expect(typeof app.workspace.activeEditor).not.toBe("function");
      app.workspace.activeEditor = activeEditor;
      expect(app.workspace.activeEditor).toBe(activeEditor);

      app.workspace.activeEditor = {
        app,
        editor: {},
        file,
        hoverPopover: null,
      } as never;
      expect(app.workspace.activeEditor).toBeNull();

      app.workspace.activeEditor = {
        app,
        editor: new Editor(),
        file,
        hoverPopover: {},
      } as never;
      expect(app.workspace.activeEditor).toBeNull();

      const malformedFileLeaf = app.workspace.getLeaf("split");
      malformedFileLeaf.view = {
        app,
        editor: {},
        file: { path: "Notes/Not-a-TFile.md" },
        hoverPopover: null,
      } as never;
      app.workspace.setActiveLeaf(malformedFileLeaf);
      expect(app.workspace.activeEditor).toBeNull();
      expect(app.workspace.getActiveFile()).toMatchObject({
        path: "Notes/Active.md",
        vault,
      });

      const emptyWorkspace = new Workspace();
      const malformedOnlyLeaf = {
        app,
        containerEl: document.createElement("div"),
        getViewState: () => ({ state: {}, type: "markdown" }),
        id: "malformed-file-only-leaf",
        openFile: async () => undefined,
        view: {
          app,
          file: { path: "Notes/Not-a-TFile.md" },
          hoverPopover: null,
        },
      } as unknown as WorkspaceLeaf;
      emptyWorkspace.registerLeaf(malformedOnlyLeaf);
      expect(emptyWorkspace.getActiveFile()).toBeNull();
      expect(emptyWorkspace.activeEditor).toBeNull();
    });
  });

  it("honors OpenViewState state, group, and active fields without forcing activation", async () => {
    const vault = await createVault({
      "Notes/Source.md": "source",
      "Notes/Target.md": "zero\none two\nthree",
    });
    await withDocument(async () => {
      const app = new App(vault, new CommandRegistry(), new NoticeBus(() => undefined));
      app.workspace.setLeafFactory((containerEl) => new WorkspaceLeaf(app, containerEl));
      const sourceFile = vault.getFileByPath("Notes/Source.md");
      if (!sourceFile) {
        throw new Error("Source fixture was not discovered.");
      }
      const sourceLeaf = app.workspace.getLeaf(false);
      await sourceLeaf.openFile(sourceFile);

      await app.workspace.openLinkText("Target#Heading", "Notes/Source.md", "split", {
        active: false,
        eState: {
          cursor: {
            from: { ch: 0, line: 1 },
            to: { ch: 3, line: 1 },
          },
        },
        group: sourceLeaf,
        state: { mode: "source" },
      });

      const targetLeaf = app.workspace
        .getLeavesOfType("markdown")
        .find((leaf) => leaf !== sourceLeaf);
      if (!targetLeaf) {
        throw new Error("openLinkText did not create a target WorkspaceLeaf.");
      }
      expect(app.workspace.activeLeaf).toBe(sourceLeaf);
      expect(targetLeaf.getViewState()).toMatchObject({
        state: {
          file: "Notes/Target.md",
          mode: "source",
          subpath: "#Heading",
        },
        type: "markdown",
      });
      expect(app.workspace.getLeafGroupMember(targetLeaf)).toBe(sourceLeaf);
      expect(targetLeaf.view).toBeInstanceOf(MarkdownView);
      if (!(targetLeaf.view instanceof MarkdownView)) {
        throw new Error("openLinkText did not open a MarkdownView.");
      }
      expect(targetLeaf.view.editor.getSelection()).toBe("one");

      await targetLeaf.setViewState({
        active: false,
        group: sourceLeaf,
        pinned: true,
        state: { file: "Notes/Target.md", mode: "preview" },
        type: "markdown",
      });
      expect(app.workspace.activeLeaf).toBe(sourceLeaf);
      expect(targetLeaf.getViewState()).toMatchObject({
        pinned: true,
        state: { file: "Notes/Target.md", mode: "preview" },
        type: "markdown",
      });

      app.workspace.setActiveLeaf(targetLeaf);
      expect(sourceLeaf.containerEl.hidden).toBe(true);
      expect(targetLeaf.containerEl.hidden).toBe(false);
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
  it("honestly refuses preference-backed path and Markdown-link helpers until the real preferences are available", async () => {
    const vault = await createVault({
      "Notes/Current.md": "current",
      "Notes/Target.md": "target",
    });
    const fileManager = new FileManager(vault);
    const file = vault.getFileByPath("Notes/Target.md");
    if (!file) {
      throw new Error("Link fixture file was not discovered.");
    }
    const getConfig = vi.spyOn(vault, "getConfig").mockReturnValue("fabricated preference");

    expect(() => fileManager.getNewFileParent("Notes/Current.md")).toThrow("not yet supported");
    expect(() => fileManager.generateMarkdownLink(file, "Notes/Current.md")).toThrow(
      "not yet supported",
    );
    expect(getConfig).not.toHaveBeenCalled();
  });

  it("visibly refuses rename when link-bearing vault files could require Obsidian preference-controlled rewrites", async () => {
    const fixtureVault = await createVault({
      "Notes/Inbound.md": "[[Notes/Target]]",
      "Notes/Target.md": "target",
    });
    const renameFile = vi.fn(async (sourcePath: string, targetPath: string) => {
      await fs.mkdir(path.dirname(path.join(fixtureVault.rootPath, targetPath)), {
        recursive: true,
      });
      await fs.rename(
        path.join(fixtureVault.rootPath, sourcePath),
        path.join(fixtureVault.rootPath, targetPath),
      );
      return {
        from: sourcePath,
        status: "committed" as const,
        to: targetPath,
        transactionId: "unexpected-link-bearing-rename",
      };
    });
    const vault = new Vault(fixtureVault.rootPath, undefined, {
      renameFile,
      writeText: vi.fn(),
    });
    const fileManager = new FileManager(vault);
    const file = vault.getFileByPath("Notes/Target.md");
    if (!file) {
      throw new Error("Rename fixture file was not discovered.");
    }
    const rename = vi.spyOn(vault, "rename");

    await expect(fileManager.renameFile(file, "Notes/Renamed.md")).rejects.toThrow(
      "not yet supported",
    );
    expect(rename).not.toHaveBeenCalled();
    expect(renameFile).not.toHaveBeenCalled();
    expect(vault.getFileByPath("Notes/Target.md")).toMatchObject({
      path: "Notes/Target.md",
      vault,
    });
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

  it("processes Markdown frontmatter through the vault revisioned write path", async () => {
    const vault = await createVault({
      "Notes/Frontmatter.md": "\ufeff---\r\ntitle: Old\r\nremove: true\r\n---\r\nBody\r\n",
    });
    const file = vault.getFileByPath("Notes/Frontmatter.md");
    if (!file) {
      throw new Error("Frontmatter fixture file was not discovered.");
    }
    const modify = vi.spyOn(vault, "modify").mockResolvedValue();

    await new FileManager(vault).processFrontMatter(file, (frontmatter) => {
      expect(frontmatter).toEqual({ title: "Old", remove: true });
      frontmatter.title = "New";
      frontmatter.tags = ["one", "two"];
      delete frontmatter.remove;
    });

    expect(modify).toHaveBeenCalledWith(
      file,
      "\ufeff---\r\ntitle: New\r\ntags:\r\n  - one\r\n  - two\r\n---\r\nBody\r\n",
    );
  });

  it("creates frontmatter for a Markdown file without a frontmatter block", async () => {
    const vault = await createVault({ "No-frontmatter.md": "# Body\n" });
    const file = vault.getFileByPath("No-frontmatter.md");
    if (!file) {
      throw new Error("No-frontmatter fixture file was not discovered.");
    }
    const modify = vi.spyOn(vault, "modify").mockResolvedValue();

    await new FileManager(vault).processFrontMatter(file, (frontmatter) => {
      frontmatter.kind = "created";
    });

    expect(modify).toHaveBeenCalledWith(file, "---\nkind: created\n---\n# Body\n");
  });

  it("rejects non-Markdown and non-object YAML without writing", async () => {
    const vault = await createVault({
      "image.png": "bytes",
      "scalar.md": "---\n- one\n- two\n---\nBody\n",
    });
    const image = vault.getFileByPath("image.png");
    const scalar = vault.getFileByPath("scalar.md");
    if (!image || !scalar) {
      throw new Error("Frontmatter rejection fixtures were not discovered.");
    }
    const modify = vi.spyOn(vault, "modify").mockResolvedValue();
    const fileManager = new FileManager(vault);

    await expect(fileManager.processFrontMatter(image, () => undefined)).rejects.toThrow(
      "Markdown file",
    );
    await expect(fileManager.processFrontMatter(scalar, () => undefined)).rejects.toThrow(
      "YAML object",
    );
    expect(modify).not.toHaveBeenCalled();
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
