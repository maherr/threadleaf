// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type {
  CanvasLoadResponse,
  VaultImageResponse,
  VaultNoteEmbedResponse,
} from "../shared/contracts";
import { hydrateMarkdownPreview, renderMarkdownPreview } from "./markdown-preview";

const noImages = async (): Promise<VaultImageResponse> => ({
  status: "unavailable",
  vaultId: "vault-a",
  reason: "missing",
  message: "No image fixture was provided.",
});

const noNotes = async (): Promise<VaultNoteEmbedResponse> => ({
  status: "unavailable",
  vaultId: "vault-a",
  reason: "missing",
  message: "No note fixture was provided.",
});

function readyCanvas(path: string): CanvasLoadResponse {
  return {
    status: "ready",
    vaultId: "vault-a",
    canvas: {
      path,
      title:
        path
          .split("/")
          .at(-1)
          ?.replace(/\.canvas$/u, "") ?? path,
      revision: "c".repeat(64),
      document: {
        nodes: [
          {
            id: "text",
            type: "text",
            x: 0,
            y: 0,
            width: 100,
            height: 80,
            text: "Canvas body",
          },
          {
            id: "link",
            type: "link",
            x: 0,
            y: 100,
            width: 100,
            height: 80,
            url: "https://example.test/inactive",
          },
        ],
        edges: [],
      },
      diagnostics: [],
      readOnly: false,
    },
  };
}

describe("Markdown canvas embeds", () => {
  it("hydrates a bounded Canvas embed with inert content and an open control", async () => {
    const root = document.createElement("div");
    root.append(renderMarkdownPreview("![[Boards/Overview.canvas|Overview board]]"));
    const requests: string[][] = [];

    await hydrateMarkdownPreview(root, {
      sourceNotePath: "Notes/Current.md",
      expectedVaultId: "vault-a",
      loadImage: noImages,
      loadNoteEmbed: noNotes,
      loadCanvas: async (path, vaultId) => {
        requests.push([path, vaultId]);
        return readyCanvas(path);
      },
      decorateLinks: () => undefined,
    });

    expect(requests).toEqual([["Boards/Overview.canvas", "vault-a"]]);
    expect(root.querySelector(".preview-canvas-embed-open")?.textContent).toBe(
      "Boards/Overview.canvas",
    );
    expect(root.querySelectorAll(".preview-canvas-embed-objects li")).toHaveLength(2);
    expect(root.textContent).toContain("External link (inactive)");
    expect(root.querySelector("a[href^='https://']")).toBeNull();
  });

  it("keeps stale Canvas responses explicit", async () => {
    const root = document.createElement("div");
    root.append(renderMarkdownPreview("![[Board.canvas]]"));
    await hydrateMarkdownPreview(root, {
      sourceNotePath: "Current.md",
      expectedVaultId: "vault-a",
      loadImage: noImages,
      loadNoteEmbed: noNotes,
      loadCanvas: async () => ({ status: "stale-vault", vaultId: "vault-b" }),
      decorateLinks: () => undefined,
    });
    expect(root.querySelector(".preview-canvas-embed-unavailable")?.textContent).toContain(
      "active vault changed",
    );
  });
});
