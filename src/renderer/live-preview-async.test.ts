// @vitest-environment jsdom

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
): VaultNoteEmbedResponse {
  return {
    status: "ready",
    vaultId: "vault-a",
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

const unavailableImage = async (): Promise<VaultImageResponse> => ({
  status: "unavailable",
  vaultId: "vault-a",
  reason: "missing",
  message: "No image fixture was provided.",
});

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function editorFor(
  source: string,
  current: { path: string; vaultId: string },
  loadNoteEmbed: NonNullable<Parameters<typeof createLivePreviewExtension>[0]["loadNoteEmbed"]>,
): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({
    state: EditorState.create({
      doc: `${source}\n\n`,
      selection: { anchor: source.length + 2 },
      extensions: [
        markdown({ base: markdownLanguage }),
        createLivePreviewExtension({
          sourceNotePath: () => current.path,
          expectedVaultId: () => current.vaultId,
          activateLink: () => undefined,
          loadImage: unavailableImage,
          loadNoteEmbed,
        }),
      ],
    }),
    parent: host,
  });
  return { view, host };
}

describe("Live Preview async ownership", () => {
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
    view.destroy();
    host.remove();
  });
});
