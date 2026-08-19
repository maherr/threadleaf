const minimumScale = 0.25;
const maximumScale = 8;

function clampScale(value: number): number {
  return Math.min(maximumScale, Math.max(minimumScale, value));
}

function imagePath(image: HTMLImageElement): string {
  return image.dataset.threadleafAssetPath || image.alt || "Image";
}

function imageName(image: HTMLImageElement): string {
  const path = imagePath(image).replaceAll("\\", "/");
  return path.split("/").at(-1) || path;
}

export class ImageLightbox {
  readonly dialog: HTMLDialogElement;
  readonly image: HTMLImageElement;
  readonly title: HTMLElement;
  readonly counter: HTMLElement;
  readonly zoomValue: HTMLOutputElement;
  readonly previous: HTMLButtonElement;
  readonly next: HTMLButtonElement;

  #images: HTMLImageElement[] = [];
  #index = 0;
  #scale = 1;
  #panX = 0;
  #panY = 0;
  #drag: { pointerId: number; x: number; y: number } | null = null;
  #restoreFocus: HTMLElement | null = null;
  #bound = new WeakSet<HTMLImageElement>();

  constructor(document: Document) {
    const dialog = document.createElement("dialog");
    dialog.className = "image-lightbox";
    dialog.dataset.imageLightbox = "true";
    dialog.setAttribute("aria-label", "Image viewer");
    dialog.innerHTML = `
      <div class="image-lightbox-shell">
        <header class="image-lightbox-header">
          <span class="image-lightbox-heading">
            <strong data-image-lightbox-title>Image</strong>
            <span data-image-lightbox-counter>1 of 1</span>
          </span>
          <span class="image-lightbox-controls" aria-label="Image zoom controls">
            <button type="button" data-image-lightbox-zoom-out aria-label="Zoom out">−</button>
            <button type="button" data-image-lightbox-reset aria-label="Reset image zoom">100%</button>
            <button type="button" data-image-lightbox-zoom-in aria-label="Zoom in">＋</button>
            <output data-image-lightbox-zoom aria-live="polite">100%</output>
          </span>
          <button class="image-lightbox-close" type="button" data-image-lightbox-close aria-label="Close image viewer">Close <kbd>Esc</kbd></button>
        </header>
        <div class="image-lightbox-stage" data-image-lightbox-stage>
          <button class="image-lightbox-nav image-lightbox-previous" type="button" data-image-lightbox-previous aria-label="Previous image">‹</button>
          <img data-image-lightbox-image alt="">
          <button class="image-lightbox-nav image-lightbox-next" type="button" data-image-lightbox-next aria-label="Next image">›</button>
        </div>
        <footer class="image-lightbox-footer">
          <span>Arrow keys change image</span>
          <span>＋ / − zoom</span>
          <span>0 resets</span>
          <span>Drag to pan</span>
        </footer>
      </div>`;
    document.body.append(dialog);
    this.dialog = dialog;
    this.image = dialog.querySelector("[data-image-lightbox-image]") as HTMLImageElement;
    this.title = dialog.querySelector("[data-image-lightbox-title]") as HTMLElement;
    this.counter = dialog.querySelector("[data-image-lightbox-counter]") as HTMLElement;
    this.zoomValue = dialog.querySelector("[data-image-lightbox-zoom]") as HTMLOutputElement;
    this.previous = dialog.querySelector("[data-image-lightbox-previous]") as HTMLButtonElement;
    this.next = dialog.querySelector("[data-image-lightbox-next]") as HTMLButtonElement;

    dialog
      .querySelector("[data-image-lightbox-close]")
      ?.addEventListener("click", () => this.close());
    dialog
      .querySelector("[data-image-lightbox-zoom-out]")
      ?.addEventListener("click", () => this.zoomBy(1 / 1.25));
    dialog
      .querySelector("[data-image-lightbox-zoom-in]")
      ?.addEventListener("click", () => this.zoomBy(1.25));
    dialog
      .querySelector("[data-image-lightbox-reset]")
      ?.addEventListener("click", () => this.resetTransform());
    this.previous.addEventListener("click", () => this.move(-1));
    this.next.addEventListener("click", () => this.move(1));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    dialog.addEventListener("keydown", (event) => this.onKeyDown(event));
    const stage = dialog.querySelector("[data-image-lightbox-stage]") as HTMLElement;
    stage.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15);
    });
    this.image.addEventListener("pointerdown", (event) => this.beginPan(event));
    this.image.addEventListener("pointermove", (event) => this.pan(event));
    this.image.addEventListener("pointerup", (event) => this.endPan(event));
    this.image.addEventListener("pointercancel", (event) => this.endPan(event));
  }

  bind(root: HTMLElement): void {
    for (const image of root.querySelectorAll<HTMLImageElement>("img.preview-local-image")) {
      if (this.#bound.has(image)) continue;
      this.#bound.add(image);
      image.tabIndex = 0;
      image.classList.add("preview-lightbox-trigger");
      image.setAttribute("aria-haspopup", "dialog");
      image.setAttribute("aria-label", `Open ${imageName(image)} in image viewer`);
      image.addEventListener("click", () => this.open(root, image));
      image.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        this.open(root, image);
      });
    }
  }

  open(root: HTMLElement, selected: HTMLImageElement): void {
    this.#images = [...root.querySelectorAll<HTMLImageElement>("img.preview-local-image")].filter(
      (image) => Boolean(image.src) && !image.hidden,
    );
    const selectedIndex = this.#images.indexOf(selected);
    if (selectedIndex < 0) return;
    this.#index = selectedIndex;
    this.#restoreFocus = selected;
    this.renderImage();
    if (!this.dialog.open) this.dialog.showModal();
    (this.dialog.querySelector("[data-image-lightbox-close]") as HTMLButtonElement).focus();
  }

  close(): void {
    if (this.dialog.open) this.dialog.close();
    const restore = this.#restoreFocus;
    this.#restoreFocus = null;
    this.#images = [];
    restore?.focus();
  }

  move(direction: -1 | 1): void {
    if (this.#images.length < 2) return;
    this.#index = (this.#index + direction + this.#images.length) % this.#images.length;
    this.renderImage();
  }

  zoomBy(factor: number): void {
    this.#scale = clampScale(this.#scale * factor);
    if (this.#scale <= 1) {
      this.#panX = 0;
      this.#panY = 0;
    }
    this.applyTransform();
  }

  resetTransform(): void {
    this.#scale = 1;
    this.#panX = 0;
    this.#panY = 0;
    this.applyTransform();
  }

  private renderImage(): void {
    const source = this.#images[this.#index];
    if (!source) return;
    this.image.src = source.src;
    this.image.alt = source.alt || imageName(source);
    this.title.textContent = imageName(source);
    this.counter.textContent = `${this.#index + 1} of ${this.#images.length}`;
    this.previous.disabled = this.#images.length < 2;
    this.next.disabled = this.#images.length < 2;
    this.resetTransform();
  }

  private applyTransform(): void {
    this.image.style.transform = `translate(${this.#panX}px, ${this.#panY}px) scale(${this.#scale})`;
    this.image.dataset.zoomed = String(this.#scale > 1);
    this.zoomValue.value = `${Math.round(this.#scale * 100)}%`;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      this.move(event.key === "ArrowLeft" ? -1 : 1);
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      this.zoomBy(1.25);
    } else if (event.key === "-") {
      event.preventDefault();
      this.zoomBy(1 / 1.25);
    } else if (event.key === "0") {
      event.preventDefault();
      this.resetTransform();
    }
  }

  private beginPan(event: PointerEvent): void {
    if (this.#scale <= 1) return;
    this.#drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    this.image.setPointerCapture?.(event.pointerId);
  }

  private pan(event: PointerEvent): void {
    if (!this.#drag || this.#drag.pointerId !== event.pointerId) return;
    this.#panX += event.clientX - this.#drag.x;
    this.#panY += event.clientY - this.#drag.y;
    this.#drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    this.applyTransform();
  }

  private endPan(event: PointerEvent): void {
    if (this.#drag?.pointerId !== event.pointerId) return;
    this.#drag = null;
    this.image.releasePointerCapture?.(event.pointerId);
  }
}
