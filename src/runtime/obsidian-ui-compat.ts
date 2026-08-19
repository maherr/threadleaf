import type { App, MarkdownPreviewView, Plugin, TFile } from "./obsidian-compat";
import { BaseComponent, type CompatibilityEventRef, Component } from "./obsidian-components";
import { createCompatibleIcon } from "./obsidian-icons";
import type { OpenViewState, WorkspaceTabs } from "./obsidian-workspace-compat";
import { WorkspaceItem } from "./obsidian-workspace-items";

type MarkdownPreviewViewConstructor = typeof MarkdownPreviewView;
let markdownPreviewViewConstructor: MarkdownPreviewViewConstructor | null = null;

export function setMarkdownPreviewViewConstructor(
  previewViewConstructor: MarkdownPreviewViewConstructor,
): void {
  markdownPreviewViewConstructor = previewViewConstructor;
}

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

  override onChanged(): void {
    super.onChanged();
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

export class SecretComponent extends BaseComponent {
  readonly inputEl: HTMLInputElement;
  readonly app: App;
  private readonly changeCallbacks: Array<(value: string | null) => unknown> = [];

  constructor(app: App, containerEl: HTMLElement) {
    super();
    this.app = app;
    this.inputEl = containerEl.ownerDocument.createElement("input");
    this.inputEl.type = "password";
    this.inputEl.autocomplete = "off";
    this.inputEl.className = "secret-input";
    this.inputEl.addEventListener("input", () => {
      const value = this.inputEl.value;
      for (const callback of this.changeCallbacks) {
        callback(value.length > 0 ? value : null);
      }
    });
    containerEl.append(this.inputEl);
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  onChange(callback: (value: string | null) => unknown): this {
    this.changeCallbacks.push(callback);
    return this;
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

export class SettingGroup {
  readonly listEl: HTMLElement;
  private headingEl: HTMLElement | null = null;

  constructor(containerEl: HTMLElement) {
    this.listEl = containerEl.ownerDocument.createElement("div");
    this.listEl.className = "setting-group";
    containerEl.append(this.listEl);
  }

  setHeading(text: string | DocumentFragment): this {
    if (!this.headingEl) {
      this.headingEl = this.listEl.ownerDocument.createElement("div");
      this.headingEl.className = "setting-group-heading";
      this.listEl.prepend(this.headingEl);
    }
    replaceElementContent(this.headingEl, text);
    return this;
  }

  addClass(...classes: string[]): this {
    this.listEl.classList.add(
      ...classes.flatMap((className) => className.split(/\s+/u).filter(Boolean)),
    );
    return this;
  }

  addSetting(callback: (setting: Setting) => void): this {
    const setting = new Setting(this.listEl);
    callback(setting);
    return this;
  }

  addSearch(callback: (component: SearchComponent) => unknown): this {
    const component = new SearchComponent(this.listEl);
    callback(component);
    return this;
  }

  addExtraButton(callback: (component: ExtraButtonComponent) => unknown): this {
    const component = new ExtraButtonComponent(this.listEl);
    callback(component);
    return this;
  }
}

export abstract class SettingPage {
  readonly rootEl: HTMLElement;
  readonly titlebarEl: HTMLElement;
  readonly containerEl: HTMLElement;
  title = "";

  constructor() {
    const doc = currentDocument();
    this.rootEl = doc.createElement("div");
    this.rootEl.className = "setting-page";
    this.titlebarEl = doc.createElement("div");
    this.titlebarEl.className = "setting-page-titlebar";
    this.containerEl = doc.createElement("div");
    this.containerEl.className = "setting-page-content";
    this.rootEl.append(this.titlebarEl, this.containerEl);
  }

  abstract display(): void;

  hide(): void {
    this.containerEl.replaceChildren();
  }
}

type SettingDynamicFlag = boolean | (() => boolean);

interface SettingDefinitionBaseLike {
  aliases?: string[];
  desc?: string | DocumentFragment;
  name: string;
  searchable?: SettingDynamicFlag;
  visible?: SettingDynamicFlag;
}

interface SettingControlLike {
  defaultValue?: unknown;
  disabled?: SettingDynamicFlag;
  displayFormat?: (value: number) => string;
  key: string;
  max?: number;
  min?: number;
  options?: Record<string, string>;
  placeholder?: string;
  rows?: number;
  step?: number | "any";
  type: string;
  validate?: (value: never) => string | void | Promise<string | void>;
}

interface SettingDefinitionLike extends SettingDefinitionBaseLike {
  action?: (element: HTMLElement, index: number) => void;
  control?: SettingControlLike;
  disabled?: SettingDynamicFlag;
  render?: (setting: Setting, group: SettingGroup) => void | (() => void);
}

interface SettingPageDefinitionLike {
  desc?: string | DocumentFragment;
  displayValue?: string | (() => string);
  items?: SettingDefinitionItemLike[];
  name: string;
  page?: () => SettingPage;
  status?: "warning" | null | (() => "warning" | null);
  type: "page";
  visible?: SettingDynamicFlag;
}

interface SettingGroupDefinitionLike {
  addItem?: { action: (element: HTMLElement) => void; name: string };
  cls?: string;
  emptyState?: string | DocumentFragment;
  extraButtons?: Array<(component: ExtraButtonComponent) => unknown>;
  heading?: string;
  items?: Array<SettingDefinitionLike | SettingPageDefinitionLike>;
  onDelete?: (index: number) => void;
  onReorder?: (oldIndex: number, newIndex: number) => void;
  search?: {
    match: (definition: SettingDefinitionLike, query: string) => boolean;
    placeholder?: string;
  };
  type: "group" | "list";
  visible?: SettingDynamicFlag;
}

type SettingDefinitionItemLike =
  | SettingDefinitionLike
  | SettingGroupDefinitionLike
  | SettingPageDefinitionLike;

interface SettingDomStateBinding {
  disabled?: SettingDynamicFlag | undefined;
  element: HTMLElement;
  setting?: Setting;
  visible?: SettingDynamicFlag | undefined;
}

function resolveSettingFlag(flag: SettingDynamicFlag | undefined, fallback: boolean): boolean {
  return typeof flag === "function" ? flag() : (flag ?? fallback);
}

function isSettingGroupDefinition(value: unknown): value is SettingGroupDefinitionLike {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "group" || type === "list";
}

function isSettingPageDefinition(value: unknown): value is SettingPageDefinitionLike {
  return Boolean(
    value && typeof value === "object" && (value as { type?: unknown }).type === "page",
  );
}

function settingSearchText(definition: SettingDefinitionBaseLike): string {
  const description =
    typeof definition.desc === "string" ? definition.desc : (definition.desc?.textContent ?? "");
  return [definition.name, description, ...(definition.aliases ?? [])].join(" ").trim();
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

export class UiKeymap {
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
  private closeCallback: (() => unknown) | null = null;

  constructor(app: App) {
    this.app = app;
    const doc = currentDocument();
    this.containerEl = doc.createElement("div");
    this.containerEl.className = "modal-container mod-dim";
    this.bgEl = doc.createElement("div");
    this.bgEl.className = "modal-bg";
    this.bgEl.style.zIndex = "0";
    this.modalEl = doc.createElement("div");
    this.modalEl.className = "modal";
    this.modalEl.style.position = "relative";
    this.modalEl.style.zIndex = "1";
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
      const closeCallback = this.closeCallback;
      this.closeCallback = null;
      closeCallback?.();
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

  setCloseCallback(callback: () => unknown): this {
    this.closeCallback = callback;
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

export class ConfirmationButton extends ButtonComponent {
  private readonly owner: ConfirmationModal;

  private constructor(containerEl: HTMLElement, owner: ConfirmationModal) {
    super(containerEl);
    this.owner = owner;
  }

  static create(containerEl: HTMLElement, owner: ConfirmationModal): ConfirmationButton {
    return new ConfirmationButton(containerEl, owner);
  }

  override onClick(handler: (event: MouseEvent) => unknown | Promise<unknown>): this {
    super.onClick(async (event) => {
      const result = await handler(event);
      if (!result) {
        this.owner.closeFromButton();
      }
    });
    return this;
  }

  setInitialFocus(): this {
    this.owner.setInitialFocusButton(this);
    return this;
  }

  setSecondary(): this {
    this.owner.moveButtonToSecondary(this);
    return this;
  }

  setCancel(): this {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }
}

export class ConfirmationModal extends Modal {
  readonly buttonContainerEl: HTMLElement;
  private readonly secondaryButtonContainerEl: HTMLElement;
  private initialFocusButton: ConfirmationButton | null = null;

  constructor(app: App) {
    super(app);
    const doc = this.modalEl.ownerDocument;
    this.buttonContainerEl = doc.createElement("div");
    this.buttonContainerEl.className = "modal-button-container";
    this.secondaryButtonContainerEl = doc.createElement("div");
    this.secondaryButtonContainerEl.className = "modal-button-container mod-secondary";
    this.modalEl.append(this.buttonContainerEl, this.secondaryButtonContainerEl);
  }

  addClass(className: string): this {
    this.modalEl.classList.add(...className.split(/\s+/u).filter(Boolean));
    return this;
  }

  addCheckbox(label: string, callback: (value: boolean) => unknown | Promise<unknown>): this {
    const labelEl = this.contentEl.ownerDocument.createElement("label");
    const checkbox = this.contentEl.ownerDocument.createElement("input");
    checkbox.type = "checkbox";
    const text = this.contentEl.ownerDocument.createElement("span");
    text.textContent = label;
    labelEl.append(checkbox, text);
    checkbox.addEventListener("change", () => {
      void callback(checkbox.checked);
    });
    this.contentEl.append(labelEl);
    return this;
  }

  addButton(callback: (button: ConfirmationButton) => unknown): this {
    const button = ConfirmationButton.create(this.buttonContainerEl, this);
    callback(button);
    return this;
  }

  addCancelButton(text = "Cancel"): this {
    return this.addButton((button) => {
      button
        .setButtonText(text)
        .setCancel()
        .onClick(() => undefined);
    });
  }

  setInitialFocusButton(button: ConfirmationButton): void {
    this.initialFocusButton = button;
  }

  moveButtonToSecondary(button: ConfirmationButton): void {
    this.secondaryButtonContainerEl.append(button.buttonEl);
  }

  closeFromButton(): void {
    this.close();
  }

  override onOpen(): void {
    this.initialFocusButton?.buttonEl.focus();
  }
}

export class SuggestModal<T> extends Modal {
  limit = 100;
  emptyStateText = "No matches found.";
  readonly inputEl: HTMLInputElement;
  readonly resultContainerEl: HTMLElement;
  private instructions: Instruction[] = [];
  private suggestions: T[] = [];
  private activeSuggestionIndex = 0;

  constructor(app: App) {
    super(app);
    const doc = this.contentEl.ownerDocument;
    this.inputEl = doc.createElement("input");
    this.inputEl.className = "prompt-input";
    this.resultContainerEl = doc.createElement("div");
    this.resultContainerEl.className = "suggestion-container";
    this.contentEl.append(this.inputEl, this.resultContainerEl);
    this.inputEl.addEventListener("input", () => void this.refreshSuggestions());
    this.inputEl.addEventListener("keydown", (event) => this.handleKeyDown(event));
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
    const active = this.suggestions[this.activeSuggestionIndex];
    if (active !== undefined) {
      this.selectSuggestion(active, event);
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
    this.activeSuggestionIndex = 0;
    this.resultContainerEl.replaceChildren();
    if (this.suggestions.length === 0) {
      this.onNoSuggestion();
      return;
    }
    for (const [index, suggestion] of this.suggestions.entries()) {
      const element = this.resultContainerEl.ownerDocument.createElement("div");
      element.className = "suggestion-item";
      element.classList.toggle("is-selected", index === this.activeSuggestionIndex);
      this.renderSuggestion(suggestion, element);
      element.addEventListener("click", (event) => this.selectSuggestion(suggestion, event));
      element.addEventListener("mouseenter", () => {
        this.activeSuggestionIndex = index;
        this.renderActiveSuggestion();
      });
      this.resultContainerEl.append(element);
    }
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (this.suggestions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      this.activeSuggestionIndex =
        (this.activeSuggestionIndex + direction + this.suggestions.length) %
        this.suggestions.length;
      this.renderActiveSuggestion();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      this.selectActiveSuggestion(event);
    }
  }

  private renderActiveSuggestion(): void {
    const elements = this.resultContainerEl.querySelectorAll<HTMLElement>(".suggestion-item");
    for (const [index, element] of [...elements].entries()) {
      element.classList.toggle("is-selected", index === this.activeSuggestionIndex);
    }
    elements[this.activeSuggestionIndex]?.scrollIntoView({ block: "nearest" });
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
  icon = "";
  app: App;
  containerEl: HTMLElement;
  settingItems: unknown[] = [];
  private definitionCleanups: Array<() => void> = [];
  private definitionRenderingActive = false;
  private domStateBindings: SettingDomStateBinding[] = [];
  private selectedPage: SettingPageDefinitionLike | null = null;

  constructor(app: App) {
    this.app = app;
    this.containerEl = currentDocument().createElement("div");
    this.containerEl.className = "vertical-tab-content";
  }

  getSettingDefinitions(): unknown[] {
    return [];
  }

  update(): void {
    const definitions = this.getSettingDefinitions();
    if (!Array.isArray(definitions)) {
      throw new TypeError("SettingTab.getSettingDefinitions() must return an array.");
    }
    this.settingItems = [...definitions];
    if (this.definitionRenderingActive) {
      this.renderSettingDefinitions();
    }
  }

  getControlValue(key: string): unknown {
    return this.app.vault.getConfig(key);
  }

  setControlValue(key: string, value: unknown): void | Promise<void> {
    const vault = this.app.vault as typeof this.app.vault & {
      setConfig?: (configKey: string, configValue: unknown) => void | Promise<void>;
    };
    if (typeof vault.setConfig !== "function") {
      throw new Error(
        "SettingTab control writes require a kernel-owned vault configuration adapter.",
      );
    }
    return vault.setConfig(key, value);
  }

  refreshDomState(): void {
    for (const binding of this.domStateBindings) {
      const visible = resolveSettingFlag(binding.visible, true);
      binding.element.hidden = !visible;
      if (binding.setting) {
        binding.setting.setDisabled(resolveSettingFlag(binding.disabled, false));
      }
    }
  }

  renderSettingDefinitions(): void {
    const selectedPage = this.selectedPage;
    this.disposeDefinitionRendering();
    this.definitionRenderingActive = true;
    this.selectedPage = selectedPage;
    this.containerEl.replaceChildren();
    const definitions = this.settingItems as SettingDefinitionItemLike[];
    if (this.selectedPage) {
      this.renderPage(this.selectedPage);
      return;
    }
    this.renderDefinitionItems(this.containerEl, definitions);
    this.refreshDomState();
  }

  disposeDefinitionRendering(): void {
    for (const cleanup of this.definitionCleanups.splice(0).reverse()) {
      cleanup();
    }
    this.domStateBindings = [];
    this.definitionRenderingActive = false;
    this.selectedPage = null;
  }

  display(): void {
    this.update();
  }

  hide(): void {
    this.disposeDefinitionRendering();
    this.selectedPage = null;
    this.containerEl.replaceChildren();
  }

  private renderDefinitionItems(
    container: HTMLElement,
    definitions: SettingDefinitionItemLike[],
  ): void {
    definitions.forEach((definition, index) => {
      if (isSettingGroupDefinition(definition)) {
        this.renderGroupDefinition(container, definition);
      } else if (isSettingPageDefinition(definition)) {
        this.renderPageLink(container, definition);
      } else {
        const group = new SettingGroup(container);
        this.renderSettingDefinition(group, definition, index);
      }
    });
  }

  private renderGroupDefinition(
    container: HTMLElement,
    definition: SettingGroupDefinitionLike,
  ): void {
    const group = new SettingGroup(container);
    group.addClass("setting-definition-group", `setting-definition-${definition.type}`);
    if (definition.cls) group.addClass(definition.cls);
    if (definition.heading) group.setHeading(definition.heading);
    for (const configure of definition.extraButtons ?? []) {
      group.addExtraButton(configure);
    }
    if (definition.type === "list" && definition.addItem) {
      group.addExtraButton((button) =>
        button
          .setIcon("plus")
          .setTooltip(definition.addItem?.name ?? "Add")
          .onClick(() => definition.addItem?.action(button.extraSettingsEl)),
      );
    }
    const items = definition.items ?? [];
    const renderedItems: HTMLElement[] = [];
    items.forEach((item, index) => {
      let element: HTMLElement;
      if (isSettingPageDefinition(item)) {
        element = this.renderPageLink(group.listEl, item);
      } else {
        element = this.renderSettingDefinition(group, item, index).settingEl;
      }
      renderedItems.push(element);
      if (definition.type === "list") {
        element.classList.add("setting-list-item");
        if (definition.onReorder) {
          const controls = element.querySelector<HTMLElement>(".setting-item-control");
          if (controls) {
            new ExtraButtonComponent(controls)
              .setIcon("chevron-up")
              .setTooltip("Move up")
              .setDisabled(index === 0)
              .onClick(() => definition.onReorder?.(index, index - 1));
            new ExtraButtonComponent(controls)
              .setIcon("chevron-down")
              .setTooltip("Move down")
              .setDisabled(index === items.length - 1)
              .onClick(() => definition.onReorder?.(index, index + 1));
          }
        }
        if (definition.onDelete) {
          const controls = element.querySelector<HTMLElement>(".setting-item-control");
          if (controls) {
            new ExtraButtonComponent(controls)
              .setIcon("trash")
              .setTooltip("Delete")
              .onClick(() => definition.onDelete?.(index));
          }
          element.addEventListener("keydown", (event) => {
            if (event.key === "Delete" || event.key === "Backspace") {
              event.preventDefault();
              definition.onDelete?.(index);
            }
          });
        }
      }
    });
    if (items.length === 0 && definition.type === "list" && definition.emptyState) {
      const empty = group.listEl.ownerDocument.createElement("div");
      empty.className = "setting-list-empty";
      replaceElementContent(empty, definition.emptyState);
      group.listEl.append(empty);
    }
    if (definition.search) {
      group.addSearch((search) => {
        search.setPlaceholder(definition.search?.placeholder ?? "Search").onChange((query) => {
          items.forEach((item, index) => {
            const searchable = !isSettingPageDefinition(item)
              ? resolveSettingFlag(item.searchable, true)
              : true;
            const renderedItem = renderedItems[index];
            if (!renderedItem) return;
            renderedItem.hidden =
              searchable &&
              query.length > 0 &&
              !definition.search?.match(item as SettingDefinitionLike, query);
          });
        });
      });
    }
    this.domStateBindings.push({ element: group.listEl, visible: definition.visible });
  }

  private renderSettingDefinition(
    group: SettingGroup,
    definition: SettingDefinitionLike,
    index: number,
  ): Setting {
    const setting = new Setting(group.listEl).setName(definition.name);
    if (definition.desc) setting.setDesc(definition.desc);
    const searchText = settingSearchText(definition);
    setting.settingEl.dataset.settingSearch = searchText;
    setting.settingEl.dataset.settingName = definition.name;
    setting.settingEl.dataset.settingSearchable = String(
      resolveSettingFlag(definition.searchable, true),
    );
    if (definition.control) {
      this.renderControl(setting, definition.control);
    } else if (definition.render) {
      const cleanup = definition.render(setting, group);
      if (typeof cleanup === "function") this.definitionCleanups.push(cleanup);
    } else if (definition.action) {
      setting.settingEl.classList.add("setting-item-action");
      setting.settingEl.tabIndex = 0;
      setting.settingEl.setAttribute("role", "button");
      const invoke = () => definition.action?.(setting.settingEl, index);
      setting.settingEl.addEventListener("click", invoke);
      setting.settingEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          invoke();
        }
      });
    }
    this.domStateBindings.push({
      disabled: definition.control?.disabled ?? definition.disabled,
      element: setting.settingEl,
      setting,
      visible: definition.visible,
    });
    return setting;
  }

  private renderControl(setting: Setting, control: SettingControlLike): void {
    const value = this.getControlValue(control.key) ?? this.defaultControlValue(control);
    const persist = async (candidate: unknown): Promise<void> => {
      const message = control.validate ? await control.validate(candidate as never) : undefined;
      if (message) {
        setting.setErrorMessage(message);
        return;
      }
      setting.setErrorMessage(null);
      await this.setControlValue(control.key, candidate);
      this.refreshDomState();
    };
    const validateSeed = () => {
      if (!control.validate) return;
      void Promise.resolve(control.validate(value as never)).then((message) => {
        setting.setErrorMessage(message || null);
      });
    };
    switch (control.type) {
      case "toggle":
        setting.addToggle((component) =>
          component.setValue(Boolean(value)).onChange((next) => void persist(next)),
        );
        break;
      case "dropdown":
        setting.addDropdown((component) =>
          component
            .addOptions(control.options ?? {})
            .setValue(String(value))
            .onChange((next) => void persist(next)),
        );
        break;
      case "textarea":
        setting.addTextArea((component) => {
          component.setValue(String(value)).setPlaceholder(control.placeholder ?? "");
          if (control.rows !== undefined) component.inputEl.rows = control.rows;
          component.onChange((next) => void persist(next));
        });
        break;
      case "number":
        setting.addText((component) => {
          component.inputEl.type = "number";
          component.inputEl.min = control.min === undefined ? "" : String(control.min);
          component.inputEl.max = control.max === undefined ? "" : String(control.max);
          component.inputEl.step = control.step === undefined ? "" : String(control.step);
          component.setValue(String(value)).setPlaceholder(control.placeholder ?? "");
          component.onChange((next) => {
            const parsed = Number(next);
            void persist(Number.isFinite(parsed) ? parsed : (control.defaultValue ?? 0));
          });
        });
        break;
      case "slider":
        setting.addSlider((component) => {
          component
            .setLimits(control.min ?? 0, control.max ?? 100, control.step ?? 1)
            .setValue(Number(value));
          if (control.displayFormat) component.setDisplayFormat(control.displayFormat);
          component.onChange((next) => void persist(next));
        });
        break;
      case "color":
        setting.addColorPicker((component) =>
          component.setValue(String(value)).onChange((next) => void persist(next)),
        );
        break;
      case "secret": {
        const reference = typeof value === "string" ? value : "";
        const secret = reference ? this.app.secretStorage.getSecret(reference) : null;
        const component = new SecretComponent(this.app, setting.controlEl).setValue(secret ?? "");
        setting.components.push(component);
        component.onChange((next) => {
          if (next === null) return;
          const secretId = reference || this.secretIdForKey(control.key);
          this.app.secretStorage.setSecret(secretId, next);
          void persist(secretId);
        });
        break;
      }
      case "file":
      case "folder":
      case "text":
      default:
        setting.addText((component) =>
          component
            .setValue(String(value))
            .setPlaceholder(control.placeholder ?? "")
            .onChange((next) => void persist(next)),
        );
        break;
    }
    validateSeed();
  }

  private defaultControlValue(control: SettingControlLike): unknown {
    if (control.defaultValue !== undefined) return control.defaultValue;
    if (control.type === "toggle") return false;
    if (control.type === "number" || control.type === "slider") return 0;
    return "";
  }

  protected secretIdForKey(key: string): string {
    return `threadleaf-${key}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "");
  }

  private renderPageLink(
    container: HTMLElement,
    definition: SettingPageDefinitionLike,
  ): HTMLElement {
    const group = new SettingGroup(container);
    const setting = new Setting(group.listEl).setName(definition.name);
    if (definition.desc) setting.setDesc(definition.desc);
    setting.settingEl.classList.add("setting-item-page");
    setting.settingEl.tabIndex = 0;
    setting.settingEl.setAttribute("role", "button");
    const displayValue =
      typeof definition.displayValue === "function"
        ? definition.displayValue()
        : definition.displayValue;
    if (displayValue) setting.addDisplayValue((component) => component.setValue(displayValue));
    const status =
      typeof definition.status === "function" ? definition.status() : definition.status;
    if (status) setting.settingEl.dataset.status = status;
    setting.addExtraButton((button) => button.setIcon("chevron-right").setTooltip("Open"));
    const open = () => {
      this.selectedPage = definition;
      this.renderSettingDefinitions();
    };
    setting.settingEl.addEventListener("click", open);
    setting.settingEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    this.domStateBindings.push({ element: setting.settingEl, visible: definition.visible });
    return setting.settingEl;
  }

  private renderPage(definition: SettingPageDefinitionLike): void {
    const header = this.containerEl.ownerDocument.createElement("div");
    header.className = "setting-page-titlebar";
    const back = this.containerEl.ownerDocument.createElement("button");
    back.type = "button";
    back.className = "clickable-icon setting-page-back";
    back.setAttribute("aria-label", "Back");
    setElementIcon(back, "arrow-left");
    const title = this.containerEl.ownerDocument.createElement("h2");
    title.textContent = definition.name;
    header.append(back, title);
    this.containerEl.append(header);
    back.addEventListener("click", () => {
      this.selectedPage = null;
      this.renderSettingDefinitions();
    });
    if (definition.items) {
      this.renderDefinitionItems(this.containerEl, definition.items);
    } else if (definition.page) {
      const page = definition.page();
      page.title = definition.name;
      page.display();
      this.containerEl.append(page.rootEl);
      this.definitionCleanups.push(() => page.hide());
    }
    this.refreshDomState();
  }
}

export class PluginSettingTab extends SettingTab {
  readonly plugin: Plugin;

  constructor(app: App, plugin: Plugin) {
    super(app);
    this.plugin = plugin;
  }

  override getSettingDefinitions(): unknown[] {
    return super.getSettingDefinitions();
  }

  override getControlValue(key: string): unknown {
    const settings = (this.plugin as Plugin & { settings?: unknown }).settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return undefined;
    }
    return (settings as Record<string, unknown>)[key];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const plugin = this.plugin as Plugin & { settings?: unknown };
    const settings = plugin.settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      throw new Error(
        `Plugin ${this.plugin.manifest.id} settings must be an object before a control can be written.`,
      );
    }
    (settings as Record<string, unknown>)[key] = value;
    await this.plugin.saveData(settings);
  }

  protected override secretIdForKey(key: string): string {
    return `${this.plugin.manifest.id}-${key}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "");
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

export class WorkspaceLeaf extends WorkspaceItem {
  readonly app: App;
  readonly containerEl: HTMLElement;
  readonly id: string;
  readonly tabHeaderInnerIconEl: HTMLElement;
  readonly tabHeaderInnerTitleEl: HTMLElement;
  view: View | null = null;
  hoverPopover: null = null;
  parent: WorkspaceTabs | null = null;
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
    const compatibilityExtension = file.path.toLocaleLowerCase("en-US").endsWith(".excalidraw.md")
      ? "excalidraw"
      : file.extension;
    const viewType =
      this.app.compatibility.getViewTypeForExtension(compatibilityExtension) ??
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
    this.app.workspace.setLeafGroupId(this, group);
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

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  get headerEl(): HTMLElement {
    return this.viewHeaderEl;
  }

  override getDisplayText(): string {
    return this.file?.basename ?? "No file";
  }

  override onload(): void {}

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

export interface HoverParent {
  hoverPopover: HoverPopover | null;
}

export interface Point {
  x: number;
  y: number;
}

export enum PopoverState {
  Showing,
  Shown,
  Hiding,
  Hidden,
}

export class HoverPopover extends Component {
  readonly hoverEl: HTMLElement;
  state = PopoverState.Showing;
  private readonly parent: HoverParent;
  private readonly targetEl: HTMLElement | null;
  private readonly waitTime: number;
  private readonly staticPos: Point | null;
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private onTarget = true;
  private onHover = false;
  private isFocused = false;

  constructor(
    parent: HoverParent,
    targetEl: HTMLElement | null,
    waitTime = 300,
    staticPos: Point | null = null,
  ) {
    super();
    this.parent = parent;
    this.targetEl = targetEl;
    this.waitTime = Math.max(0, waitTime);
    this.staticPos = staticPos;
    const ownerDocument = targetEl?.ownerDocument ?? currentDocument();
    this.hoverEl = ownerDocument.createElement("div");
    this.hoverEl.className = "popover hover-popover";
    this.hoverEl.addEventListener("mouseover", () => {
      this.onHover = true;
      this.transition();
    });
    this.hoverEl.addEventListener("mouseout", () => {
      this.onHover = false;
      this.transition();
    });
    if (targetEl) {
      targetEl.addEventListener("mouseover", this.handleTargetIn);
      targetEl.addEventListener("mouseout", this.handleTargetOut);
    }
    this.timer = globalThis.setTimeout(() => this.show(), this.waitTime);
  }

  show(): void {
    if (this.state === PopoverState.Hidden) return;
    if (this.targetEl && !this.targetEl.ownerDocument.body.contains(this.targetEl)) {
      this.hide();
      return;
    }
    this.clearTimer();
    this.state = PopoverState.Shown;
    this.parent.hoverPopover?.hide();
    this.parent.hoverPopover = this;
    const body = this.hoverEl.ownerDocument.body;
    if (body && !body.contains(this.hoverEl)) body.append(this.hoverEl);
    this.position();
    this.onShow();
    this.load();
  }

  hide(): void {
    if (this.state === PopoverState.Hidden) return;
    this.clearTimer();
    this.state = PopoverState.Hidden;
    this.onTarget = false;
    this.onHover = false;
    this.hoverEl.remove();
    if (this.targetEl) {
      this.targetEl.removeEventListener("mouseover", this.handleTargetIn);
      this.targetEl.removeEventListener("mouseout", this.handleTargetOut);
    }
    if (this.parent.hoverPopover === this) this.parent.hoverPopover = null;
    this.onHide();
    this.unload();
  }

  setIsFocused(focused: boolean): void {
    this.isFocused = focused;
    this.transition();
  }

  protected onShow(): void {}

  protected onHide(): void {}

  private readonly handleTargetIn = (): void => {
    this.onTarget = true;
    this.transition();
  };

  private readonly handleTargetOut = (): void => {
    this.onTarget = false;
    this.transition();
  };

  private transition(): void {
    if (this.onTarget || this.onHover || this.isFocused) {
      if (this.state === PopoverState.Hiding) this.state = PopoverState.Shown;
      return;
    }
    if (this.state === PopoverState.Showing) {
      this.hide();
      return;
    }
    if (this.state === PopoverState.Shown) {
      this.state = PopoverState.Hiding;
      this.timer = globalThis.setTimeout(() => {
        if (!this.onTarget && !this.onHover && !this.isFocused) this.hide();
        else this.transition();
      }, this.waitTime);
    }
  }

  private position(): void {
    const position = this.staticPos ?? this.targetEl?.getBoundingClientRect();
    if (!position) return;
    const top = "top" in position ? position.top : position.y;
    const left = "left" in position ? position.left : position.x;
    this.hoverEl.style.position = "fixed";
    this.hoverEl.style.top = `${top}px`;
    this.hoverEl.style.left = `${left}px`;
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    globalThis.clearTimeout(this.timer);
    this.timer = null;
  }
}

export abstract class EditableFileView extends FileView {}

export class TextFileView extends EditableFileView {
  data = "";
  requestSave = (): void => {
    if (this.requestSaveTimer !== null) {
      globalThis.clearTimeout(this.requestSaveTimer);
    }
    this.requestSaveTimer = globalThis.setTimeout(() => {
      this.requestSaveTimer = null;
      void this.enqueueRequestedSave().catch(() => undefined);
    }, 250);
  };

  private requestSaveTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private requestSaveTail: Promise<void> = Promise.resolve();
  private requestSaveFailure: unknown = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  override async onLoadFile(file: TFile): Promise<void> {
    this.file = file;
    this.data = await this.app.vault.read(file);
    this.setViewData(this.data, true);
  }

  override async onUnloadFile(file: TFile): Promise<void> {
    await this.flushRequestedSave();
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

  private enqueueRequestedSave(): Promise<void> {
    const requested = this.requestSaveTail.then(() => this.save(false));
    this.requestSaveTail = requested.then(
      () => {
        this.requestSaveFailure = null;
      },
      (error: unknown) => {
        this.requestSaveFailure = error;
      },
    );
    return requested;
  }

  private async flushRequestedSave(): Promise<void> {
    if (this.requestSaveTimer !== null) {
      globalThis.clearTimeout(this.requestSaveTimer);
      this.requestSaveTimer = null;
      await this.enqueueRequestedSave();
    } else {
      await this.requestSaveTail;
    }
    if (this.requestSaveFailure) {
      throw this.requestSaveFailure;
    }
  }
}

export interface EditorPosition {
  ch: number;
  line: number;
}

export interface EditorRange {
  from: EditorPosition;
  to: EditorPosition;
}

export interface EditorRangeOrCaret {
  from: EditorPosition;
  to?: EditorPosition;
}

export interface EditorSelection {
  anchor: EditorPosition;
  head: EditorPosition;
}

export interface EditorSelectionOrCaret {
  anchor: EditorPosition;
  head?: EditorPosition;
}

export interface EditorChange extends EditorRangeOrCaret {
  text: string;
}

export interface EditorTransaction {
  replaceSelection?: string;
  changes?: EditorChange[];
  selections?: EditorRangeOrCaret[];
  selection?: EditorRangeOrCaret;
}

export type EditorCommandName =
  | "goUp"
  | "goDown"
  | "goLeft"
  | "goRight"
  | "goStart"
  | "goEnd"
  | "goWordLeft"
  | "goWordRight"
  | "indentMore"
  | "indentLess"
  | "newlineAndIndent"
  | "swapLineUp"
  | "swapLineDown"
  | "deleteLine"
  | "toggleFold"
  | "foldAll"
  | "unfoldAll";

export class Editor {
  editorComponent: MarkdownView | null = null;
  private anchor = 0;
  private focused = false;
  private head = 0;
  private mainSelectionIndex = 0;
  private selections: Array<{ anchor: number; head: number }> = [{ anchor: 0, head: 0 }];
  private scrollLeft = 0;
  private scrollTop = 0;
  private readonly undoStack: string[] = [];
  private readonly redoStack: string[] = [];
  private readonly onChange: (value: string) => void;
  private value = "";

  constructor(onChange: (value: string) => void = () => undefined) {
    this.onChange = onChange;
  }

  getDoc(): this {
    return this;
  }

  refresh(): void {
    // The compatibility editor has no separate display buffer to refresh.
  }

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.replaceValue(value, true, true);
  }

  syncValue(value: string): void {
    this.replaceValue(value, false, false);
  }

  setLine(line: number, text: string): void {
    const lines = this.value.split("\n");
    if (line < 0 || line >= lines.length) return;
    const start = { line, ch: 0 };
    const end = { line, ch: lines[line]?.length ?? 0 };
    this.replaceRange(text, start, end);
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
    this.replaceRangeValue(from, to, replacement, true);
  }

  replaceRange(replacement: string, from: EditorPosition, to: EditorPosition = from): void {
    this.replaceRangeValue(this.posToOffset(from), this.posToOffset(to), replacement, true);
  }

  getRange(from: EditorPosition, to: EditorPosition): string {
    const start = this.posToOffset(from);
    const end = this.posToOffset(to);
    return this.value.slice(Math.min(start, end), Math.max(start, end));
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

  listSelections(): EditorSelection[] {
    return this.selections.map(({ anchor, head }) => ({
      anchor: this.offsetToPos(anchor),
      head: this.offsetToPos(head),
    }));
  }

  setCursor(position: EditorPosition | number, ch?: number): void {
    const resolved = typeof position === "number" ? { line: position, ch: ch ?? 0 } : position;
    const offset = this.posToOffset(resolved);
    this.anchor = offset;
    this.head = offset;
    this.selections = [{ anchor: offset, head: offset }];
    this.mainSelectionIndex = 0;
  }

  setSelection(anchor: EditorPosition, head: EditorPosition = anchor): void {
    this.anchor = this.posToOffset(anchor);
    this.head = this.posToOffset(head);
    this.selections = [{ anchor: this.anchor, head: this.head }];
    this.mainSelectionIndex = 0;
  }

  setSelections(ranges: EditorSelectionOrCaret[], main = 0): void {
    if (ranges.length === 0) {
      this.setSelection(this.offsetToPos(this.head));
      return;
    }
    this.selections = ranges.map(({ anchor, head }) => ({
      anchor: this.posToOffset(anchor),
      head: this.posToOffset(head ?? anchor),
    }));
    this.mainSelectionIndex = Math.max(0, Math.min(Math.trunc(main), this.selections.length - 1));
    this.syncPrimarySelection();
  }

  setSelectionOffsets(anchor: number, head: number): void {
    this.anchor = this.clampOffset(anchor);
    this.head = this.clampOffset(head);
    this.selections = [{ anchor: this.anchor, head: this.head }];
    this.mainSelectionIndex = 0;
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

  blur(): void {
    this.focused = false;
  }

  hasFocus(): boolean {
    return this.focused;
  }

  getScrollInfo(): { top: number; left: number } {
    return { top: this.scrollTop, left: this.scrollLeft };
  }

  scrollTo(x?: number | null, y?: number | null): void {
    if (x !== undefined && x !== null) this.scrollLeft = Math.max(0, x);
    if (y !== undefined && y !== null) this.scrollTop = Math.max(0, y);
  }

  scrollIntoView(range: EditorRange, _center = false): void {
    this.scrollTop = Math.max(0, range.from.line);
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (previous === undefined) return;
    this.redoStack.push(this.value);
    this.replaceValue(previous, true, false);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.value);
    this.replaceValue(next, true, false);
  }

  exec(command: EditorCommandName): void {
    const cursor = this.getCursor("head");
    switch (command) {
      case "goLeft":
        this.setCursor(this.offsetToPos(Math.max(0, this.head - 1)));
        return;
      case "goRight":
        this.setCursor(this.offsetToPos(Math.min(this.value.length, this.head + 1)));
        return;
      case "goStart":
        this.setCursor({ line: cursor.line, ch: 0 });
        return;
      case "goEnd":
        this.setCursor({ line: cursor.line, ch: this.getLine(cursor.line).length });
        return;
      case "goUp":
        this.setCursor({ line: Math.max(0, cursor.line - 1), ch: cursor.ch });
        return;
      case "goDown":
        this.setCursor({ line: Math.min(this.lastLine(), cursor.line + 1), ch: cursor.ch });
        return;
      case "goWordLeft": {
        let offset = this.head;
        while (offset > 0 && !this.isWordCharacter(this.value[offset - 1] ?? "")) offset -= 1;
        while (offset > 0 && this.isWordCharacter(this.value[offset - 1] ?? "")) offset -= 1;
        this.setCursor(this.offsetToPos(offset));
        return;
      }
      case "goWordRight": {
        let offset = this.head;
        while (offset < this.value.length && !this.isWordCharacter(this.value[offset] ?? "")) {
          offset += 1;
        }
        while (offset < this.value.length && this.isWordCharacter(this.value[offset] ?? "")) {
          offset += 1;
        }
        this.setCursor(this.offsetToPos(offset));
        return;
      }
      case "deleteLine": {
        const start = { line: cursor.line, ch: 0 };
        const end =
          cursor.line < this.lastLine()
            ? { line: cursor.line + 1, ch: 0 }
            : { line: cursor.line, ch: this.getLine(cursor.line).length };
        this.replaceRange("", start, end);
        return;
      }
      case "newlineAndIndent":
        this.replaceSelection(`\n${this.getLine(cursor.line).match(/^\s*/u)?.[0] ?? ""}`);
        return;
      case "indentMore":
        this.replaceRange(
          `  ${this.getLine(cursor.line)}`,
          { line: cursor.line, ch: 0 },
          {
            line: cursor.line,
            ch: this.getLine(cursor.line).length,
          },
        );
        return;
      case "indentLess": {
        const line = this.getLine(cursor.line);
        const removed = line.startsWith("  ") ? 2 : line.startsWith("\t") ? 1 : 0;
        if (removed > 0)
          this.replaceRange(
            line.slice(removed),
            { line: cursor.line, ch: 0 },
            {
              line: cursor.line,
              ch: line.length,
            },
          );
        return;
      }
      case "swapLineUp":
      case "swapLineDown":
      case "toggleFold":
      case "foldAll":
      case "unfoldAll":
        return;
    }
  }

  transaction(transaction: EditorTransaction): void {
    let nextValue = this.value;
    const changes = transaction.changes ?? [];
    const resolvedChanges = changes
      .map((change) => ({
        from: this.posToOffset(change.from),
        to: this.posToOffset(change.to ?? change.from),
        text: change.text,
      }))
      .sort((left, right) => right.from - left.from);
    for (const change of resolvedChanges) {
      const from = Math.min(change.from, change.to);
      const to = Math.max(change.from, change.to);
      nextValue = `${nextValue.slice(0, from)}${change.text}${nextValue.slice(to)}`;
    }
    if (transaction.replaceSelection !== undefined && changes.length === 0) {
      const from = Math.min(this.anchor, this.head);
      const to = Math.max(this.anchor, this.head);
      nextValue = `${nextValue.slice(0, from)}${transaction.replaceSelection}${nextValue.slice(to)}`;
    }
    if (nextValue !== this.value) {
      this.replaceValue(nextValue, true, true);
    }
    if (transaction.selections) {
      this.setSelections(
        transaction.selections.map(({ from, to }) => ({ anchor: from, head: to ?? from })),
      );
    } else if (transaction.selection) {
      this.setSelection(transaction.selection.from, transaction.selection.to);
    }
  }

  wordAt(position: EditorPosition): EditorRange | null {
    let offset = this.posToOffset(position);
    if (offset === this.value.length && offset > 0) offset -= 1;
    if (!this.isWordCharacter(this.value[offset] ?? "")) return null;
    let from = offset;
    let to = offset + 1;
    while (from > 0 && this.isWordCharacter(this.value[from - 1] ?? "")) from -= 1;
    while (to < this.value.length && this.isWordCharacter(this.value[to] ?? "")) to += 1;
    return { from: this.offsetToPos(from), to: this.offsetToPos(to) };
  }

  processLines<T>(
    read: (line: number, lineText: string) => T | null,
    write: (line: number, lineText: string, value: T | null) => EditorChange | undefined,
    ignoreEmpty = false,
  ): void {
    const changes: EditorChange[] = [];
    for (const [line, lineText] of this.value.split("\n").entries()) {
      if (ignoreEmpty && lineText.length === 0) continue;
      const change = write(line, lineText, read(line, lineText));
      if (change) changes.push(change);
    }
    if (changes.length > 0) this.transaction({ changes });
  }

  private clampOffset(offset: number): number {
    return Math.max(0, Math.min(Math.trunc(offset), this.value.length));
  }

  private replaceRangeValue(from: number, to: number, replacement: string, notify: boolean): void {
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    const next = `${this.value.slice(0, start)}${replacement}${this.value.slice(end)}`;
    this.replaceValue(next, notify, true);
    const cursor = start + replacement.length;
    this.anchor = cursor;
    this.head = cursor;
    this.selections = [{ anchor: cursor, head: cursor }];
    this.mainSelectionIndex = 0;
  }

  private replaceValue(value: string, notify: boolean, recordHistory: boolean): void {
    if (recordHistory && value !== this.value) {
      this.undoStack.push(this.value);
      this.redoStack.length = 0;
    }
    this.value = value;
    this.anchor = this.clampOffset(this.anchor);
    this.head = this.clampOffset(this.head);
    this.selections = this.selections.map(({ anchor, head }) => ({
      anchor: this.clampOffset(anchor),
      head: this.clampOffset(head),
    }));
    this.syncPrimarySelection();
    if (notify) {
      this.onChange(this.value);
    }
  }

  private syncPrimarySelection(): void {
    const selection = this.selections[this.mainSelectionIndex] ?? { anchor: 0, head: 0 };
    this.anchor = selection.anchor;
    this.head = selection.head;
  }

  private isWordCharacter(value: string): boolean {
    return /^[\p{L}\p{N}_]$/u.test(value);
  }
}

export class MarkdownView extends TextFileView {
  readonly editor: Editor;
  readonly previewMode: MarkdownPreviewView;
  currentMode: MarkdownEditView | MarkdownPreviewView;
  hoverPopover: null = null;
  private mode: "source" | "preview" = "source";

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.editor = new Editor((value) => {
      this.data = value;
    });
    this.editor.editorComponent = this;
    const PreviewView = markdownPreviewViewConstructor;
    if (PreviewView === null) {
      throw new Error("MarkdownView preview constructor has not been registered.");
    }
    this.previewMode = new PreviewView(this.contentEl, this.app, this.file);
    this.currentMode = new MarkdownEditView(this);
  }

  override async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
    this.previewMode.setFile(file);
  }

  override async onUnloadFile(file: TFile): Promise<void> {
    await super.onUnloadFile(file);
    this.previewMode.setFile(this.app.createFile(""));
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

  getMode(): "source" | "preview" {
    return this.mode;
  }

  setMode(mode: "source" | "preview"): void {
    this.mode = mode;
    this.currentMode = mode === "preview" ? this.previewMode : new MarkdownEditView(this);
  }

  showSearch(replace = false): void {
    this.contentEl.dataset.searchMode = replace ? "replace" : "search";
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

export class MarkdownEditView {
  readonly app: App;
  hoverPopover: null = null;

  constructor(private readonly view: MarkdownView) {
    this.app = view.app;
  }

  clear(): void {
    this.view.clear();
  }

  get(): string {
    return this.view.getViewData();
  }

  set(data: string, clear: boolean): void {
    this.view.setViewData(data, clear);
  }

  get file(): TFile {
    return this.view.file ?? this.app.createFile("");
  }

  getSelection(): string {
    return this.view.editor.getSelection();
  }

  getScroll(): number {
    return this.view.editor.getScrollInfo().top;
  }

  applyScroll(scroll: number): void {
    if (Number.isFinite(scroll)) {
      this.view.editor.scrollTo(null, Math.max(0, scroll));
    }
  }
}

export { BaseComponent, Component };
