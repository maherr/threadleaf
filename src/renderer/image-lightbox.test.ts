import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { ImageLightbox } from "./image-lightbox";

function fixture() {
  const dom = new JSDOM(`<!doctype html><body><main>
    <img class="preview-local-image" src="data:image/png;base64,AA==" data-threadleaf-asset-path="images/one.png" alt="One">
    <img class="preview-local-image" src="data:image/png;base64,AQ==" data-threadleaf-asset-path="images/two.png" alt="Two">
  </main></body>`);
  const document = dom.window.document;
  const proto = dom.window.HTMLDialogElement.prototype as HTMLDialogElement & {
    showModal?: () => void;
    close?: () => void;
  };
  proto.showModal = function showModal() {
    this.setAttribute("open", "");
  };
  proto.close = function close() {
    this.removeAttribute("open");
  };
  const root = document.querySelector("main") as HTMLElement;
  const viewer = new ImageLightbox(document);
  viewer.bind(root);
  return { dom, root, viewer, images: [...root.querySelectorAll("img")] };
}

describe("ImageLightbox", () => {
  it("opens from keyboard, navigates the note image set, zooms, resets, and restores focus", () => {
    const { dom, viewer, images } = fixture();
    images[0]?.focus();
    images[0]?.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(viewer.dialog.open).toBe(true);
    expect(viewer.title.textContent).toBe("one.png");
    expect(viewer.counter.textContent).toBe("1 of 2");

    viewer.dialog.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(viewer.title.textContent).toBe("two.png");
    viewer.dialog.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "+", bubbles: true }),
    );
    expect(viewer.zoomValue.value).toBe("125%");
    viewer.dialog.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "0", bubbles: true }),
    );
    expect(viewer.zoomValue.value).toBe("100%");

    viewer.close();
    expect(viewer.dialog.open).toBe(false);
    expect(dom.window.document.activeElement).toBe(images[0]);
  });

  it("makes hydrated images discoverable without binding twice", () => {
    const { root, viewer, images } = fixture();
    viewer.bind(root);
    expect(images[0]?.tabIndex).toBe(0);
    expect(images[0]?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(images[0]?.getAttribute("aria-label")).toContain("one.png");
  });
});
