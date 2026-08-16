// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CanvasAttachmentResponse,
  CanvasSaveResponse,
  WorkspaceCanvasSnapshot,
} from "../shared/contracts";
import { CanvasViewController } from "./canvas-view";

const path = "Boards/Overview.canvas";

function canvasSnapshot(overrides: Partial<WorkspaceCanvasSnapshot> = {}): WorkspaceCanvasSnapshot {
  return {
    path,
    title: "Overview",
    revision: "a".repeat(64),
    document: {
      futureDocumentField: { keep: true },
      nodes: [
        {
          id: "welcome",
          type: "text",
          x: 80,
          y: 80,
          width: 260,
          height: 120,
          text: "Welcome",
          futureNodeField: ["keep"],
        },
      ],
      edges: [],
    },
    diagnostics: [],
    readOnly: false,
    ...overrides,
  };
}

function response(outcome: CanvasSaveResponse["outcome"]): CanvasSaveResponse {
  return { outcome, snapshot: {} as CanvasSaveResponse["snapshot"] };
}

function control(root: HTMLElement, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!match) throw new Error(`Missing Canvas control: ${label}`);
  return match;
}

const missingAttachment = async (): Promise<CanvasAttachmentResponse> => ({
  status: "unavailable",
  vaultId: "vault-a",
  reason: "missing",
  message: "Fixture attachment is absent.",
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("CanvasViewController", () => {
  it("ends a committed mutation in a clean saved state without dropping unknown fields", async () => {
    const root = document.createElement("section");
    document.body.append(root);
    let savedContent = "";
    const controller = new CanvasViewController(root, {
      openPath: () => undefined,
      loadAttachment: missingAttachment,
      save: async (savedPath, content, revision) => {
        expect(savedPath).toBe(path);
        expect(revision).toBe("a".repeat(64));
        savedContent = content;
        return response({
          status: "committed",
          path,
          revision: "b".repeat(64),
          transactionId: "canvas-save",
        });
      },
    });

    controller.render(canvasSnapshot());
    const save = control(root, "Save");
    expect(save.disabled).toBe(true);
    control(root, "Add group").click();
    expect(root.querySelector(".canvas-status")?.textContent).toBe("Unsaved changes");
    expect(save.disabled).toBe(false);

    save.click();
    await vi.waitFor(() => expect(root.querySelector(".canvas-status")?.textContent).toBe("Saved"));

    expect(save.disabled).toBe(true);
    const persisted = JSON.parse(savedContent) as {
      futureDocumentField?: unknown;
      nodes?: Array<Record<string, unknown>>;
    };
    expect(persisted.futureDocumentField).toEqual({ keep: true });
    expect(persisted.nodes?.find((node) => node.id === "welcome")?.futureNodeField).toEqual([
      "keep",
    ]);
    expect(persisted.nodes?.some((node) => node.type === "group")).toBe(true);
  });

  it("keeps a dirty model across an external snapshot and preserves it as a conflict", async () => {
    const root = document.createElement("section");
    document.body.append(root);
    let savedContent = "";
    const controller = new CanvasViewController(root, {
      openPath: () => undefined,
      loadAttachment: missingAttachment,
      save: async (_savedPath, content) => {
        savedContent = content;
        return response({
          status: "conflict",
          path,
          currentRevision: "b".repeat(64),
          conflictPath: "Boards/Overview.threadleaf-conflict-fixture.canvas",
          transactionId: "canvas-conflict",
        });
      },
    });

    controller.render(canvasSnapshot());
    const editor = root.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Text for welcome"]',
    );
    if (!editor) throw new Error("Missing Canvas text editor.");
    editor.value = "Local proposal";
    editor.dispatchEvent(new Event("change", { bubbles: true }));

    controller.render(
      canvasSnapshot({
        revision: "b".repeat(64),
        document: {
          nodes: [
            {
              id: "welcome",
              type: "text",
              x: 80,
              y: 80,
              width: 260,
              height: 120,
              text: "External version",
            },
          ],
          edges: [],
        },
      }),
    );
    expect(editor.value).toBe("Local proposal");

    control(root, "Save").click();
    await vi.waitFor(() =>
      expect(root.querySelector(".canvas-status")?.textContent).toContain(
        "Overview.threadleaf-conflict-fixture.canvas",
      ),
    );
    expect(savedContent).toContain("Local proposal");
    expect(savedContent).not.toContain("External version");
  });
});
