import type { VaultFilePreviewResponse } from "../shared/contracts";

interface FilePreviewContext {
  vaultId: string;
  inventoryGeneration: string;
}

export interface FilePreviewControllerOptions {
  context(): FilePreviewContext | null;
  load(
    path: string,
    expectedVaultId: string,
    expectedInventoryGeneration: string,
  ): Promise<VaultFilePreviewResponse>;
  resolveRestoreFocus?(path: string): HTMLElement | null;
  setPluginSurfaceVisible(visible: boolean): void;
  report(message: string): void;
}

interface FilePreviewElements {
  close: HTMLButtonElement;
  title: HTMLElement;
  path: HTMLElement;
  kind: HTMLElement;
  mime: HTMLElement;
  size: HTMLElement;
  revision: HTMLElement;
  body: HTMLElement;
  image: HTMLImageElement;
  text: HTMLTextAreaElement;
  metadata: HTMLElement;
  status: HTMLElement;
}

const rasterMimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing file preview element: ${selector}`);
  return element;
}

function titleForPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) {
    return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`;
  }
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function kindLabel(kind: Extract<VaultFilePreviewResponse, { status: "ready" }>["kind"]): string {
  switch (kind) {
    case "image":
      return "Raster image";
    case "pdf":
      return "PDF document";
    case "audio":
      return "Audio file";
    case "video":
      return "Video file";
    case "document":
      return "Office or rich-text document";
    case "text":
      return "UTF-8 text";
    case "archive":
      return "Archive";
    case "unsupported":
      return "Unknown binary file";
  }
}

export class FilePreviewController {
  readonly #elements: FilePreviewElements;
  readonly #options: FilePreviewControllerOptions;
  #vaultId: string | null = null;
  #inventoryGeneration: string | null = null;
  #path: string | null = null;
  #requestSerial = 0;
  #restoreFocus: HTMLElement | null = null;

  constructor(
    readonly dialog: HTMLDialogElement,
    options: FilePreviewControllerOptions,
  ) {
    this.#options = options;
    this.#elements = {
      close: requireElement(dialog, "#file-preview-close"),
      title: requireElement(dialog, "#file-preview-title"),
      path: requireElement(dialog, "#file-preview-path"),
      kind: requireElement(dialog, "#file-preview-kind"),
      mime: requireElement(dialog, "#file-preview-mime"),
      size: requireElement(dialog, "#file-preview-size"),
      revision: requireElement(dialog, "#file-preview-revision"),
      body: requireElement(dialog, "#file-preview-body"),
      image: requireElement(dialog, "#file-preview-image"),
      text: requireElement(dialog, "#file-preview-text"),
      metadata: requireElement(dialog, "#file-preview-metadata"),
      status: requireElement(dialog, "#file-preview-status"),
    };
    this.#bindEvents();
  }

  get open(): boolean {
    return this.dialog.open;
  }

  async show(path: string, restoreFocus?: HTMLElement | null): Promise<void> {
    const context = this.#options.context();
    if (!context) {
      this.#options.report("Open a vault before previewing a file.");
      return;
    }
    const serial = ++this.#requestSerial;
    this.#vaultId = context.vaultId;
    this.#inventoryGeneration = context.inventoryGeneration;
    this.#path = path;
    this.#restoreFocus =
      restoreFocus ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    this.#renderLoading(path);
    if (!this.dialog.open) {
      this.#options.setPluginSurfaceVisible(false);
      this.dialog.showModal();
    }
    window.requestAnimationFrame(() => this.#elements.close.focus());

    try {
      const response = await this.#options.load(path, context.vaultId, context.inventoryGeneration);
      if (!this.#responseIsCurrent(serial, path, context)) return;
      if (response.status === "stale-vault") {
        this.close(false);
        this.#options.report("File preview closed because the active vault changed.");
        return;
      }
      if (response.status === "unavailable") {
        this.#renderUnavailable(response);
        return;
      }
      this.#renderReady(response);
    } catch (error) {
      if (!this.#responseIsCurrent(serial, path, context)) return;
      this.#renderUnavailable({
        status: "unavailable",
        vaultId: context.vaultId,
        reason: "unreadable",
        message: error instanceof Error ? error.message : String(error),
        path,
      });
    }
  }

  close(restoreFocus = true): void {
    if (!this.dialog.open) return;
    this.#requestSerial += 1;
    this.#elements.image.removeAttribute("src");
    this.dialog.close();
    this.#options.setPluginSurfaceVisible(true);
    const target = this.#restoreFocus;
    const previewPath = this.#path;
    this.#restoreFocus = null;
    this.#vaultId = null;
    this.#inventoryGeneration = null;
    this.#path = null;
    if (restoreFocus) {
      const currentTarget = target?.isConnected
        ? target
        : previewPath
          ? this.#options.resolveRestoreFocus?.(previewPath)
          : null;
      currentTarget?.focus();
    }
  }

  onSnapshot(context: FilePreviewContext | null): void {
    if (!this.dialog.open) return;
    if (
      !context ||
      context.vaultId !== this.#vaultId ||
      context.inventoryGeneration !== this.#inventoryGeneration
    ) {
      this.close(false);
      this.#options.report("File preview closed because the visible file inventory changed.");
    }
  }

  destroy(): void {
    this.#requestSerial += 1;
    this.#elements.image.removeAttribute("src");
  }

  #bindEvents(): void {
    this.#elements.close.addEventListener("click", () => this.close());
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.dialog.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        this.close();
      },
      { capture: true },
    );
  }

  #responseIsCurrent(serial: number, path: string, context: FilePreviewContext): boolean {
    const current = this.#options.context();
    return (
      serial === this.#requestSerial &&
      this.dialog.open &&
      path === this.#path &&
      context.vaultId === this.#vaultId &&
      context.inventoryGeneration === this.#inventoryGeneration &&
      current?.vaultId === context.vaultId &&
      current.inventoryGeneration === context.inventoryGeneration
    );
  }

  #resetPreviewContent(): void {
    this.#elements.image.hidden = true;
    this.#elements.image.removeAttribute("src");
    this.#elements.image.alt = "";
    this.#elements.text.hidden = true;
    this.#elements.text.value = "";
    this.#elements.metadata.hidden = true;
    this.#elements.metadata.textContent = "";
  }

  #renderLoading(path: string): void {
    this.#resetPreviewContent();
    this.#elements.title.textContent = titleForPath(path);
    this.#elements.path.textContent = path;
    this.#elements.kind.textContent = "Inspecting";
    this.#elements.mime.textContent = "Detecting from bounded bytes";
    this.#elements.size.textContent = "...";
    this.#elements.revision.textContent = "...";
    this.#elements.body.dataset.preview = "loading";
    this.#elements.metadata.hidden = false;
    this.#elements.metadata.textContent = "Reading a bounded, vault-contained snapshot...";
    this.#elements.status.dataset.state = "loading";
    this.#elements.status.textContent = "Inspecting file";
  }

  #renderUnavailable(response: Extract<VaultFilePreviewResponse, { status: "unavailable" }>): void {
    this.#resetPreviewContent();
    this.#elements.kind.textContent = "Preview unavailable";
    this.#elements.mime.textContent = "No content exposed";
    this.#elements.size.textContent =
      typeof response.size === "number" ? formatBytes(response.size) : "Unknown";
    this.#elements.revision.textContent = "Not loaded";
    this.#elements.body.dataset.preview = "unavailable";
    this.#elements.metadata.hidden = false;
    this.#elements.metadata.textContent = response.message;
    this.#elements.status.dataset.state = "unavailable";
    this.#elements.status.textContent = response.message;
  }

  #renderReady(response: Extract<VaultFilePreviewResponse, { status: "ready" }>): void {
    this.#resetPreviewContent();
    this.#elements.title.textContent = titleForPath(response.path);
    this.#elements.path.textContent = response.path;
    this.#elements.kind.textContent = kindLabel(response.kind);
    this.#elements.mime.textContent = response.mimeType ?? "Unknown MIME type";
    this.#elements.size.textContent = formatBytes(response.size);
    this.#elements.revision.textContent = response.revision.slice(0, 12);
    this.#elements.body.dataset.preview = response.preview;

    if (
      response.preview === "image" &&
      response.mimeType &&
      rasterMimeTypes.has(response.mimeType) &&
      typeof response.base64 === "string"
    ) {
      this.#elements.image.src = `data:${response.mimeType};base64,${response.base64}`;
      this.#elements.image.alt = `Preview of ${titleForPath(response.path)}`;
      this.#elements.image.hidden = false;
      this.#elements.status.dataset.state = "ready";
      this.#elements.status.textContent = "Read-only raster preview";
      return;
    }

    if (response.preview === "text" && typeof response.text === "string") {
      this.#elements.text.value = response.text;
      this.#elements.text.hidden = false;
      this.#elements.status.dataset.state = response.truncated ? "limited" : "ready";
      this.#elements.status.textContent = response.truncated
        ? "Read-only text preview, truncated at the 64 KiB display limit"
        : "Read-only text preview";
      return;
    }

    this.#elements.metadata.hidden = false;
    this.#elements.metadata.textContent = `${kindLabel(response.kind)} preview is metadata-only in this release.`;
    this.#elements.status.dataset.state = "ready";
    this.#elements.status.textContent = "Read-only metadata";
  }
}
