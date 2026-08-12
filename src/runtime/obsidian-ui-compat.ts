import type { App, Plugin, TFile } from "./obsidian-compat";
import { BaseComponent, Component } from "./obsidian-components";

function currentDocument(): Document {
  if (typeof document === "undefined") {
    throw new Error("Obsidian UI compatibility requires a renderer document.");
  }
  return document;
}

export interface Instruction {
  command: string;
  purpose: string;
}

export class Scope {
  readonly parent: Scope | null;

  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }
}

export class Modal {
  readonly app: App;
  readonly scope = new Scope();
  readonly containerEl: HTMLElement;
  readonly modalEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly contentEl: HTMLElement;
  shouldRestoreSelection = true;
  private openState = false;

  constructor(app: App) {
    this.app = app;
    const doc = currentDocument();
    this.containerEl = doc.createElement("div");
    this.containerEl.className = "modal-container mod-dim";
    this.modalEl = doc.createElement("div");
    this.modalEl.className = "modal";
    this.titleEl = doc.createElement("div");
    this.titleEl.className = "modal-title";
    this.contentEl = doc.createElement("div");
    this.contentEl.className = "modal-content";
    this.modalEl.append(this.titleEl, this.contentEl);
    this.containerEl.append(this.modalEl);
  }

  open(): void {
    if (this.openState) {
      return;
    }
    this.openState = true;
    currentDocument().body.append(this.containerEl);
    this.onOpen();
  }

  close(): void {
    if (!this.openState) {
      return;
    }
    this.openState = false;
    try {
      this.onClose();
    } finally {
      this.containerEl.remove();
    }
  }

  onOpen(): void {}

  onClose(): void {}

  setTitle(title: string): this {
    this.titleEl.textContent = title;
    return this;
  }

  setContent(content: string | DocumentFragment): this {
    if (typeof content === "string") {
      this.contentEl.textContent = content;
    } else {
      this.contentEl.replaceChildren(content);
    }
    return this;
  }
}

export class SuggestModal<T> extends Modal {
  limit = 100;
  emptyStateText = "No matches found.";
  readonly inputEl: HTMLInputElement;
  readonly resultContainerEl: HTMLElement;
  private instructions: Instruction[] = [];
  private suggestions: T[] = [];

  constructor(app: App) {
    super(app);
    const doc = this.contentEl.ownerDocument;
    this.inputEl = doc.createElement("input");
    this.inputEl.className = "prompt-input";
    this.resultContainerEl = doc.createElement("div");
    this.resultContainerEl.className = "suggestion-container";
    this.contentEl.append(this.inputEl, this.resultContainerEl);
    this.inputEl.addEventListener("input", () => void this.refreshSuggestions());
  }

  setPlaceholder(placeholder: string): void {
    this.inputEl.placeholder = placeholder;
  }

  setInstructions(instructions: Instruction[]): void {
    this.instructions = [...instructions];
  }

  onNoSuggestion(): void {
    const empty = this.resultContainerEl.ownerDocument.createElement("div");
    empty.className = "suggestion-empty";
    empty.textContent = this.emptyStateText;
    this.resultContainerEl.append(empty);
  }

  selectSuggestion(value: T, event: MouseEvent | KeyboardEvent): void {
    this.onChooseSuggestion(value, event);
    this.close();
  }

  selectActiveSuggestion(event: MouseEvent | KeyboardEvent): void {
    const first = this.suggestions[0];
    if (first !== undefined) {
      this.selectSuggestion(first, event);
    }
  }

  getSuggestions(_query: string): T[] | Promise<T[]> {
    return [];
  }

  renderSuggestion(value: T, element: HTMLElement): void {
    element.textContent = String(value);
  }

  onChooseSuggestion(_item: T, _event: MouseEvent | KeyboardEvent): void {}

  protected getInstructions(): Instruction[] {
    return [...this.instructions];
  }

  private async refreshSuggestions(): Promise<void> {
    const values = await this.getSuggestions(this.inputEl.value);
    this.suggestions = values.slice(0, this.limit);
    this.resultContainerEl.replaceChildren();
    if (this.suggestions.length === 0) {
      this.onNoSuggestion();
      return;
    }
    for (const suggestion of this.suggestions) {
      const element = this.resultContainerEl.ownerDocument.createElement("div");
      element.className = "suggestion-item";
      this.renderSuggestion(suggestion, element);
      element.addEventListener("click", (event) => this.selectSuggestion(suggestion, event));
      this.resultContainerEl.append(element);
    }
  }
}

export interface FuzzyMatch<T> {
  item: T;
  match: { score: number; matches: Array<[number, number]> };
}

export class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  getItems(): T[] {
    return [];
  }

  getItemText(item: T): string {
    return String(item);
  }

  onChooseItem(_item: T, _event: MouseEvent | KeyboardEvent): void {}

  override getSuggestions(query: string): FuzzyMatch<T>[] {
    const needle = query.trim().toLocaleLowerCase();
    return this.getItems()
      .map((item) => ({ item, text: this.getItemText(item) }))
      .filter(({ text }) => needle.length === 0 || text.toLocaleLowerCase().includes(needle))
      .slice(0, this.limit)
      .map(({ item, text }) => {
        const start = needle.length === 0 ? 0 : text.toLocaleLowerCase().indexOf(needle);
        return {
          item,
          match: {
            score: start < 0 ? 0 : 1 / (start + 1),
            matches: needle.length === 0 || start < 0 ? [] : [[start, start + needle.length]],
          },
        };
      });
  }

  override renderSuggestion(value: FuzzyMatch<T>, element: HTMLElement): void {
    element.textContent = this.getItemText(value.item);
  }

  override onChooseSuggestion(value: FuzzyMatch<T>, event: MouseEvent | KeyboardEvent): void {
    this.onChooseItem(value.item, event);
  }
}

export class EditorSuggest<T> {
  readonly app: App;
  readonly scope = new Scope();
  context: unknown | null = null;
  limit = 100;
  private instructions: Instruction[] = [];

  constructor(app: App) {
    this.app = app;
  }

  open(): void {}

  close(): void {
    this.context = null;
  }

  setInstructions(instructions: Instruction[]): void {
    this.instructions = [...instructions];
  }

  getInstructions(): Instruction[] {
    return [...this.instructions];
  }

  onTrigger(..._args: unknown[]): unknown | null {
    return null;
  }

  getSuggestions(..._args: unknown[]): T[] | Promise<T[]> {
    return [];
  }

  renderSuggestion(value: T, element: HTMLElement): void {
    element.textContent = String(value);
  }

  selectSuggestion(_value: T, _event: MouseEvent | KeyboardEvent): void {}
}

export class SettingTab {
  readonly app: App;
  readonly containerEl: HTMLElement;

  constructor(app: App) {
    this.app = app;
    this.containerEl = currentDocument().createElement("div");
    this.containerEl.className = "vertical-tab-content";
  }

  display(): void {}

  hide(): void {
    this.containerEl.replaceChildren();
  }
}

export class PluginSettingTab extends SettingTab {
  readonly plugin: Plugin;

  constructor(app: App, plugin: Plugin) {
    super(app);
    this.plugin = plugin;
  }
}

export class WorkspaceLeaf {
  readonly app: App;
  readonly containerEl: HTMLElement;
  view: View | null = null;

  constructor(app: App, containerEl?: HTMLElement) {
    this.app = app;
    this.containerEl = containerEl ?? currentDocument().createElement("div");
  }
}

export class View extends Component {
  readonly app: App;
  readonly leaf: WorkspaceLeaf;
  readonly containerEl: HTMLElement;
  icon = "document";
  navigation = false;
  scope: Scope | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = leaf.containerEl;
    leaf.view = this;
  }

  get ownerDocument(): Document {
    return this.containerEl.ownerDocument;
  }

  get ownerWindow(): Window {
    return this.ownerDocument.defaultView ?? window;
  }

  getViewType(): string {
    return "empty";
  }

  getDisplayText(): string {
    return "Untitled";
  }

  getState(): Record<string, unknown> {
    return {};
  }

  async setState(_state: unknown, _result: unknown): Promise<void> {}

  getEphemeralState(): Record<string, unknown> {
    return {};
  }

  setEphemeralState(_state: unknown): void {}

  getIcon(): string {
    return this.icon;
  }

  onResize(): void {}

  onPaneMenu(..._args: unknown[]): void {}
}

export class ItemView extends View {
  readonly contentEl: HTMLElement;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.contentEl = this.ownerDocument.createElement("div");
    this.contentEl.className = "view-content";
    this.containerEl.append(this.contentEl);
  }

  addAction(icon: string, title: string, callback: (event: MouseEvent) => unknown): HTMLElement {
    const action = this.ownerDocument.createElement("button");
    action.type = "button";
    action.className = "view-action clickable-icon";
    action.dataset.icon = icon;
    action.title = title;
    action.addEventListener("click", callback);
    this.containerEl.prepend(action);
    this.register(() => action.removeEventListener("click", callback));
    return action;
  }
}

export class FileView extends ItemView {
  allowNoFile = false;
  file: TFile | null = null;
  override navigation = true;

  override getDisplayText(): string {
    return this.file?.basename ?? "No file";
  }

  override getState(): Record<string, unknown> {
    return this.file ? { file: this.file.path } : {};
  }

  override async setState(state: unknown, _result: unknown): Promise<void> {
    if (!state || typeof state !== "object" || !("file" in state)) {
      return;
    }
    const filePath = state.file;
    this.file = typeof filePath === "string" ? this.app.createFile(filePath) : null;
  }

  async onLoadFile(_file: TFile): Promise<void> {}

  async onUnloadFile(_file: TFile): Promise<void> {}

  async onRename(_file: TFile): Promise<void> {}

  canAcceptExtension(_extension: string): boolean {
    return true;
  }
}

export class TextFileView extends FileView {
  data = "";
  requestSave = (): void => {};

  override async onLoadFile(file: TFile): Promise<void> {
    this.file = file;
    this.data = await this.app.vault.read(file);
    this.setViewData(this.data, true);
  }

  override async onUnloadFile(file: TFile): Promise<void> {
    await super.onUnloadFile(file);
    this.file = null;
  }

  async save(_clear?: boolean): Promise<void> {
    throw new Error("Plugin view saves are not available in the read-only compatibility runtime.");
  }

  getViewData(): string {
    return this.data;
  }

  setViewData(data: string, _clear: boolean): void {
    this.data = data;
  }

  clear(): void {
    this.data = "";
  }
}

export class MarkdownView extends TextFileView {
  override getViewType(): string {
    return "markdown";
  }
}

export { BaseComponent, Component };
