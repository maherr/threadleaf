// @vitest-environment jsdom

import { history, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type {
  VaultImageResponse,
  VaultNoteEmbedResponse,
  WorkspaceLinkSummary,
} from "../shared/contracts";
import { createLivePreviewExtension } from "./live-preview";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function readyEmbed(
  path: string,
  content: string,
  links: WorkspaceLinkSummary[] = [],
  vaultId = "vault-a",
): VaultNoteEmbedResponse {
  return {
    status: "ready",
    vaultId,
    path,
    revision: "e".repeat(64),
    sourceSize: Buffer.byteLength(content),
    contentBytes: Buffer.byteLength(content),
    content,
    startLine: 1,
    endLine: Math.max(1, content.split("\n").length),
    kind: "note",
    subpath: null,
    links,
  };
}

function readyImage(vaultId: string, marker: string): VaultImageResponse {
  return {
    status: "ready",
    vaultId,
    path: "pixel.png",
    mimeType: "image/png",
    size: marker.length,
    revision: "i".repeat(64),
    base64: marker,
  };
}

const unavailableImage = async (): Promise<VaultImageResponse> => ({
  status: "unavailable",
  vaultId: "vault-a",
  reason: "missing",
  message: "No image fixture was provided.",
});

type LoadImage = NonNullable<Parameters<typeof createLivePreviewExtension>[0]["loadImage"]>;
type LoadNoteEmbed = NonNullable<Parameters<typeof createLivePreviewExtension>[0]["loadNoteEmbed"]>;

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function editorFor(
  source: string,
  current: { path: string; vaultId: string },
  loadNoteEmbed: LoadNoteEmbed,
  loadImage: LoadImage = unavailableImage,
  activateTag: (tag: string) => void = () => undefined,
): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({
    state: EditorState.create({
      doc: `${source}\n\n`,
      selection: { anchor: source.length + 2 },
      extensions: [
        history(),
        markdown({ base: markdownLanguage }),
        createLivePreviewExtension({
          sourceNotePath: () => current.path,
          expectedVaultId: () => current.vaultId,
          activateLink: () => undefined,
          activateTag,
          loadImage,
          loadNoteEmbed,
        }),
      ],
    }),
    parent: host,
  });
  return { view, host };
}

function replaceOwnerWithEqualLinkTarget(
  view: EditorView,
  current: { path: string; vaultId: string },
  next: { path: string; vaultId: string },
): void {
  current.path = next.path;
  current.vaultId = next.vaultId;
  // A normal editor update rebuilds the visible decorations while retaining the
  // same link target. This is the ordering in which a navigation can expose a
  // dynamic owner callback to WidgetType.eq.
  const end = view.state.doc.length;
  view.dispatch({ changes: { from: end, to: end, insert: " " } });
}

describe("Live Preview async ownership", () => {
  it("renders inactive tags as anchors and reveals exact source on the active line", async () => {
    const source = "Tagged #Project/Atlas";
    const activated: string[] = [];
    const current = { path: "Current.md", vaultId: "vault-a" };
    const { view, host } = editorFor(
      source,
      current,
      async () => {
        throw new Error("The tag fixture has no note embeds.");
      },
      unavailableImage,
      (tag) => activated.push(tag),
    );

    await flushAsyncWork();
    const anchor = host.querySelector<HTMLAnchorElement>("a.tag.tl-live-tag");
    expect(anchor?.getAttribute("href")).toBe("#Project/Atlas");
    expect(anchor?.dataset.tagName).toBe("#Project/Atlas");
    anchor?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    expect(activated).toEqual(["Project/Atlas"]);

    view.dispatch({ selection: { anchor: source.indexOf("#") + 2 } });
    await flushAsyncWork();
    expect(host.querySelector("a.tag.tl-live-tag")).toBeNull();
    expect(host.querySelector(".tl-live-tag-source")?.textContent).toBe("#Project/Atlas");
    expect(view.state.doc.toString()).toBe(`${source}\n\n`);
    view.destroy();
    host.remove();
  });

  for (const change of [
    { label: "pane note", path: "New.md", vaultId: "vault-a" },
    { label: "vault", path: "Old.md", vaultId: "vault-b" },
  ]) {
    it(`replaces an image widget when the ${change.label} changes`, async () => {
      const oldResponse = deferred<VaultImageResponse>();
      const newResponse = deferred<VaultImageResponse>();
      const current = { path: "Old.md", vaultId: "vault-a" };
      const requests: { path: string; vaultId: string }[] = [];
      const { view, host } = editorFor(
        "![[pixel.png|same target]]",
        current,
        async () => {
          throw new Error("The image fixture does not contain note embeds.");
        },
        async (sourceNotePath, _target, expectedVaultId) => {
          requests.push({ path: sourceNotePath, vaultId: expectedVaultId });
          return sourceNotePath === "Old.md" && expectedVaultId === "vault-a"
            ? oldResponse.promise
            : newResponse.promise;
        },
      );

      await flushAsyncWork();
      expect(requests).toEqual([{ path: "Old.md", vaultId: "vault-a" }]);
      const oldFrame = host.querySelector<HTMLElement>(".tl-live-image");
      expect(oldFrame).not.toBeNull();

      replaceOwnerWithEqualLinkTarget(view, current, change);
      await flushAsyncWork();
      expect(requests).toEqual([
        { path: "Old.md", vaultId: "vault-a" },
        { path: change.path, vaultId: change.vaultId },
      ]);

      const newFrame = host.querySelector<HTMLElement>(".tl-live-image");
      expect(newFrame).not.toBeNull();
      expect(newFrame).not.toBe(oldFrame);
      newResponse.resolve(readyImage(change.vaultId, "new-image"));
      await flushAsyncWork();
      expect(newFrame?.dataset.status).toBe("ready");
      expect(newFrame?.querySelector("img")?.getAttribute("src")).toContain("new-image");
      expect(host.querySelectorAll(".tl-live-image")).toHaveLength(1);
      expect(host.querySelectorAll('.tl-live-image[aria-busy="true"]')).toHaveLength(0);

      oldResponse.resolve(readyImage("vault-a", "old-image"));
      await flushAsyncWork();
      expect(newFrame?.querySelector("img")?.getAttribute("src")).toContain("new-image");
      expect(host.querySelectorAll('.tl-live-image[aria-busy="true"]')).toHaveLength(0);
      view.destroy();
      host.remove();
    });

    it(`replaces a note embed widget when the ${change.label} changes`, async () => {
      const oldResponse = deferred<VaultNoteEmbedResponse>();
      const newResponse = deferred<VaultNoteEmbedResponse>();
      const current = { path: "Old.md", vaultId: "vault-a" };
      const requests: { path: string; vaultId: string }[] = [];
      const { view, host } = editorFor(
        "![[Linked Note.md|same target]]",
        current,
        async (sourceNotePath, _target, _subpath, expectedVaultId) => {
          requests.push({ path: sourceNotePath, vaultId: expectedVaultId });
          return sourceNotePath === "Old.md" && expectedVaultId === "vault-a"
            ? oldResponse.promise
            : newResponse.promise;
        },
      );

      await flushAsyncWork();
      expect(requests).toEqual([{ path: "Old.md", vaultId: "vault-a" }]);
      const oldCard = host.querySelector<HTMLElement>(".tl-live-embed");
      expect(oldCard).not.toBeNull();

      replaceOwnerWithEqualLinkTarget(view, current, change);
      await flushAsyncWork();
      expect(requests).toEqual([
        { path: "Old.md", vaultId: "vault-a" },
        { path: change.path, vaultId: change.vaultId },
      ]);

      const newCard = host.querySelector<HTMLElement>(".tl-live-embed");
      expect(newCard).not.toBeNull();
      expect(newCard).not.toBe(oldCard);
      newResponse.resolve(readyEmbed("Linked Note.md", "new embed", [], change.vaultId));
      await flushAsyncWork();
      expect(newCard?.dataset.tlTransclusionStatus).toBe("ready");
      expect(newCard?.querySelector(".tl-live-embed-preview")?.textContent).toContain("new embed");
      expect(host.querySelectorAll(".tl-live-embed")).toHaveLength(1);
      expect(
        host.querySelectorAll(".tl-live-embed:not([data-tl-transclusion-status='ready'])"),
      ).toHaveLength(0);

      oldResponse.resolve(readyEmbed("Linked Note.md", "old embed"));
      await flushAsyncWork();
      expect(newCard?.querySelector(".tl-live-embed-preview")?.textContent).toContain("new embed");
      expect(host.querySelectorAll(".tl-live-embed")).toHaveLength(1);
      expect(
        host.querySelectorAll(".tl-live-embed:not([data-tl-transclusion-status='ready'])"),
      ).toHaveLength(0);
      view.destroy();
      host.remove();
    });
  }

  it("does not apply a top-level embed after the owning note changes", async () => {
    const pending = deferred<VaultNoteEmbedResponse>();
    const current = { path: "Current.md", vaultId: "vault-a" };
    const { view, host } = editorFor("![[Embedded.md]]", current, async () => pending.promise);

    await flushAsyncWork();
    const card = host.querySelector<HTMLElement>(".tl-live-embed");
    expect(card).not.toBeNull();
    current.path = "Other.md";
    pending.resolve(readyEmbed("Embedded.md", "This belongs to the old note."));
    await flushAsyncWork();

    expect(card?.querySelector(".tl-live-embed-preview")).toBeNull();
    view.destroy();
    host.remove();
  });

  it("does not apply nested hydration after the owning pane switches notes", async () => {
    const nested = deferred<VaultNoteEmbedResponse>();
    const current = { path: "Current.md", vaultId: "vault-a" };
    let request = 0;
    const links: WorkspaceLinkSummary[] = [
      {
        label: "Nested",
        status: "resolved",
        path: "Nested.md",
        target: "Nested",
        subpath: null,
        embed: true,
        syntax: "wiki",
      },
    ];
    const { view, host } = editorFor("![[Embedded.md]]", current, async () => {
      request += 1;
      return request === 1 ? readyEmbed("Embedded.md", "Top level", links) : nested.promise;
    });

    await flushAsyncWork();
    expect(request).toBe(2);
    current.path = "Other.md";
    nested.resolve(readyEmbed("Nested.md", "Nested content from the old pane."));
    await flushAsyncWork();

    expect(
      host.querySelector(".tl-live-embed-nested[data-tl-transclusion-status='ready']"),
    ).toBeNull();
    view.destroy();
    host.remove();
  });

  it("keeps frontmatter math and footnote continuations source-visible", async () => {
    const source = [
      "---",
      "$$",
      "\\alpha",
      "$$",
      "---",
      "",
      "Text[^source]",
      "",
      "[^source]: Definition stays exact.",
      "    Inline $x$ and ![[Nested.md]] remain source.",
    ].join("\n");
    const current = { path: "Current.md", vaultId: "vault-a" };
    const { view, host } = editorFor(source, current, async () => {
      throw new Error("The source-only continuation must not load an embed.");
    });

    await flushAsyncWork();
    expect(host.querySelector(".tl-live-math, .tl-live-math-block")).toBeNull();
    expect(host.querySelector(".tl-live-embed")).toBeNull();
    expect(view.state.doc.toString()).toBe(`${source}\n\n`);
    expect(host.textContent).toContain("    Inline $x$ and ![[Nested.md]] remain source.");
    view.destroy();
    host.remove();
  });

  it("keeps inline raw HTML contents source-visible without hiding following Markdown", async () => {
    const source =
      "outside <span>- [ ] $x$ ![[pixel.png]] ![[Nested.md]] [^ok]</span> **after**\n\n[^ok]: note";
    const current = { path: "Current.md", vaultId: "vault-a" };
    const { view, host } = editorFor(
      source,
      current,
      async () => {
        throw new Error("Inline HTML contents must not load note embeds.");
      },
      async () => {
        throw new Error("Inline HTML contents must not load images.");
      },
    );

    await flushAsyncWork();
    expect(host.querySelector(".tl-live-task, .tl-live-math, .tl-live-image, .tl-live-embed")).toBe(
      null,
    );
    expect(host.querySelector(".tl-live-strong")).not.toBeNull();
    expect(view.state.doc.toString()).toBe(`${source}\n\n`);
    view.destroy();
    host.remove();
  });

  it("keeps mounted raw HTML open across inline and fenced code close-tag lookalikes", async () => {
    const sources = [
      "<span>`</span>`\n**inside**\n</span>\n**outside**",
      ...["```", "~~~"].map(
        (marker) =>
          `prefix <span>\n${marker}\n</span>\n${marker}\n**inside**\n</span>\n**outside**`,
      ),
    ];
    for (const source of sources) {
      const current = { path: "Current.md", vaultId: "vault-a" };
      const { view, host } = editorFor(source, current, async () => {
        throw new Error("The code lookalike fixture has no note embeds.");
      });
      await flushAsyncWork();
      const strong = [...host.querySelectorAll<HTMLElement>(".tl-live-strong")];
      expect(strong, source).toHaveLength(1);
      expect(strong[0]?.dataset.tlSourceFrom).toBe(String(source.lastIndexOf("**outside**")));
      view.destroy();
      host.remove();
    }
  });

  it("keeps mounted raw script text opaque through a close-tag lookalike", async () => {
    const source = `<span><script>const html = "</div>"; \`unmatched\n[^hidden]: script text\n</script></span>\n**outside**`;
    const current = { path: "Current.md", vaultId: "vault-a" };
    const { view, host } = editorFor(source, current, async () => {
      throw new Error("The raw script fixture has no note embeds.");
    });

    await flushAsyncWork();
    const strong = [...host.querySelectorAll<HTMLElement>(".tl-live-strong")];
    expect(strong).toHaveLength(1);
    expect(strong[0]?.dataset.tlSourceFrom).toBe(String(source.indexOf("**outside**")));
    expect(host.querySelector(".tl-live-math, .tl-live-image, .tl-live-embed")).toBeNull();
    expect(view.state.doc.toString()).toBe(`${source}\n\n`);
    view.destroy();
    host.remove();
  });

  it("keeps raw-text and mismatched-fence contents source-visible when mounted", async () => {
    const source = [
      `<textarea>[[hidden]] $x$ </textarea>`,
      "~~~",
      "```",
      "[^code]: this is still fenced source",
      "**also source**",
    ].join("\n");
    const current = { path: "Current.md", vaultId: "vault-a" };
    const { view, host } = editorFor(source, current, async () => {
      throw new Error("The opacity fixture has no note embeds.");
    });

    await flushAsyncWork();
    expect(host.querySelector(".tl-live-link, .tl-live-math, .tl-live-footnote")).toBeNull();
    expect(host.querySelector(".tl-live-strong")).toBeNull();
    expect(host.textContent).toContain("[[hidden]] $x$");
    expect(host.textContent).toContain("[^code]: this is still fenced source");
    expect(host.textContent).toContain("**also source**");
    view.destroy();
    host.remove();
  });

  it("keeps an immutable embed request identity separate from the dynamic stale guard", async () => {
    const pending = deferred<VaultNoteEmbedResponse>();
    const current = { path: "Current.md", vaultId: "vault-a" };
    const requests: Array<[string, string, string | null, string]> = [];
    const { view, host } = editorFor(
      "![[Target.md]]",
      current,
      async (sourceNotePath, target, subpath, expectedVaultId) => {
        requests.push([sourceNotePath, target, subpath, expectedVaultId]);
        current.path = "Other.md";
        current.vaultId = "vault-b";
        return pending.promise;
      },
    );

    pending.resolve(readyEmbed("Target.md", "# stale"));
    await flushAsyncWork();
    expect(requests[0]).toEqual(["Current.md", "Target.md", null, "vault-a"]);
    const embed = host.querySelector<HTMLElement>(".tl-live-embed");
    expect(embed?.dataset.tlTransclusionStatus).toBeUndefined();
    expect(embed?.querySelector(".tl-live-embed-preview")).toBeNull();
    view.destroy();
    host.remove();
  });

  it("binds each table body widget to its own source line", async () => {
    const source = [
      "| Field | Value |",
      "| --- | --- |",
      "| mode | live |",
      "| owner | fixture |",
    ].join("\n");
    const current = { path: "Current.md", vaultId: "vault-a" };
    const { view, host } = editorFor(source, current, async () => {
      throw new Error("The table fixture does not contain embeds.");
    });

    await flushAsyncWork();
    const rows = [...host.querySelectorAll<HTMLElement>(".tl-live-table-row-body")];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.dataset.tlSourceFrom, row.dataset.tlSourceTo])).toEqual([
      [
        String(source.indexOf("| mode")),
        String(source.indexOf("| mode") + "| mode | live |".length),
      ],
      [
        String(source.indexOf("| owner")),
        String(source.indexOf("| owner") + "| owner | fixture |".length),
      ],
    ]);
    const separator = host.querySelector<HTMLElement>(".tl-live-table-row-separator");
    expect(separator?.getAttribute("aria-hidden")).toBeNull();
    expect(separator?.getAttribute("aria-label")).toBe("Table alignment row");
    expect(separator?.tabIndex).toBe(-1);
    view.destroy();
    host.remove();
  });
});

describe("Live Preview task controls", () => {
  it("renders custom task states, toggles exact source, preserves undo, and reveals the active line", async () => {
    const source = [
      "- [ ] open",
      "  - [x] nested",
      "> - [?] quoted",
      "    1. [🟡] indented unicode",
    ].join("\n");
    const current = { path: "Tasks.md", vaultId: "vault-a" };
    const { view, host } = editorFor(source, current, async () => {
      throw new Error("The task fixture does not contain embeds.");
    });

    await flushAsyncWork();
    const checkboxes = [...host.querySelectorAll<HTMLInputElement>(".tl-live-task")];
    expect(checkboxes.map((checkbox) => checkbox.dataset.task)).toEqual(["", "x", "?", "🟡"]);
    expect(checkboxes.map((checkbox) => checkbox.checked)).toEqual([false, true, true, true]);
    const taskLines = [...host.querySelectorAll<HTMLElement>(".cm-line")];
    expect(taskLines.some((line) => line.dataset.task === "?")).toBe(true);
    expect(taskLines.some((line) => line.dataset.task === "🟡")).toBe(true);

    const custom = checkboxes[2];
    if (!custom) {
      throw new Error("Expected the custom task checkbox.");
    }
    custom.click();
    expect(view.state.doc.toString()).toBe(`${source.replace("[?]", "[ ]")}\n\n`);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(`${source}\n\n`);

    const activeLine = source.indexOf("> - [?]");
    view.dispatch({ selection: { anchor: activeLine } });
    const quotedLine = [...host.querySelectorAll<HTMLElement>(".cm-line")].find(
      (line) => line.dataset.task === "?",
    );
    expect(quotedLine?.querySelector(".tl-live-task")).toBeNull();
    expect(quotedLine?.textContent).toContain("[?] quoted");
    view.destroy();
    host.remove();
  });
});
