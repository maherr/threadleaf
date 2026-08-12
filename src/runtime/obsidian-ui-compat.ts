import type { App, Plugin, TFile } from "./obsidian-compat";
import { BaseComponent, Component } from "./obsidian-components";
import { createCompatibleIcon } from "./obsidian-icons";

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

interface ScopeKeyRegistration {
  func: (event: KeyboardEvent) => unknown;
  key: string;
  modifiers: string[];
}

export class Scope {
  readonly parent: Scope | null;
  readonly keys: ScopeKeyRegistration[] = [];

  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }

  register(
    modifiers: string[],
    key: string,
    func: (event: KeyboardEvent) => unknown,
  ): ScopeKeyRegistration {
    const registration = { func, key, modifiers: [...modifiers] };
    this.keys.push(registration);
    return registration;
  }

  unregister(registration: ScopeKeyRegistration): void {
    const index = this.keys.indexOf(registration);
    if (index >= 0) {
      this.keys.splice(index, 1);
    }
  }
}

export class Keymap {
  private readonly rootScope = new Scope();

  getRootScope(): Scope {
    return this.rootScope;
  }
}

export class Modal {
  readonly app: App;
  readonly scope = new Scope();
  readonly bgEl: HTMLElement;
  readonly containerEl: HTMLElement;
  readonly headerEl: HTMLElement;
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
    this.bgEl = doc.createElement("div");
    this.bgEl.className = "modal-bg";
    this.modalEl = doc.createElement("div");
    this.modalEl.className = "modal";
    this.headerEl = doc.createElement("div");
    this.headerEl.className = "modal-header";
    this.titleEl = doc.createElement("div");
    this.titleEl.className = "modal-title";
    this.contentEl = doc.createElement("div");
    this.contentEl.className = "modal-content";
    this.headerEl.append(this.titleEl);
    this.modalEl.append(this.headerEl, this.contentEl);
    this.containerEl.append(this.bgEl, this.modalEl);
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

  setDimBackground(dimmed: boolean): this {
    this.containerEl.classList.toggle("mod-dim", dimmed);
    return this;
  }

  setBackgroundOpacity(opacity: number): this {
    this.bgEl.style.opacity = String(Math.min(1, Math.max(0, opacity)));
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
  readonly id: string;
  readonly tabHeaderInnerIconEl: HTMLElement;
  readonly tabHeaderInnerTitleEl: HTMLElement;
  view: View | null = null;
  private readonly releaseWorkspaceRegistration: () => void;
  private viewState: { type: string; state: Record<string, unknown> } = {
    type: "empty",
    state: {},
  };

  private static nextId = 1;

  constructor(app: App, containerEl?: HTMLElement) {
    this.app = app;
    this.containerEl = containerEl ?? currentDocument().createElement("div");
    this.containerEl.classList.add("workspace-leaf");
    this.id = `threadleaf-leaf-${WorkspaceLeaf.nextId++}`;
    this.tabHeaderInnerIconEl = currentDocument().createElement("div");
    this.tabHeaderInnerIconEl.className = "workspace-tab-header-inner-icon";
    this.tabHeaderInnerTitleEl = currentDocument().createElement("div");
    this.tabHeaderInnerTitleEl.className = "workspace-tab-header-inner-title";
    this.releaseWorkspaceRegistration = app.workspace.registerLeaf(this);
  }

  getViewState(): { type: string; state: Record<string, unknown> } {
    return {
      type: this.viewState.type,
      state: structuredClone(this.viewState.state),
    };
  }

  async setViewState(
    viewState: { type: string; state?: Record<string, unknown> },
    result: Record<string, unknown> = {},
  ): Promise<void> {
    await this.releaseView();
    this.containerEl.replaceChildren();
    this.viewState = {
      type: viewState.type,
      state: structuredClone(viewState.state ?? {}),
    };
    if (viewState.type === "empty") {
      return;
    }
    const candidate = this.app.compatibility.createView(viewState.type, this);
    if (!(candidate instanceof View)) {
      throw new Error(`View creator did not return a View: ${viewState.type}`);
    }
    this.view = candidate;
    try {
      candidate.load();
      await candidate.setState(this.viewState.state, result);
      const displayText = candidate.getDisplayText();
      this.tabHeaderInnerTitleEl.textContent = displayText;
      if (candidate instanceof ItemView) {
        const filePath = candidate instanceof FileView ? candidate.file?.path : null;
        candidate.setHeaderTitle(filePath ?? displayText);
      }
      this.app.workspace.activeLeaf = this;
      this.app.workspace.trigger("active-leaf-change", this);
      this.app.workspace.trigger("layout-change");
    } catch (error) {
      await this.releaseView();
      throw error;
    }
  }

  async openFile(file: TFile): Promise<void> {
    const viewType =
      this.app.compatibility.getViewTypeForExtension(file.extension) ??
      this.view?.getViewType() ??
      "markdown";
    await this.setViewState({ type: viewType, state: { file: file.path } });
  }

  async rebuildView(): Promise<void> {
    await this.setViewState(this.getViewState());
  }

  async detach(): Promise<void> {
    await this.releaseView();
    this.releaseWorkspaceRegistration();
    this.containerEl.remove();
  }

  private async releaseView(): Promise<void> {
    const view = this.view;
    this.view = null;
    if (!view) {
      return;
    }
    if (view instanceof FileView && view.file) {
      await view.onUnloadFile(view.file);
    }
    view.unload();
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
  readonly viewActionsEl: HTMLElement;
  readonly viewHeaderEl: HTMLElement;
  readonly viewHeaderTitleEl: HTMLElement;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.viewHeaderEl = this.ownerDocument.createElement("div");
    this.viewHeaderEl.className = "view-header";
    const titleContainer = this.ownerDocument.createElement("div");
    titleContainer.className = "view-header-title-container";
    this.viewHeaderTitleEl = this.ownerDocument.createElement("div");
    this.viewHeaderTitleEl.className = "view-header-title";
    titleContainer.append(this.viewHeaderTitleEl);
    this.viewActionsEl = this.ownerDocument.createElement("div");
    this.viewActionsEl.className = "view-actions";
    this.viewHeaderEl.append(titleContainer, this.viewActionsEl);
    this.contentEl = this.ownerDocument.createElement("div");
    this.contentEl.className = "view-content";
    this.containerEl.append(this.viewHeaderEl, this.contentEl);
  }

  setHeaderTitle(title: string): void {
    this.viewHeaderTitleEl.textContent = title;
    this.viewHeaderTitleEl.title = title;
  }

  addAction(icon: string, title: string, callback: (event: MouseEvent) => unknown): HTMLElement {
    const action = this.ownerDocument.createElement("button");
    action.type = "button";
    action.className = "view-action clickable-icon";
    action.dataset.icon = icon;
    action.title = title;
    action.setAttribute("aria-label", title);
    const iconElement = createCompatibleIcon(
      this.ownerDocument,
      icon,
      this.app.compatibility.getIcon(icon),
    );
    if (iconElement) {
      action.append(iconElement);
    }
    action.addEventListener("click", callback);
    this.viewActionsEl.append(action);
    this.register(() => action.removeEventListener("click", callback));
    return action;
  }
}

export class FileView extends ItemView {
  allowNoFile = false;
  file: TFile | null = null;
  override navigation = true;

  get headerEl(): HTMLElement {
    return this.viewHeaderEl;
  }

  override getDisplayText(): string {
    return this.file?.basename ?? "No file";
  }

  override getState(): Record<string, unknown> {
    return this.file ? { file: this.file.path } : {};
  }

  override async setState(state: unknown, _result: unknown): Promise<void> {
    const previousFile = this.file;
    if (previousFile) {
      await this.onUnloadFile(previousFile);
    }
    if (!state || typeof state !== "object" || !("file" in state)) {
      this.file = null;
      return;
    }
    const filePath = state.file;
    const nextFile = typeof filePath === "string" ? this.app.createFile(filePath) : null;
    this.file = nextFile;
    if (nextFile) {
      await this.onLoadFile(nextFile);
    }
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
