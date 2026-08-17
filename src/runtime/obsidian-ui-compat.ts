import type { App, Plugin, TFile } from "./obsidian-compat";
import { BaseComponent, type CompatibilityEventRef, Component } from "./obsidian-components";
import { Events } from "./obsidian-events";
import { createCompatibleIcon } from "./obsidian-icons";
import type { OpenViewState } from "./obsidian-workspace-compat";

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

function clampColorChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexToRgb(value: string): { r: number; g: number; b: number } {
  const normalized = value.replace(/^#/u, "");
  const expanded =
    normalized.length === 3 ? normalized.replace(/./gu, (part) => `${part}${part}`) : normalized;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

function rgbToHex(rgb: { r: number; g: number; b: number }): string {
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((channel) => clampColorChannel(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

function rgbToHsl(rgb: { r: number; g: number; b: number }): { h: number; s: number; l: number } {
  const red = clampColorChannel(rgb.r) / 255;
  const green = clampColorChannel(rgb.g) / 255;
  const blue = clampColorChannel(rgb.b) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const lightness = (maximum + minimum) / 2;
  if (maximum === minimum) {
    return { h: 0, s: 0, l: Math.round(lightness * 100) };
  }
  const delta = maximum - minimum;
  const saturation =
    lightness > 0.5 ? delta / (2 - maximum - minimum) : delta / (maximum + minimum);
  let hue: number;
  if (maximum === red) {
    hue = (green - blue) / delta + (green < blue ? 6 : 0);
  } else if (maximum === green) {
    hue = (blue - red) / delta + 2;
  } else {
    hue = (red - green) / delta + 4;
  }
  hue /= 6;
  return {
    h: Math.round(hue * 360) % 360,
    s: Math.round(saturation * 100),
    l: Math.round(lightness * 100),
  };
}

function hslToRgb(hsl: { h: number; s: number; l: number }): { r: number; g: number; b: number } {
  const hue = (((hsl.h % 360) + 360) % 360) / 360;
  const saturation = Math.max(0, Math.min(100, hsl.s)) / 100;
  const lightness = Math.max(0, Math.min(100, hsl.l)) / 100;
  if (saturation === 0) {
    const channel = Math.round(lightness * 255);
    return { r: channel, g: channel, b: channel };
  }
  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const hueToChannel = (value: number): number => {
    let channel = value;
    if (channel < 0) channel += 1;
    if (channel > 1) channel -= 1;
    if (channel < 1 / 6) return p + (q - p) * 6 * channel;
    if (channel < 1 / 2) return q;
    if (channel < 2 / 3) return p + (q - p) * (2 / 3 - channel) * 6;
    return p;
  };
  return {
    r: Math.round(hueToChannel(hue + 1 / 3) * 255),
    g: Math.round(hueToChannel(hue) * 255),
    b: Math.round(hueToChannel(hue - 1 / 3) * 255),
  };
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
  private readonly valueEl: HTMLElement;
  private readonly changeCallbacks: Array<(value: number) => unknown> = [];
  private instant = true;
  private displayFormat: ((value: number) => string) | null = null;

  constructor(containerEl: HTMLElement) {
    super();
    this.sliderEl = containerEl.ownerDocument.createElement("input");
    this.sliderEl.type = "range";
    this.sliderEl.className = "slider";
    this.valueEl = containerEl.ownerDocument.createElement("span");
    this.valueEl.className = "slider-value";
    this.sliderEl.addEventListener("input", () => {
      this.updateDisplay();
      if (this.instant) {
        this.emitChange();
      }
    });
    this.sliderEl.addEventListener("change", () => {
      this.updateDisplay();
      if (!this.instant) {
        this.emitChange();
      }
    });
    containerEl.append(this.sliderEl, this.valueEl);
    this.updateDisplay();
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
    this.updateDisplay();
    return this;
  }

  getValuePretty(): string {
    const value = this.getValue();
    return this.displayFormat ? this.displayFormat(value) : String(value);
  }

  setDisplayFormat(format: (value: number) => string): this {
    this.displayFormat = format;
    this.updateDisplay();
    return this;
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

  private updateDisplay(): void {
    this.valueEl.textContent = this.getValuePretty();
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

  setDestructive(): this {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }

  removeDestructive(): this {
    this.buttonEl.classList.remove("mod-warning");
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

  getValueRgb(): { r: number; g: number; b: number } {
    return hexToRgb(this.getValue());
  }

  getValueHsl(): { h: number; s: number; l: number } {
    return rgbToHsl(this.getValueRgb());
  }

  setValue(value: string): this {
    this.colorPickerEl.value = value;
    return this;
  }

  setValueRgb(rgb: { r: number; g: number; b: number }): this {
    return this.setValue(rgbToHex(rgb));
  }

  setValueHsl(hsl: { h: number; s: number; l: number }): this {
    return this.setValue(rgbToHex(hslToRgb(hsl)));
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

export class DisplayValueComponent extends BaseComponent {
  readonly valueEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    super();
    this.valueEl = containerEl.ownerDocument.createElement("span");
    this.valueEl.className = "setting-item-display-value";
    containerEl.append(this.valueEl);
  }

  setValue(value: string | null): this {
    this.valueEl.textContent = value ?? "";
    return this;
  }

  setStatus(status: "warning" | null): this {
    this.valueEl.classList.toggle("mod-warning", status === "warning");
    if (status === null) {
      delete this.valueEl.dataset.status;
    } else {
      this.valueEl.dataset.status = status;
    }
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
  errorEl: HTMLElement | null = null;

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

  setErrorMessage(message: string | null): this {
    if (!message) {
      this.errorEl?.remove();
      this.errorEl = null;
      this.settingEl.classList.remove("is-invalid");
      return this;
    }
    if (!this.errorEl) {
      this.errorEl = this.settingEl.ownerDocument.createElement("div");
      this.errorEl.className = "setting-item-error";
      this.controlEl.append(this.errorEl);
    }
    this.errorEl.textContent = message;
    this.settingEl.classList.add("is-invalid");
    return this;
  }

  addDisplayValue(callback: (component: DisplayValueComponent) => unknown): this {
    return this.addComponentInstance(new DisplayValueComponent(this.controlEl), callback);
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
    return this.addComponentInstance(new ButtonComponent(this.controlEl), callback);
  }

  addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this {
    return this.addComponentInstance(new ExtraButtonComponent(this.controlEl), callback);
  }

  addToggle(callback: (component: ToggleComponent) => unknown): this {
    return this.addComponentInstance(new ToggleComponent(this.controlEl), callback);
  }

  addText(callback: (component: TextComponent) => unknown): this {
    return this.addComponentInstance(new TextComponent(this.controlEl), callback);
  }

  addComponent<T extends BaseComponent>(callback: (element: HTMLElement) => T): this {
    const component = callback(this.controlEl);
    this.components.push(component);
    return this;
  }

  addSearch(callback: (component: SearchComponent) => unknown): this {
    return this.addComponentInstance(new SearchComponent(this.controlEl), callback);
  }

  addTextArea(callback: (component: TextAreaComponent) => unknown): this {
    return this.addComponentInstance(new TextAreaComponent(this.controlEl), callback);
  }

  addMomentFormat(callback: (component: MomentFormatComponent) => unknown): this {
    return this.addComponentInstance(new MomentFormatComponent(this.controlEl), callback);
  }

  addDropdown(callback: (component: DropdownComponent) => unknown): this {
    return this.addComponentInstance(new DropdownComponent(this.controlEl), callback);
  }

  addColorPicker(callback: (component: ColorComponent) => unknown): this {
    return this.addComponentInstance(new ColorComponent(this.controlEl), callback);
  }

  addProgressBar(callback: (component: ProgressBarComponent) => unknown): this {
    return this.addComponentInstance(new ProgressBarComponent(this.controlEl), callback);
  }

  addSlider(callback: (component: SliderComponent) => unknown): this {
    return this.addComponentInstance(new SliderComponent(this.controlEl), callback);
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
    this.errorEl = null;
    this.settingEl.classList.remove("is-invalid");
    return this;
  }

  private addComponentInstance<T extends BaseComponent>(
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

export type Modifier = "Mod" | "Ctrl" | "Meta" | "Shift" | "Alt";

export interface KeymapContext {
  key: string | null;
  modifiers: string | null;
  vkey: string;
}

export interface KeymapEventHandler {
  key: string | null;
  modifiers: string | null;
  scope: Scope;
}

export type KeymapEventListener = (event: KeyboardEvent, context: KeymapContext) => false | unknown;

interface ScopeKeyRegistration extends KeymapEventHandler {
  func: KeymapEventListener;
  modifierList: Modifier[] | null;
}

function normalizedEventKey(key: string): string {
  return key.length === 1 ? key.toLocaleLowerCase("en-US") : key;
}

function eventModifiers(event: KeyboardEvent): Modifier[] {
  const modifiers: Modifier[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.metaKey) modifiers.push("Meta");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.altKey) modifiers.push("Alt");
  return modifiers;
}

function matchesModifiers(event: KeyboardEvent, modifiers: Modifier[] | null): boolean {
  if (modifiers === null) {
    return true;
  }
  const expected = new Set(
    modifiers.map((modifier) =>
      modifier === "Mod" ? (process.platform === "darwin" ? "Meta" : "Ctrl") : modifier,
    ),
  );
  const actual = new Set(eventModifiers(event));
  return expected.size === actual.size && [...expected].every((modifier) => actual.has(modifier));
}

export class Scope {
  readonly parent: Scope | null;
  private readonly keys: ScopeKeyRegistration[] = [];

  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }

  register(
    modifiers: Modifier[] | null,
    key: string | null,
    func: KeymapEventListener,
  ): KeymapEventHandler {
    const modifierList = modifiers ? [...modifiers] : null;
    const registration: ScopeKeyRegistration = {
      func,
      key,
      modifierList,
      modifiers: modifierList?.join(",") ?? null,
      scope: this,
    };
    this.keys.push(registration);
    return registration;
  }

  unregister(handler: KeymapEventHandler): void {
    const index = this.keys.indexOf(handler as ScopeKeyRegistration);
    if (index >= 0) {
      this.keys.splice(index, 1);
    }
  }

  /** @internal Dispatches within this scope only. Parent traversal belongs to Keymap. */
  handleKeyEvent(event: KeyboardEvent): { matched: boolean; result?: unknown } {
    const eventKey = normalizedEventKey(event.key);
    for (const registration of [...this.keys].reverse()) {
      if (
        (registration.key === null || normalizedEventKey(registration.key) === eventKey) &&
        matchesModifiers(event, registration.modifierList)
      ) {
        const context: KeymapContext = {
          key: registration.key,
          modifiers: registration.modifiers,
          vkey: eventKey,
        };
        return { matched: true, result: registration.func(event, context) };
      }
    }
    return { matched: false };
  }
}

export class Keymap {
  private readonly rootScope = new Scope();

  getRootScope(): Scope {
    return this.rootScope;
  }
}

export abstract class PopoverSuggest<T> {
  readonly app: App;
  readonly scope: Scope;
  protected readonly suggestEl: HTMLElement;
  private openState = false;

  constructor(app: App, scope = new Scope(), ownerDocument = currentDocument()) {
    this.app = app;
    this.scope = scope;
    this.suggestEl = ownerDocument.createElement("div");
    this.suggestEl.className = "suggestion-container mod-search-suggestion";
  }

  open(): void {
    if (this.openState) {
      return;
    }
    this.openState = true;
    this.suggestEl.ownerDocument.body.append(this.suggestEl);
  }

  close(): void {
    this.openState = false;
    this.suggestEl.remove();
  }

  abstract renderSuggestion(value: T, element: HTMLElement): void;

  abstract selectSuggestion(value: T, event: MouseEvent | KeyboardEvent): void;
}

export abstract class AbstractInputSuggest<T> extends PopoverSuggest<T> {
  limit = 100;
  private activeIndex = 0;
  private readonly inputEl: HTMLInputElement | HTMLDivElement;
  private readonly selectCallbacks: Array<
    (value: T, event: MouseEvent | KeyboardEvent) => unknown
  > = [];
  private suggestions: T[] = [];
  private updateSequence = 0;

  constructor(app: App, textInputEl: HTMLInputElement | HTMLDivElement) {
    super(app, new Scope(), textInputEl.ownerDocument);
    this.inputEl = textInputEl;
    this.inputEl.addEventListener("input", () => void this.refreshSuggestions());
    this.inputEl.addEventListener("focus", () => void this.refreshSuggestions());
    this.inputEl.addEventListener("keydown", (event) => this.onKeyDown(event as KeyboardEvent));
    this.inputEl.addEventListener("blur", () => {
      this.inputEl.ownerDocument.defaultView?.setTimeout(() => this.close(), 0);
    });
  }

  setValue(value: string): void {
    if (this.inputEl.tagName === "INPUT") {
      (this.inputEl as HTMLInputElement).value = value;
    } else {
      this.inputEl.textContent = value;
    }
  }

  getValue(): string {
    if (this.inputEl.tagName === "INPUT") {
      return (this.inputEl as HTMLInputElement).value;
    }
    return this.inputEl.textContent ?? "";
  }

  override selectSuggestion(value: T, event: MouseEvent | KeyboardEvent): void {
    for (const callback of this.selectCallbacks) {
      callback(value, event);
    }
    this.close();
  }

  onSelect(callback: (value: T, event: MouseEvent | KeyboardEvent) => unknown): this {
    this.selectCallbacks.push(callback);
    return this;
  }

  protected abstract getSuggestions(query: string): T[] | Promise<T[]>;

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      this.close();
      return;
    }
    if (this.suggestions.length === 0) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      this.activeIndex = (this.activeIndex + 1) % this.suggestions.length;
      this.renderActiveSuggestion();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      this.activeIndex = (this.activeIndex - 1 + this.suggestions.length) % this.suggestions.length;
      this.renderActiveSuggestion();
      return;
    }
    if (event.key === "Enter") {
      const selected = this.suggestions[this.activeIndex];
      if (selected !== undefined) {
        event.preventDefault();
        this.selectSuggestion(selected, event);
      }
    }
  }

  private async refreshSuggestions(): Promise<void> {
    const sequence = ++this.updateSequence;
    const values = await this.getSuggestions(this.getValue());
    if (sequence !== this.updateSequence) {
      return;
    }
    this.suggestions = this.limit === 0 ? [...values] : values.slice(0, this.limit);
    this.activeIndex = 0;
    this.suggestEl.replaceChildren();
    if (this.suggestions.length === 0) {
      this.close();
      return;
    }
    for (const [index, suggestion] of this.suggestions.entries()) {
      const element = this.suggestEl.ownerDocument.createElement("div");
      element.className = "suggestion-item";
      this.renderSuggestion(suggestion, element);
      element.addEventListener("mouseenter", () => {
        this.activeIndex = index;
        this.renderActiveSuggestion();
      });
      element.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.selectSuggestion(suggestion, event);
      });
      this.suggestEl.append(element);
    }
    this.renderActiveSuggestion();
    this.open();
  }

  private renderActiveSuggestion(): void {
    for (const [index, element] of [...this.suggestEl.children].entries()) {
      element.classList.toggle("is-selected", index === this.activeIndex);
    }
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
  private releasePluginOwnership: (() => void) | null = null;

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
    this.releasePluginOwnership = this.app.registerPluginModal(this);
    currentDocument().body.append(this.containerEl);
    try {
      this.onOpen();
    } catch (error) {
      this.openState = false;
      this.containerEl.remove();
      this.releasePluginOwnership?.();
      this.releasePluginOwnership = null;
      throw error;
    }
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
      this.releasePluginOwnership?.();
      this.releasePluginOwnership = null;
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

interface WorkspaceViewState {
  active?: boolean;
  group?: WorkspaceLeaf;
  pinned?: boolean;
  state?: Record<string, unknown>;
}

const constructedWorkspaceLeaves = new WeakSet<WorkspaceLeaf>();

// A prototype-grafted impostor passes instanceof without ever running the
// constructor; only construction-time branding proves a real leaf.
export function isConstructedWorkspaceLeaf(leaf: WorkspaceLeaf): boolean {
  return constructedWorkspaceLeaves.has(leaf);
}

export class WorkspaceLeaf extends Events {
  readonly app: App;
  readonly containerEl: HTMLElement;
  readonly id: string;
  readonly tabHeaderInnerIconEl: HTMLElement;
  readonly tabHeaderInnerTitleEl: HTMLElement;
  view: View | null = null;
  hoverPopover: null = null;
  private pinned = false;
  private ephemeralState: Record<string, unknown> = {};
  private readonly releaseWorkspaceRegistration: () => void;
  private viewState: { type: string; state: Record<string, unknown> } = {
    type: "empty",
    state: {},
  };

  private static nextId = 1;

  constructor(app: App, containerEl?: HTMLElement) {
    super();
    constructedWorkspaceLeaves.add(this);
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

  getViewState(): WorkspaceViewState & { type: string; state: Record<string, unknown> } {
    const group = this.app.workspace.getLeafGroupMember(this);
    return {
      type: this.viewState.type,
      state: structuredClone(this.viewState.state),
      ...(this.pinned ? { pinned: true } : {}),
      ...(group ? { group } : {}),
    };
  }

  async setViewState(
    viewState: WorkspaceViewState & { type: string },
    result: Record<string, unknown> = {},
  ): Promise<void> {
    await this.releaseView();
    this.containerEl.replaceChildren();
    this.viewState = {
      type: viewState.type,
      state: structuredClone(viewState.state ?? {}),
    };
    this.ephemeralState = {};
    if (viewState.type === "empty") {
      return;
    }
    const candidate =
      viewState.type === "markdown"
        ? new MarkdownView(this)
        : this.app.compatibility.createView(viewState.type, this);
    if (!(candidate instanceof View)) {
      throw new Error(`View creator did not return a View: ${viewState.type}`);
    }
    this.view = candidate;
    try {
      candidate.load();
      await candidate.openCompatibilityView();
      await candidate.setState(this.viewState.state, result);
      const displayText = candidate.getDisplayText();
      this.tabHeaderInnerTitleEl.textContent = displayText;
      if (candidate instanceof ItemView) {
        const filePath = candidate instanceof FileView ? candidate.file?.path : null;
        candidate.setHeaderTitle(filePath ?? displayText);
      }
      if (viewState.group) {
        this.app.workspace.setLeafGroup(this, viewState.group);
      }
      if (viewState.pinned !== undefined) {
        this.pinned = viewState.pinned;
      }
      if (viewState.active !== false) {
        this.app.workspace.setActiveLeaf(this);
        this.app.workspace.trigger("active-leaf-change", this);
      }
      this.app.workspace.trigger("layout-change");
    } catch (error) {
      await this.releaseView();
      throw error;
    }
  }

  async openFile(file: TFile, openState: OpenViewState = {}): Promise<void> {
    const viewType =
      this.app.compatibility.getViewTypeForExtension(file.extension) ??
      this.view?.getViewType() ??
      "markdown";
    await this.setViewState({
      type: viewType,
      state: {
        ...structuredClone(openState.state ?? {}),
        file: file.path,
      },
      ...(openState.active === undefined ? {} : { active: openState.active }),
      ...(openState.group ? { group: openState.group } : {}),
    });
    if (openState.eState) {
      this.setEphemeralState(openState.eState);
    }
  }

  async open(view: View): Promise<View> {
    if (view.leaf !== this) {
      throw new Error("Workspace leaf can only open a view constructed for itself.");
    }
    const previousView = this.view === view ? null : this.view;
    this.view = null;
    if (previousView) {
      await this.releaseViewInstance(previousView);
    }
    this.containerEl.replaceChildren();
    this.view = view;
    this.ephemeralState = {};
    try {
      view.load();
      await view.openCompatibilityView();
      const state = structuredClone(view.getState());
      await view.setState(state, {});
      this.viewState = { type: view.getViewType(), state };
      this.tabHeaderInnerTitleEl.textContent = view.getDisplayText();
      if (view instanceof ItemView) {
        const filePath = view instanceof FileView ? view.file?.path : null;
        view.setHeaderTitle(filePath ?? view.getDisplayText());
      }
      this.app.workspace.setActiveLeaf(this);
      this.app.workspace.trigger("active-leaf-change", this);
      this.app.workspace.trigger("layout-change");
      return view;
    } catch (error) {
      this.view = null;
      await this.releaseViewInstance(view).catch(() => undefined);
      throw error;
    }
  }

  async rebuildView(): Promise<void> {
    await this.setViewState(this.getViewState());
  }

  get isDeferred(): boolean {
    return false;
  }

  async loadIfDeferred(): Promise<void> {}

  getEphemeralState(): Record<string, unknown> {
    return structuredClone(this.ephemeralState);
  }

  setEphemeralState(state: unknown): void {
    this.ephemeralState =
      state && typeof state === "object" ? structuredClone(state as Record<string, unknown>) : {};
    this.view?.setEphemeralState(structuredClone(this.ephemeralState));
  }

  async detach(): Promise<void> {
    try {
      await this.releaseView();
    } finally {
      this.releaseWorkspaceRegistration();
      this.containerEl.remove();
    }
  }

  setPinned(pinned: boolean): void {
    this.pinned = pinned;
    this.trigger("pinned-change", pinned);
    this.app.workspace.trigger("layout-change");
  }

  togglePinned(): void {
    this.setPinned(!this.pinned);
  }

  setGroupMember(other: WorkspaceLeaf): void {
    this.app.workspace.setLeafGroup(this, other);
  }

  setGroup(group: string): void {
    this.trigger("group-change", group);
  }

  getIcon(): string {
    return this.view?.getIcon() ?? "document";
  }

  getDisplayText(): string {
    return this.view?.getDisplayText() ?? "Untitled";
  }

  onResize(): void {
    this.view?.onResize();
  }

  on(
    name: "pinned-change",
    callback: (pinned: boolean) => unknown,
    context?: unknown,
  ): CompatibilityEventRef;
  on(
    name: "group-change",
    callback: (group: string) => unknown,
    context?: unknown,
  ): CompatibilityEventRef;
  override on(
    name: string,
    callback: (...args: never[]) => unknown,
    context?: unknown,
  ): CompatibilityEventRef {
    return super.on(name, callback as (...args: unknown[]) => unknown, context);
  }

  private async releaseView(): Promise<void> {
    const view = this.view;
    this.view = null;
    if (!view) {
      return;
    }
    await this.releaseViewInstance(view);
  }

  private async releaseViewInstance(view: View): Promise<void> {
    let failure: unknown = null;
    if (view instanceof FileView && view.file) {
      try {
        await view.onUnloadFile(view.file);
      } catch (error) {
        failure = error;
      }
    }
    try {
      view.unload();
    } catch (error) {
      failure ??= error;
    }
    try {
      await view.closeCompatibilityView();
    } catch (error) {
      failure ??= error;
    }
    if (failure) {
      throw failure;
    }
  }
}

export class View extends Component {
  readonly app: App;
  readonly leaf: WorkspaceLeaf;
  readonly containerEl: HTMLElement;
  icon = "document";
  navigation = false;
  scope: Scope | null = null;
  private openState = false;

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

  async openCompatibilityView(): Promise<void> {
    if (this.openState) {
      return;
    }
    this.openState = true;
    try {
      await this.onOpen();
    } catch (error) {
      this.openState = false;
      throw error;
    }
  }

  async closeCompatibilityView(): Promise<void> {
    if (!this.openState) {
      return;
    }
    this.openState = false;
    await this.onClose();
  }

  protected async onOpen(): Promise<void> {}

  protected async onClose(): Promise<void> {}

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

export interface EditorPosition {
  ch: number;
  line: number;
}

export class Editor {
  private anchor = 0;
  private focused = false;
  private head = 0;
  private readonly onChange: (value: string) => void;
  private value = "";

  constructor(onChange: (value: string) => void = () => undefined) {
    this.onChange = onChange;
  }

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.replaceValue(value, true);
  }

  syncValue(value: string): void {
    this.replaceValue(value, false);
  }

  getSelection(): string {
    const from = Math.min(this.anchor, this.head);
    const to = Math.max(this.anchor, this.head);
    return this.value.slice(from, to);
  }

  somethingSelected(): boolean {
    return this.anchor !== this.head;
  }

  replaceSelection(replacement: string): void {
    const from = Math.min(this.anchor, this.head);
    const to = Math.max(this.anchor, this.head);
    this.value = `${this.value.slice(0, from)}${replacement}${this.value.slice(to)}`;
    this.anchor = from + replacement.length;
    this.head = this.anchor;
    this.onChange(this.value);
  }

  replaceRange(replacement: string, from: EditorPosition, to: EditorPosition = from): void {
    this.setSelection(from, to);
    this.replaceSelection(replacement);
  }

  getCursor(which: "anchor" | "from" | "head" | "to" = "head"): EditorPosition {
    if (which === "anchor") {
      return this.offsetToPos(this.anchor);
    }
    if (which === "from") {
      return this.offsetToPos(Math.min(this.anchor, this.head));
    }
    if (which === "to") {
      return this.offsetToPos(Math.max(this.anchor, this.head));
    }
    return this.offsetToPos(this.head);
  }

  setCursor(position: EditorPosition): void {
    const offset = this.posToOffset(position);
    this.anchor = offset;
    this.head = offset;
  }

  setSelection(anchor: EditorPosition, head: EditorPosition = anchor): void {
    this.anchor = this.posToOffset(anchor);
    this.head = this.posToOffset(head);
  }

  setSelectionOffsets(anchor: number, head: number): void {
    this.anchor = this.clampOffset(anchor);
    this.head = this.clampOffset(head);
  }

  getSelectionOffsets(): { anchor: number; head: number } {
    return { anchor: this.anchor, head: this.head };
  }

  getLine(line: number): string {
    return this.value.split("\n")[line] ?? "";
  }

  lineCount(): number {
    return this.value.split("\n").length;
  }

  lastLine(): number {
    return this.lineCount() - 1;
  }

  posToOffset(position: EditorPosition): number {
    const lines = this.value.split("\n");
    const line = Math.max(0, Math.min(Math.trunc(position.line), lines.length - 1));
    let offset = 0;
    for (let index = 0; index < line; index += 1) {
      offset += (lines[index]?.length ?? 0) + 1;
    }
    const ch = Math.max(0, Math.min(Math.trunc(position.ch), lines[line]?.length ?? 0));
    return offset + ch;
  }

  offsetToPos(offset: number): EditorPosition {
    const bounded = this.clampOffset(offset);
    const prefix = this.value.slice(0, bounded);
    const lines = prefix.split("\n");
    return {
      line: lines.length - 1,
      ch: lines.at(-1)?.length ?? 0,
    };
  }

  focus(): void {
    this.focused = true;
  }

  hasFocus(): boolean {
    return this.focused;
  }

  private clampOffset(offset: number): number {
    return Math.max(0, Math.min(Math.trunc(offset), this.value.length));
  }

  private replaceValue(value: string, notify: boolean): void {
    this.value = value;
    this.anchor = this.clampOffset(this.anchor);
    this.head = this.clampOffset(this.head);
    if (notify) {
      this.onChange(this.value);
    }
  }
}

export class MarkdownView extends TextFileView {
  readonly editor: Editor;
  hoverPopover: null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.editor = new Editor((value) => {
      this.data = value;
    });
  }

  override getViewData(): string {
    return this.editor.getValue();
  }

  override setViewData(data: string, _clear: boolean): void {
    this.data = data;
    this.editor.syncValue(data);
  }

  override clear(): void {
    this.data = "";
    this.editor.syncValue("");
  }

  override getViewType(): string {
    return "markdown";
  }

  override setEphemeralState(state: unknown): void {
    if (!state || typeof state !== "object") {
      return;
    }
    const cursor = "cursor" in state ? state.cursor : null;
    if (cursor && typeof cursor === "object" && "from" in cursor) {
      const from = this.editorPosition(cursor.from);
      const to = "to" in cursor ? this.editorPosition(cursor.to) : from;
      if (from) {
        this.editor.setSelection(from, to ?? from);
        return;
      }
    }
    const line = "line" in state ? state.line : null;
    if (typeof line === "number" && Number.isFinite(line)) {
      this.editor.setCursor({ ch: 0, line });
    }
  }

  private editorPosition(value: unknown): EditorPosition | null {
    if (!value || typeof value !== "object" || !("line" in value) || !("ch" in value)) {
      return null;
    }
    const line = value.line;
    const ch = value.ch;
    return typeof line === "number" &&
      Number.isFinite(line) &&
      typeof ch === "number" &&
      Number.isFinite(ch)
      ? { ch, line }
      : null;
  }
}

export { BaseComponent, Component };
