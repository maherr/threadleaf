import type { App, Plugin, TFile } from "./obsidian-compat";
import { BaseComponent, Component } from "./obsidian-components";
import { createCompatibleIcon } from "./obsidian-icons";

function currentDocument(): Document {
  if (typeof document === "undefined") {
    throw new Error("Obsidian UI compatibility requires a renderer document.");
  }
  return document;
}

function replaceElementContent(element: HTMLElement, value: string | DocumentFragment): void {
  if (typeof value === "string") {
    element.textContent = value;
  } else {
    element.replaceChildren(value);
  }
}

function setElementIcon(element: HTMLElement, icon: string): void {
  element.replaceChildren();
  const iconElement = createCompatibleIcon(element.ownerDocument, icon, null);
  if (iconElement) {
    element.append(iconElement);
  } else {
    element.dataset.icon = icon;
  }
}

export abstract class ValueComponent<T> extends BaseComponent {
  registerOptionListener(_listeners: Record<string, (value?: T) => T>, _key: string): this {
    return this;
  }

  abstract getValue(): T;

  abstract setValue(value: T): this;
}

export class AbstractTextComponent<
  T extends HTMLInputElement | HTMLTextAreaElement,
> extends ValueComponent<string> {
  readonly inputEl: T;
  private readonly changeCallbacks: Array<(value: string) => unknown> = [];

  constructor(inputEl: T) {
    super();
    this.inputEl = inputEl;
    this.inputEl.addEventListener("input", () => this.onChanged());
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.inputEl.disabled = disabled;
    return this;
  }

  getValue(): string {
    return this.inputEl.value;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }

  onChanged(): void {
    const value = this.getValue();
    for (const callback of this.changeCallbacks) {
      callback(value);
    }
  }

  onChange(callback: (value: string) => unknown): this {
    this.changeCallbacks.push(callback);
    return this;
  }
}

export class TextComponent extends AbstractTextComponent<HTMLInputElement> {
  constructor(containerEl: HTMLElement) {
    const input = containerEl.ownerDocument.createElement("input");
    input.type = "text";
    input.className = "text-input";
    containerEl.append(input);
    super(input);
  }
}

export class TextAreaComponent extends AbstractTextComponent<HTMLTextAreaElement> {
  constructor(containerEl: HTMLElement) {
    const input = containerEl.ownerDocument.createElement("textarea");
    input.className = "text-input mod-textarea";
    containerEl.append(input);
    super(input);
  }
}

export class SearchComponent extends AbstractTextComponent<HTMLInputElement> {
  readonly clearButtonEl: HTMLButtonElement;

  constructor(containerEl: HTMLElement) {
    const wrapper = containerEl.ownerDocument.createElement("div");
    wrapper.className = "search-input-container";
    const input = containerEl.ownerDocument.createElement("input");
    input.type = "search";
    input.className = "search-input";
    const clearButton = containerEl.ownerDocument.createElement("button");
    clearButton.type = "button";
    clearButton.className = "search-input-clear-button";
    clearButton.setAttribute("aria-label", "Clear search");
    setElementIcon(clearButton, "x");
    wrapper.append(input, clearButton);
    containerEl.append(wrapper);
    super(input);
    this.clearButtonEl = clearButton;
    clearButton.addEventListener("click", () => {
      this.setValue("");
      this.onChanged();
      this.inputEl.focus();
    });
  }
}

export class DropdownComponent extends ValueComponent<string> {
  readonly selectEl: HTMLSelectElement;
  private readonly changeCallbacks: Array<(value: string) => unknown> = [];

  constructor(containerEl: HTMLElement) {
    super();
    this.selectEl = containerEl.ownerDocument.createElement("select");
    this.selectEl.className = "dropdown";
    this.selectEl.addEventListener("change", () => {
      const value = this.getValue();
      for (const callback of this.changeCallbacks) {
        callback(value);
      }
    });
    containerEl.append(this.selectEl);
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.selectEl.disabled = disabled;
    return this;
  }

  addOption(value: string, display: string): this {
    const option = this.selectEl.ownerDocument.createElement("option");
    option.value = value;
    option.textContent = display;
    this.selectEl.append(option);
    return this;
  }

  addOptions(options: Record<string, string>): this {
    for (const [value, display] of Object.entries(options)) {
      this.addOption(value, display);
    }
    return this;
  }

  getValue(): string {
    return this.selectEl.value;
  }

  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }

  onChange(callback: (value: string) => unknown): this {
    this.changeCallbacks.push(callback);
    return this;
  }
}

export class ToggleComponent extends ValueComponent<boolean> {
  readonly toggleEl: HTMLInputElement;
  private readonly changeCallbacks: Array<(value: boolean) => unknown> = [];

  constructor(containerEl: HTMLElement) {
    super();
    this.toggleEl = containerEl.ownerDocument.createElement("input");
    this.toggleEl.type = "checkbox";
    this.toggleEl.className = "checkbox-container";
    this.toggleEl.addEventListener("change", () => {
      const value = this.getValue();
      for (const callback of this.changeCallbacks) {
        callback(value);
      }
    });
    containerEl.append(this.toggleEl);
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.toggleEl.disabled = disabled;
    return this;
  }

  getValue(): boolean {
    return this.toggleEl.checked;
  }

  setValue(on: boolean): this {
    this.toggleEl.checked = on;
    return this;
  }

  setTooltip(tooltip: string): this {
    this.toggleEl.title = tooltip;
    return this;
  }

  onClick(): void {
    this.toggleEl.click();
  }

  onChange(callback: (value: boolean) => unknown): this {
    this.changeCallbacks.push(callback);
    return this;
  }
}

export class SliderComponent extends ValueComponent<number> {
  readonly sliderEl: HTMLInputElement;
  private readonly changeCallbacks: Array<(value: number) => unknown> = [];
  private instant = true;

  constructor(containerEl: HTMLElement) {
    super();
    this.sliderEl = containerEl.ownerDocument.createElement("input");
    this.sliderEl.type = "range";
    this.sliderEl.className = "slider";
    this.sliderEl.addEventListener("input", () => {
      if (this.instant) {
        this.emitChange();
      }
    });
    this.sliderEl.addEventListener("change", () => {
      if (!this.instant) {
        this.emitChange();
      }
    });
    containerEl.append(this.sliderEl);
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.sliderEl.disabled = disabled;
    return this;
  }

  setInstant(instant: boolean): this {
    this.instant = instant;
    return this;
  }

  setLimits(min: number, max: number, step: number | "any"): this {
    this.sliderEl.min = String(min);
    this.sliderEl.max = String(max);
    this.sliderEl.step = String(step);
    return this;
  }

  getValue(): number {
    return this.sliderEl.valueAsNumber;
  }

  setValue(value: number): this {
    this.sliderEl.value = String(value);
    return this;
  }

  getValuePretty(): string {
    return String(this.getValue());
  }

  setDynamicTooltip(): this {
    this.sliderEl.title = this.getValuePretty();
    return this;
  }

  showTooltip(): void {
    this.sliderEl.title = this.getValuePretty();
  }

  onChange(callback: (value: number) => unknown): this {
    this.changeCallbacks.push(callback);
    return this;
  }

  private emitChange(): void {
    const value = this.getValue();
    for (const callback of this.changeCallbacks) {
      callback(value);
    }
  }
}

export class ButtonComponent extends BaseComponent {
  readonly buttonEl: HTMLButtonElement;

  constructor(containerEl: HTMLElement) {
    super();
    this.buttonEl = containerEl.ownerDocument.createElement("button");
    this.buttonEl.type = "button";
    containerEl.append(this.buttonEl);
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.buttonEl.disabled = disabled;
    return this;
  }

  setCta(): this {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }

  removeCta(): this {
    this.buttonEl.classList.remove("mod-cta");
    return this;
  }

  setWarning(): this {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }

  setTooltip(tooltip: string): this {
    this.buttonEl.title = tooltip;
    return this;
  }

  setButtonText(name: string): this {
    this.buttonEl.textContent = name;
    return this;
  }

  setIcon(icon: string): this {
    setElementIcon(this.buttonEl, icon);
    return this;
  }

  setClass(className: string): this {
    this.buttonEl.classList.add(...className.split(/\s+/).filter(Boolean));
    return this;
  }

  onClick(callback: (event: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener("click", callback);
    return this;
  }
}

export class ExtraButtonComponent extends BaseComponent {
  readonly extraSettingsEl: HTMLButtonElement;

  constructor(containerEl: HTMLElement) {
    super();
    this.extraSettingsEl = containerEl.ownerDocument.createElement("button");
    this.extraSettingsEl.type = "button";
    this.extraSettingsEl.className = "clickable-icon extra-setting-button";
    containerEl.append(this.extraSettingsEl);
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.extraSettingsEl.disabled = disabled;
    return this;
  }

  setTooltip(tooltip: string): this {
    this.extraSettingsEl.title = tooltip;
    return this;
  }

  setIcon(icon: string): this {
    setElementIcon(this.extraSettingsEl, icon);
    return this;
  }

  onClick(callback: () => unknown): this {
    this.extraSettingsEl.addEventListener("click", callback);
    return this;
  }
}

export class ColorComponent extends ValueComponent<string> {
  readonly colorPickerEl: HTMLInputElement;

  constructor(containerEl: HTMLElement) {
    super();
    this.colorPickerEl = containerEl.ownerDocument.createElement("input");
    this.colorPickerEl.type = "color";
    this.colorPickerEl.className = "color-input";
    containerEl.append(this.colorPickerEl);
  }

  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.colorPickerEl.disabled = disabled;
    return this;
  }

  getValue(): string {
    return this.colorPickerEl.value;
  }

  setValue(value: string): this {
    this.colorPickerEl.value = value;
    return this;
  }

  onChange(callback: (value: string) => unknown): this {
    this.colorPickerEl.addEventListener("input", () => callback(this.getValue()));
    return this;
  }
}

export class ProgressBarComponent extends ValueComponent<number> {
  readonly progressBarEl: HTMLProgressElement;

  constructor(containerEl: HTMLElement) {
    super();
    this.progressBarEl = containerEl.ownerDocument.createElement("progress");
    this.progressBarEl.className = "setting-progress-bar";
    this.progressBarEl.max = 100;
    containerEl.append(this.progressBarEl);
  }

  getValue(): number {
    return this.progressBarEl.value;
  }

  setValue(value: number): this {
    this.progressBarEl.value = value;
    return this;
  }
}

export class MomentFormatComponent extends TextComponent {
  sampleEl: HTMLElement;
  private defaultFormat = "";

  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.sampleEl = containerEl.ownerDocument.createElement("span");
    this.sampleEl.className = "moment-format-example";
    containerEl.append(this.sampleEl);
  }

  setDefaultFormat(defaultFormat: string): this {
    this.defaultFormat = defaultFormat;
    this.setPlaceholder(defaultFormat);
    this.updateSample();
    return this;
  }

  setSampleEl(sampleEl: HTMLElement): this {
    this.sampleEl.replaceWith(sampleEl);
    this.sampleEl = sampleEl;
    return this;
  }

  override setValue(value: string): this {
    super.setValue(value);
    this.updateSample();
    return this;
  }

  override onChanged(): void {
    super.onChanged();
    this.updateSample();
  }

  updateSample(): void {
    this.sampleEl.textContent = this.getValue() || this.defaultFormat;
  }
}

export class Setting {
  readonly settingEl: HTMLElement;
  readonly infoEl: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly descEl: HTMLElement;
  readonly controlEl: HTMLElement;
  readonly components: BaseComponent[] = [];

  constructor(containerEl: HTMLElement) {
    const doc = containerEl.ownerDocument;
    this.settingEl = doc.createElement("div");
    this.settingEl.className = "setting-item";
    this.infoEl = doc.createElement("div");
    this.infoEl.className = "setting-item-info";
    this.nameEl = doc.createElement("div");
    this.nameEl.className = "setting-item-name";
    this.descEl = doc.createElement("div");
    this.descEl.className = "setting-item-description";
    this.controlEl = doc.createElement("div");
    this.controlEl.className = "setting-item-control";
    this.infoEl.append(this.nameEl, this.descEl);
    this.settingEl.append(this.infoEl, this.controlEl);
    containerEl.append(this.settingEl);
  }

  setName(name: string | DocumentFragment): this {
    replaceElementContent(this.nameEl, name);
    return this;
  }

  setDesc(description: string | DocumentFragment): this {
    replaceElementContent(this.descEl, description);
    return this;
  }

  setClass(className: string): this {
    this.settingEl.classList.add(...className.split(/\s+/).filter(Boolean));
    return this;
  }

  setTooltip(tooltip: string): this {
    this.settingEl.title = tooltip;
    return this;
  }

  setHeading(): this {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.settingEl.classList.toggle("is-disabled", disabled);
    for (const component of this.components) {
      component.setDisabled(disabled);
    }
    return this;
  }

  setVisibility(visible: boolean): this {
    this.settingEl.hidden = !visible;
    return this;
  }

  addButton(callback: (component: ButtonComponent) => unknown): this {
    return this.addComponent(new ButtonComponent(this.controlEl), callback);
  }

  addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this {
    return this.addComponent(new ExtraButtonComponent(this.controlEl), callback);
  }

  addToggle(callback: (component: ToggleComponent) => unknown): this {
    return this.addComponent(new ToggleComponent(this.controlEl), callback);
  }

  addText(callback: (component: TextComponent) => unknown): this {
    return this.addComponent(new TextComponent(this.controlEl), callback);
  }

  addSearch(callback: (component: SearchComponent) => unknown): this {
    return this.addComponent(new SearchComponent(this.controlEl), callback);
  }

  addTextArea(callback: (component: TextAreaComponent) => unknown): this {
    return this.addComponent(new TextAreaComponent(this.controlEl), callback);
  }

  addMomentFormat(callback: (component: MomentFormatComponent) => unknown): this {
    return this.addComponent(new MomentFormatComponent(this.controlEl), callback);
  }

  addDropdown(callback: (component: DropdownComponent) => unknown): this {
    return this.addComponent(new DropdownComponent(this.controlEl), callback);
  }

  addColorPicker(callback: (component: ColorComponent) => unknown): this {
    return this.addComponent(new ColorComponent(this.controlEl), callback);
  }

  addProgressBar(callback: (component: ProgressBarComponent) => unknown): this {
    return this.addComponent(new ProgressBarComponent(this.controlEl), callback);
  }

  addSlider(callback: (component: SliderComponent) => unknown): this {
    return this.addComponent(new SliderComponent(this.controlEl), callback);
  }

  // biome-ignore lint/suspicious/noThenProperty: Required by Obsidian's public Setting API.
  then(callback: (setting: this) => unknown): this {
    callback(this);
    return this;
  }

  clear(): this {
    this.components.length = 0;
    this.nameEl.replaceChildren();
    this.descEl.replaceChildren();
    this.controlEl.replaceChildren();
    return this;
  }

  private addComponent<T extends BaseComponent>(
    component: T,
    callback: (component: T) => unknown,
  ): this {
    this.components.push(component);
    callback(component);
    return this;
  }
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

  async save(clear = false): Promise<void> {
    if (!this.file) {
      return;
    }
    const data = this.getViewData();
    await this.app.vault.modify(this.file, data);
    this.data = data;
    if (clear) {
      this.clear();
    }
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
