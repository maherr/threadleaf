// @vitest-environment jsdom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { createLivePreviewExtension } from "./live-preview";

function editorFor(source: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({
    state: EditorState.create({
      doc: `${source}\n\n`,
      selection: { anchor: source.length + 2 },
      extensions: [
        markdown({ base: markdownLanguage }),
        createLivePreviewExtension({
          sourceNotePath: () => "Note.md",
          expectedVaultId: () => "vault-a",
          activateLink: () => undefined,
          activateTag: () => undefined,
          loadImage: async () => ({
            status: "unavailable",
            vaultId: "vault-a",
            reason: "missing",
            message: "No image fixture was provided.",
          }),
          loadNoteEmbed: async () => {
            throw new Error("The callout fixtures do not contain note embeds.");
          },
        }),
      ],
    }),
    parent: host,
  });
  if (!forceParsing(view, view.state.doc.length, 1_000)) {
    throw new Error("The callout fixture did not finish parsing within its explicit bound.");
  }
  return { view, host };
}

function calloutWidgets(host: HTMLElement): Element[] {
  return [...host.querySelectorAll(".callout")];
}

describe("Live Preview callout replacement", () => {
  it("replaces an inactive callout with a plain body", () => {
    const { view, host } = editorFor("intro\n\n> [!note] Title\n> plain body\n\nafter");
    const rendered = calloutWidgets(host);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.getAttribute("data-callout")).toBe("note");
    view.destroy();
  });

  it("replaces an inactive callout whose body contains an inline code span", () => {
    const { view, host } = editorFor("intro\n\n> [!note] Title\n> body with `code` span\n\nafter");
    const rendered = calloutWidgets(host);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.getAttribute("data-callout")).toBe("note");
    view.destroy();
  });

  it("replaces an inactive callout whose body contains a fenced code block", () => {
    const { view, host } = editorFor(
      "intro\n\n> [!note] Title\n> ```js\n> const x = 1;\n> ```\n\nafter",
    );
    expect(calloutWidgets(host)).toHaveLength(1);
    view.destroy();
  });

  it("replaces an inactive callout whose body contains inline HTML", () => {
    const { view, host } = editorFor(
      "intro\n\n> [!note] Title\n> body <em>html</em> tail\n\nafter",
    );
    expect(calloutWidgets(host)).toHaveLength(1);
    view.destroy();
  });

  it("renders no callout widgets while frontmatter is unresolved", () => {
    const { view, host } = editorFor("---\ntitle: unterminated\n\n> [!note] Below\n> body\n\ntail");
    expect(calloutWidgets(host)).toHaveLength(0);
    view.destroy();
  });

  it("does not replace a quote-shaped line inside resolved frontmatter", () => {
    const { view, host } = editorFor("---\ntitle: x\n> [!note] inside yaml\n---\n\ntail");
    expect(calloutWidgets(host)).toHaveLength(0);
    view.destroy();
  });

  it("still replaces a callout after resolved frontmatter", () => {
    const { view, host } = editorFor("---\ntitle: x\n---\n\n> [!tip] After\n> body\n\ntail");
    const rendered = calloutWidgets(host);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.getAttribute("data-callout")).toBe("tip");
    view.destroy();
  });

  for (const key of ["Enter", " "]) {
    it(`reveals exact callout source from ${key === " " ? "Space" : key}`, () => {
      const { view, host } = editorFor("intro\n\n> [!note] Title\n> body\n\nafter");
      const frame = host.querySelector<HTMLElement>(".tl-live-callout-block");
      expect(frame).not.toBeNull();
      expect(frame?.tabIndex).toBe(0);
      expect(frame?.getAttribute("role")).toBe("group");
      expect(frame?.getAttribute("aria-label")).toContain("Note callout");
      expect(frame?.getAttribute("aria-keyshortcuts")).toBe("Enter Space");
      const sourceFrom = Number(frame?.dataset.tlSourceFrom);
      expect(Number.isInteger(sourceFrom)).toBe(true);

      frame?.focus();
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key });
      frame?.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(view.state.selection.main.anchor).toBe(sourceFrom);
      view.destroy();
    });
  }

  it("keeps task checkboxes inside a rendered callout inert until the source is revealed", () => {
    const { view, host } = editorFor("intro\n\n> [!todo] List\n> - [ ] task in callout\n\nafter");
    const rendered = calloutWidgets(host);
    expect(rendered).toHaveLength(1);
    const checkbox = host.querySelector(
      ".callout input.task-list-item-checkbox",
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    checkbox?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(checkbox?.checked).toBe(false);
    view.destroy();
  });
});
