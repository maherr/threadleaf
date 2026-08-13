import type {
  NoteRestoreResponse,
  RuntimeSnapshot,
  VaultTrashEntry,
  VaultTrashResponse,
} from "../shared/contracts";

interface RecoveryContext {
  vaultId: string;
  vaultName: string;
  readOnly: boolean;
}

export interface RecoveryViewControllerOptions {
  context(): RecoveryContext | null;
  load(expectedVaultId: string): Promise<VaultTrashResponse>;
  restore(
    path: string,
    expectedRevision: string,
    expectedVaultId: string,
  ): Promise<NoteRestoreResponse>;
  renderSnapshot(snapshot: RuntimeSnapshot): void;
  setPluginSurfaceVisible(visible: boolean): void;
  report(message: string): void;
}

interface RecoveryElements {
  close: HTMLButtonElement;
  search: HTMLInputElement;
  refresh: HTMLButtonElement;
  count: HTMLElement;
  list: HTMLElement;
  empty: HTMLElement;
  error: HTMLElement;
  status: HTMLElement;
  vault: HTMLElement;
}

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing file recovery element: ${selector}`);
  }
  return element;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_024 * 1_024) {
    return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`;
  }
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function normalizedSearch(value: string): string[] {
  return value.normalize("NFC").toLocaleLowerCase("en-US").trim().split(/\s+/u).filter(Boolean);
}

function matchesSearch(entry: VaultTrashEntry, terms: readonly string[]): boolean {
  const searchable = `${entry.path} ${entry.trashPath}`.normalize("NFC").toLocaleLowerCase("en-US");
  return terms.every((term) => searchable.includes(term));
}

export class RecoveryViewController {
  readonly #elements: RecoveryElements;
  readonly #options: RecoveryViewControllerOptions;
  #vaultId: string | null = null;
  #entries: VaultTrashEntry[] = [];
  #total = 0;
  #truncated = false;
  #requestSerial = 0;
  #busyPath: string | null = null;
  #restoreFocus: HTMLElement | null = null;

  constructor(
    readonly dialog: HTMLDialogElement,
    options: RecoveryViewControllerOptions,
  ) {
    this.#options = options;
    this.#elements = {
      close: requireElement(dialog, "#recovery-close"),
      search: requireElement(dialog, "#recovery-search"),
      refresh: requireElement(dialog, "#recovery-refresh"),
      count: requireElement(dialog, "#recovery-entry-count"),
      list: requireElement(dialog, "#recovery-list"),
      empty: requireElement(dialog, "#recovery-empty"),
      error: requireElement(dialog, "#recovery-error"),
      status: requireElement(dialog, "#recovery-status"),
      vault: requireElement(dialog, "#recovery-vault"),
    };
    this.#bindEvents();
  }

  get open(): boolean {
    return this.dialog.open;
  }

  async show(): Promise<void> {
    const context = this.#options.context();
    if (!context) {
      this.#options.report("Open a vault before opening file recovery.");
      return;
    }
    if (context.readOnly) {
      this.#options.report("Open a writable local vault before restoring notes.");
      return;
    }
    this.#vaultId = context.vaultId;
    this.#entries = [];
    this.#total = 0;
    this.#truncated = false;
    this.#busyPath = null;
    this.#elements.search.value = "";
    this.#elements.error.textContent = "";
    this.#elements.vault.textContent = context.vaultName;
    this.#restoreFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!this.dialog.open) {
      this.#options.setPluginSurfaceVisible(false);
      this.dialog.showModal();
    }
    this.#render();
    window.requestAnimationFrame(() => this.#elements.search.focus());
    await this.#refresh();
  }

  close(restoreFocus = true): void {
    if (!this.dialog.open || this.#busyPath) {
      return;
    }
    this.#requestSerial += 1;
    this.dialog.close();
    this.#options.setPluginSurfaceVisible(true);
    const target = this.#restoreFocus;
    this.#restoreFocus = null;
    if (restoreFocus && target?.isConnected) {
      target.focus();
    }
  }

  onSnapshot(context: RecoveryContext): void {
    if (!this.dialog.open) {
      return;
    }
    if (context.vaultId !== this.#vaultId || context.readOnly) {
      this.#busyPath = null;
      this.close(false);
      this.#options.report("File recovery closed because the active vault changed.");
    }
  }

  destroy(): void {
    this.#requestSerial += 1;
  }

  #bindEvents(): void {
    this.#elements.close.addEventListener("click", () => this.close());
    this.#elements.search.addEventListener("input", () => this.#render());
    this.#elements.refresh.addEventListener("click", () => void this.#refresh());
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.dialog.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.close();
      },
      { capture: true },
    );
  }

  async #refresh(): Promise<void> {
    const context = this.#options.context();
    if (!context || !this.dialog.open || context.vaultId !== this.#vaultId || this.#busyPath) {
      return;
    }
    const serial = ++this.#requestSerial;
    this.#elements.error.textContent = "";
    this.#elements.status.dataset.state = "loading";
    this.#elements.status.textContent = "Inspecting recoverable trash...";
    this.#setControlsDisabled(true);
    try {
      const response = await this.#options.load(context.vaultId);
      if (serial !== this.#requestSerial || !this.dialog.open) {
        return;
      }
      if (response.status === "stale-vault") {
        this.close(false);
        this.#options.report("File recovery closed because the active vault changed.");
        return;
      }
      this.#entries = [...response.entries].sort((left, right) =>
        left.path.localeCompare(right.path, "en-US"),
      );
      this.#total = response.total;
      this.#truncated = response.truncated;
      this.#elements.status.dataset.state = response.truncated ? "limited" : "ready";
      this.#elements.status.textContent = response.truncated
        ? `Showing ${response.entries.length} of ${response.total} recoverable notes.`
        : `${response.total} recoverable note${response.total === 1 ? "" : "s"}.`;
    } catch (error) {
      if (serial !== this.#requestSerial) {
        return;
      }
      this.#entries = [];
      this.#total = 0;
      this.#truncated = false;
      this.#elements.status.dataset.state = "error";
      this.#elements.status.textContent = "File recovery could not inspect this vault.";
      this.#elements.error.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      if (serial === this.#requestSerial) {
        this.#setControlsDisabled(false);
        this.#render();
      }
    }
  }

  #render(): void {
    const terms = normalizedSearch(this.#elements.search.value);
    const visible = this.#entries.filter((entry) => matchesSearch(entry, terms));
    const fragment = document.createDocumentFragment();
    for (const entry of visible) {
      const row = document.createElement("li");
      row.className = "recovery-row";
      row.dataset.path = entry.path;
      const mark = document.createElement("span");
      mark.className = "recovery-row-mark";
      mark.ariaHidden = "true";
      mark.textContent = "↶";
      const copy = document.createElement("span");
      copy.className = "recovery-row-copy";
      const title = document.createElement("strong");
      title.textContent = entry.path;
      const source = document.createElement("code");
      source.textContent = entry.trashPath;
      copy.append(title, source);
      const size = document.createElement("span");
      size.className = "recovery-row-size";
      size.textContent = formatBytes(entry.size);
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "recovery-restore-button";
      restore.dataset.recoveryPath = entry.path;
      restore.textContent = this.#busyPath === entry.path ? "Restoring..." : "Restore";
      restore.disabled = this.#busyPath !== null;
      restore.setAttribute("aria-label", `Restore ${entry.path} to its original path`);
      restore.addEventListener("click", () => void this.#restore(entry));
      row.append(mark, copy, size, restore);
      fragment.append(row);
    }
    this.#elements.list.replaceChildren(fragment);
    this.#elements.count.textContent =
      terms.length === 0 ? String(this.#total) : `${visible.length} / ${this.#total}`;
    this.#elements.empty.hidden = visible.length > 0;
    this.#elements.empty.textContent =
      this.#entries.length === 0
        ? "No recoverable notes are in this vault's .trash folder."
        : "No recoverable notes match this filter.";
    this.#elements.error.hidden = this.#elements.error.textContent.length === 0;
    this.#elements.list.setAttribute("aria-busy", String(this.#busyPath !== null));
    this.dialog.dataset.truncated = String(this.#truncated);
  }

  async #restore(entry: VaultTrashEntry): Promise<void> {
    const context = this.#options.context();
    if (!context || context.vaultId !== this.#vaultId || this.#busyPath) {
      return;
    }
    this.#busyPath = entry.path;
    this.#elements.error.textContent = "";
    this.#elements.status.dataset.state = "loading";
    this.#elements.status.textContent = `Restoring ${entry.path}...`;
    this.#setControlsDisabled(true);
    this.#render();
    let restored = false;
    let failureMessage: string | null = null;
    try {
      const response = await this.#options.restore(entry.path, entry.revision, context.vaultId);
      this.#options.renderSnapshot(response.snapshot);
      if (response.outcome.status === "committed") {
        restored = true;
        this.#options.report(`Restored ${response.outcome.to}`);
      } else if (response.outcome.reason === "target-exists") {
        failureMessage = `${entry.path} already exists. Threadleaf kept both the live note and recovery entry unchanged.`;
      } else if (response.outcome.reason === "source-revision-changed") {
        failureMessage =
          "This recovery entry changed after it was listed. Threadleaf changed no files; review the refreshed entry.";
      } else {
        failureMessage = `Restore did not commit (${response.outcome.reason}). Threadleaf changed no files.`;
      }
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error);
    } finally {
      this.#busyPath = null;
      this.#setControlsDisabled(false);
      this.#render();
    }
    await this.#refresh();
    if (!restored && failureMessage) {
      this.#elements.error.textContent = failureMessage;
      this.#render();
      this.#elements.error.focus();
    }
  }

  #setControlsDisabled(disabled: boolean): void {
    this.#elements.close.disabled = disabled;
    this.#elements.search.disabled = disabled;
    this.#elements.refresh.disabled = disabled;
    for (const button of this.#elements.list.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = disabled;
    }
  }
}
