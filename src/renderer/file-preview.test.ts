// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { VaultFilePreviewResponse } from "../shared/contracts";
import { FilePreviewController } from "./file-preview";

function dialogFixture(): HTMLDialogElement {
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `
    <button id="file-preview-close" type="button">Close</button>
    <strong id="file-preview-title"></strong>
    <span id="file-preview-path"></span>
    <span id="file-preview-kind"></span>
    <span id="file-preview-mime"></span>
    <span id="file-preview-size"></span>
    <span id="file-preview-revision"></span>
    <section id="file-preview-body">
      <img id="file-preview-image" hidden>
      <textarea id="file-preview-text" readonly hidden></textarea>
      <p id="file-preview-metadata" hidden></p>
    </section>
    <span id="file-preview-status"></span>
  `;
  dialog.showModal = vi.fn(() => dialog.setAttribute("open", ""));
  dialog.close = vi.fn(() => dialog.removeAttribute("open"));
  document.body.append(dialog);
  return dialog;
}

type ReadyResponse = Extract<VaultFilePreviewResponse, { status: "ready" }>;
type TextResponse = Extract<ReadyResponse, { preview: "text" }>;
type ImageResponse = Extract<ReadyResponse, { preview: "image" }>;
type MetadataResponse = Extract<ReadyResponse, { preview: "metadata" }>;

function textReady(overrides: Partial<TextResponse> = {}): TextResponse {
  return {
    status: "ready",
    vaultId: "vault-a",
    path: "Files/example.txt",
    kind: "text",
    mimeType: "text/plain",
    preview: "text",
    size: 12,
    revision: "a".repeat(64),
    text: "hello",
    truncated: false,
    ...overrides,
  };
}

function imageReady(overrides: Partial<ImageResponse> = {}): ImageResponse {
  return {
    status: "ready",
    vaultId: "vault-a",
    path: "Files/pixel.bin",
    kind: "image",
    mimeType: "image/png",
    preview: "image",
    size: 1,
    revision: "b".repeat(64),
    base64: "AA==",
    ...overrides,
  };
}

function metadataReady(overrides: Partial<MetadataResponse> = {}): MetadataResponse {
  return {
    status: "ready",
    vaultId: "vault-a",
    path: "Files/report.bin",
    kind: "pdf",
    mimeType: "application/pdf",
    preview: "metadata",
    size: 12,
    revision: "c".repeat(64),
    ...overrides,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("FilePreviewController", () => {
  it("renders executable-looking input as inert text and restores focus on close", async () => {
    const dialog = dialogFixture();
    const invoker = document.createElement("button");
    document.body.prepend(invoker);
    invoker.focus();
    const hostile = '<script>globalThis.compromised = true</script><img src=x onerror="boom()">';
    const controller = new FilePreviewController(dialog, {
      context: () => ({ vaultId: "vault-a", inventoryGeneration: "files:1" }),
      load: async () =>
        textReady({ path: "Files/hostile.html", text: hostile, size: hostile.length }),
      setPluginSurfaceVisible: vi.fn(),
      report: vi.fn(),
    });

    await controller.show("Files/hostile.html", invoker);

    expect(dialog.open).toBe(true);
    expect(dialog.querySelector<HTMLTextAreaElement>("#file-preview-text")?.value).toBe(hostile);
    expect(dialog.querySelector("#file-preview-body")?.getAttribute("data-preview")).toBe("text");
    expect(dialog.querySelector("script")).toBeNull();
    expect(dialog.querySelector("iframe, object, video, audio")).toBeNull();

    dialog.querySelector<HTMLButtonElement>("#file-preview-close")?.click();
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(invoker);
  });

  it("restores focus by file identity when the invoking row was re-rendered", async () => {
    const dialog = dialogFixture();
    const invoker = document.createElement("button");
    invoker.dataset.treePath = "Files/example.txt";
    document.body.prepend(invoker);
    invoker.focus();
    let replacement: HTMLButtonElement | null = null;
    const controller = new FilePreviewController(dialog, {
      context: () => ({ vaultId: "vault-a", inventoryGeneration: "files:1" }),
      load: async () => textReady(),
      resolveRestoreFocus: (path) => (replacement?.dataset.treePath === path ? replacement : null),
      setPluginSurfaceVisible: vi.fn(),
      report: vi.fn(),
    });

    await controller.show("Files/example.txt", invoker);
    replacement = document.createElement("button");
    replacement.dataset.treePath = "Files/example.txt";
    invoker.replaceWith(replacement);
    dialog.querySelector<HTMLButtonElement>("#file-preview-close")?.click();

    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(replacement);
  });

  it("allows only recognized raster data URLs and keeps other formats metadata-only", async () => {
    const dialog = dialogFixture();
    let response: VaultFilePreviewResponse = imageReady();
    const controller = new FilePreviewController(dialog, {
      context: () => ({ vaultId: "vault-a", inventoryGeneration: "files:1" }),
      load: async () => response,
      setPluginSurfaceVisible: vi.fn(),
      report: vi.fn(),
    });

    await controller.show("Files/pixel.bin");
    const image = dialog.querySelector<HTMLImageElement>("#file-preview-image");
    expect(image?.hidden).toBe(false);
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,AA==");

    response = metadataReady();
    await controller.show("Files/report.bin");
    expect(image?.hidden).toBe(true);
    expect(image?.hasAttribute("src")).toBe(false);
    expect(dialog.querySelector("#file-preview-metadata")?.textContent).toContain("metadata-only");
  });

  it("drops late responses and closes when the inventory identity changes", async () => {
    const dialog = dialogFixture();
    let generation = "files:1";
    const resolvers = new Map<string, (response: VaultFilePreviewResponse) => void>();
    const reports: string[] = [];
    const controller = new FilePreviewController(dialog, {
      context: () => ({ vaultId: "vault-a", inventoryGeneration: generation }),
      load: (path) =>
        new Promise<VaultFilePreviewResponse>((resolve) => {
          resolvers.set(path, resolve);
        }),
      setPluginSurfaceVisible: vi.fn(),
      report: (message) => reports.push(message),
    });

    const first = controller.show("Files/first.txt");
    const second = controller.show("Files/second.txt");
    resolvers.get("Files/second.txt")?.(textReady({ path: "Files/second.txt", text: "second" }));
    await second;
    resolvers.get("Files/first.txt")?.(textReady({ path: "Files/first.txt", text: "first" }));
    await first;
    expect(dialog.querySelector("#file-preview-path")?.textContent).toBe("Files/second.txt");
    expect(dialog.querySelector<HTMLTextAreaElement>("#file-preview-text")?.value).toBe("second");

    generation = "files:2";
    controller.onSnapshot({ vaultId: "vault-a", inventoryGeneration: generation });
    expect(dialog.open).toBe(false);
    expect(reports.at(-1)).toContain("visible file inventory changed");
  });
});
