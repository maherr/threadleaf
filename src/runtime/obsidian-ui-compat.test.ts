import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import type { TFile } from "./obsidian-compat";
import {
  AbstractInputSuggest,
  type ButtonComponent,
  type ConfirmationButton,
  ConfirmationModal,
  type DropdownComponent,
  Editor,
  FuzzySuggestModal,
  SecretComponent,
  Setting,
  SettingGroup,
  SettingPage,
  SettingTab,
  type SliderComponent,
  type TextComponent,
  TextFileView,
  type ToggleComponent,
  type WorkspaceLeaf,
} from "./obsidian-ui-compat";

describe("Obsidian editor compatibility", () => {
  it("debounces TextFileView requestSave and flushes the pending bytes on unload", async () => {
    vi.useFakeTimers();
    const dom = new JSDOM("<!doctype html><body></body>");
    try {
      let content = "initial";
      const modify = vi.fn(async () => undefined);
      const leaf = {
        app: { vault: { modify } },
        containerEl: dom.window.document.createElement("div"),
        view: null,
      } as unknown as WorkspaceLeaf;
      class FixtureTextFileView extends TextFileView {
        override getViewData(): string {
          return content;
        }
      }
      const view = new FixtureTextFileView(leaf);
      const file = { path: "Data/record.json" } as TFile;
      view.file = file;

      content = "first";
      view.requestSave();
      content = "latest";
      view.requestSave();
      await vi.advanceTimersByTimeAsync(249);
      expect(modify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(modify).toHaveBeenCalledTimes(1);
      expect(modify).toHaveBeenLastCalledWith(file, "latest");

      content = "flush-on-unload";
      view.requestSave();
      await view.onUnloadFile(file);
      expect(modify).toHaveBeenCalledTimes(2);
      expect(modify).toHaveBeenLastCalledWith(file, "flush-on-unload");
      expect(view.file).toBeNull();
    } finally {
      vi.useRealTimers();
      dom.window.close();
    }
  });

  it("tracks selections, positions, replacement text, and focus", () => {
    const changes: string[] = [];
    const editor = new Editor((value) => changes.push(value));
    editor.syncValue("alpha\nbeta");
    editor.setSelection({ line: 0, ch: 2 }, { line: 1, ch: 2 });

    expect(editor.getSelection()).toBe("pha\nbe");
    expect(editor.getCursor("from")).toEqual({ line: 0, ch: 2 });
    expect(editor.getCursor("to")).toEqual({ line: 1, ch: 2 });
    editor.replaceSelection("X");

    expect(editor.getValue()).toBe("alXta");
    expect(editor.getSelectionOffsets()).toEqual({ anchor: 3, head: 3 });
    expect(editor.offsetToPos(editor.posToOffset({ line: 0, ch: 4 }))).toEqual({ line: 0, ch: 4 });
    expect(changes).toEqual(["alXta"]);
    expect(editor.hasFocus()).toBe(false);
    editor.focus();
    expect(editor.hasFocus()).toBe(true);
  });

  it("clamps external offsets to the current document", () => {
    const editor = new Editor();
    editor.syncValue("abc");
    editor.setSelectionOffsets(99, -4);
    expect(editor.getSelectionOffsets()).toEqual({ anchor: 3, head: 0 });
  });

  it("supports the public range, transaction, history, command, and line APIs", () => {
    const changes: string[] = [];
    const editor = new Editor((value) => changes.push(value));
    editor.syncValue("alpha beta\ngamma");

    expect(editor.getDoc()).toBe(editor);
    expect(editor.getRange({ line: 0, ch: 0 }, { line: 0, ch: 5 })).toBe("alpha");
    expect(editor.wordAt({ line: 0, ch: 2 })).toEqual({
      from: { line: 0, ch: 0 },
      to: { line: 0, ch: 5 },
    });
    editor.setLine(1, "delta");
    expect(editor.getValue()).toBe("alpha beta\ndelta");
    editor.undo();
    expect(editor.getValue()).toBe("alpha beta\ngamma");
    editor.redo();
    expect(editor.getValue()).toBe("alpha beta\ndelta");

    editor.setSelections(
      [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 5 } }, { anchor: { line: 1, ch: 0 } }],
      1,
    );
    expect(editor.listSelections()).toEqual([
      { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 5 } },
      { anchor: { line: 1, ch: 0 }, head: { line: 1, ch: 0 } },
    ]);
    expect(editor.getCursor()).toEqual({ line: 1, ch: 0 });

    editor.transaction({
      changes: [
        {
          from: { line: 0, ch: 6 },
          to: { line: 0, ch: 10 },
          text: "WORLD",
        },
      ],
      selection: { from: { line: 0, ch: 0 }, to: { line: 0, ch: 5 } },
    });
    expect(editor.getValue()).toBe("alpha WORLD\ndelta");
    expect(editor.getSelection()).toBe("alpha");

    editor.exec("goEnd");
    expect(editor.getCursor()).toEqual({ line: 0, ch: 11 });
    editor.exec("goStart");
    expect(editor.getCursor()).toEqual({ line: 0, ch: 0 });
    editor.scrollTo(4, 12);
    expect(editor.getScrollInfo()).toEqual({ left: 4, top: 12 });
    editor.scrollIntoView({ from: { line: 1, ch: 0 }, to: { line: 1, ch: 1 } });
    expect(editor.getScrollInfo()).toMatchObject({ top: 1, left: 4 });
    editor.focus();
    editor.blur();
    expect(editor.hasFocus()).toBe(false);

    editor.processLines(
      (_line, lineText) => lineText,
      (line, lineText) =>
        line === 0
          ? {
              from: { line, ch: 0 },
              to: { line, ch: lineText.length },
              text: lineText.toUpperCase(),
            }
          : undefined,
    );
    expect(editor.getValue()).toBe("ALPHA WORLD\ndelta");
    expect(changes).toContain("alpha WORLD\ndelta");
  });

  it("renders grouped settings and a disposable setting page", () => {
    const dom = new JSDOM("<!doctype html><body><main></main></body>", {
      url: "https://threadleaf.invalid/",
    });
    const container = dom.window.document.querySelector("main");
    expect(container).not.toBeNull();
    if (!container) {
      return;
    }

    let groupedSetting: Setting | null = null;
    let groupSearchValue = "";
    let extraClicks = 0;
    const group = new SettingGroup(container)
      .setHeading("Grouped settings")
      .addClass("fixture-group extra-class")
      .addSetting((setting) => {
        groupedSetting = setting.setName("Grouped row");
      })
      .addSearch((search) => {
        search.onChange((value) => {
          groupSearchValue = value;
        });
        search.setValue("filter");
        search.onChanged();
      })
      .addExtraButton((button) => {
        button.setIcon("x").onClick(() => {
          extraClicks += 1;
        });
        button.extraSettingsEl.click();
      });

    class FixturePage extends SettingPage {
      override display(): void {
        this.containerEl.textContent = "Page body";
      }
    }
    const page = (() => {
      vi.stubGlobal("document", dom.window.document);
      try {
        return new FixturePage();
      } finally {
        vi.unstubAllGlobals();
      }
    })();
    const renderedSetting = groupedSetting as unknown as Setting;
    page.title = "Fixture page";
    page.titlebarEl.textContent = page.title;
    page.display();

    expect(group.listEl.className).toBe("setting-group fixture-group extra-class");
    expect(group.listEl.firstElementChild?.textContent).toBe("Grouped settings");
    expect(renderedSetting.nameEl.textContent).toBe("Grouped row");
    expect(groupSearchValue).toBe("filter");
    expect(extraClicks).toBe(1);
    expect(page.rootEl.className).toBe("setting-page");
    expect(page.titlebarEl.textContent).toBe("Fixture page");
    expect(page.containerEl.textContent).toBe("Page body");
    page.hide();
    expect(page.containerEl.childElementCount).toBe(0);
    dom.window.close();
  });
});

describe("Obsidian settings compatibility", () => {
  it("builds standard setting rows and keeps controls interactive", () => {
    const dom = new JSDOM("<!doctype html><body><main></main></body>", {
      url: "https://threadleaf.invalid/",
    });
    const container = dom.window.document.querySelector("main");
    expect(container).not.toBeNull();
    if (!container) {
      return;
    }

    const dropdownChanged = vi.fn();
    const sliderChanged = vi.fn();
    const toggleChanged = vi.fn();
    const textChanged = vi.fn();
    const buttonClicked = vi.fn();
    let dropdown: DropdownComponent | null = null;
    let slider: SliderComponent | null = null;
    let toggle: ToggleComponent | null = null;
    let text: TextComponent | null = null;
    let button: ButtonComponent | null = null;

    const description = dom.window.document.createDocumentFragment();
    description.append("Current ");
    const strong = dom.window.document.createElement("strong");
    strong.textContent = "value";
    description.append(strong);

    const setting = new Setting(container)
      .setName("Export drawing")
      .setDesc(description)
      .setClass("fixture-setting")
      .setTooltip("Export options")
      .addDropdown((component) => {
        dropdown = component;
        component
          .addOption("all", "All elements")
          .addOption("selected", "Selected elements")
          .setValue("selected")
          .onChange(dropdownChanged);
      })
      .addSlider((component) => {
        slider = component;
        component.setLimits(0.2, 7, 0.1).setValue(2).onChange(sliderChanged);
      })
      .addToggle((component) => {
        toggle = component;
        component.setValue(true).onChange(toggleChanged);
      })
      .addText((component) => {
        text = component;
        component.setPlaceholder("Filename").setValue("Drawing").onChange(textChanged);
      })
      .addButton((component) => {
        button = component;
        component.setButtonText("Save").onClick(buttonClicked);
      });

    const dropdownControl = dropdown as DropdownComponent | null;
    const sliderControl = slider as SliderComponent | null;
    const toggleControl = toggle as ToggleComponent | null;
    const textControl = text as TextComponent | null;
    const buttonControl = button as ButtonComponent | null;
    if (!dropdownControl || !sliderControl || !toggleControl || !textControl || !buttonControl) {
      throw new Error("Setting callbacks did not receive their controls.");
    }

    expect(setting.settingEl.parentElement).toBe(container);
    expect(setting.nameEl.textContent).toBe("Export drawing");
    expect(setting.descEl.innerHTML).toBe("Current <strong>value</strong>");
    expect(setting.settingEl.classList.contains("fixture-setting")).toBe(true);
    expect(setting.settingEl.title).toBe("Export options");
    expect(setting.components).toHaveLength(5);
    expect(dropdownControl.getValue()).toBe("selected");
    expect(sliderControl.getValue()).toBe(2);
    expect(toggleControl.getValue()).toBe(true);
    expect(textControl.getValue()).toBe("Drawing");
    expect(buttonControl.buttonEl.classList.contains("mod-cta")).toBe(false);
    buttonControl.setCta();
    expect(buttonControl.buttonEl.classList.contains("mod-cta")).toBe(true);
    buttonControl.removeCta();
    expect(buttonControl.buttonEl.classList.contains("mod-cta")).toBe(false);

    dropdownControl.setValue("all");
    dropdownControl.selectEl.dispatchEvent(new dom.window.Event("change"));
    sliderControl.setValue(3);
    sliderControl.sliderEl.dispatchEvent(new dom.window.Event("input"));
    toggleControl.setValue(false);
    toggleControl.toggleEl.dispatchEvent(new dom.window.Event("change"));
    textControl.setValue("Updated");
    textControl.inputEl.dispatchEvent(new dom.window.Event("input"));
    buttonControl.buttonEl.click();

    expect(dropdownChanged).toHaveBeenCalledWith("all");
    expect(sliderChanged).toHaveBeenCalledWith(3);
    expect(toggleChanged).toHaveBeenCalledWith(false);
    expect(textChanged).toHaveBeenCalledWith("Updated");
    expect(buttonClicked).toHaveBeenCalledTimes(1);

    setting.setVisibility(false).setDisabled(true);
    expect(setting.settingEl.hidden).toBe(true);
    expect(setting.settingEl.classList.contains("is-disabled")).toBe(true);
    expect(dropdownControl.selectEl.disabled).toBe(true);
    expect(sliderControl.sliderEl.disabled).toBe(true);
    expect(toggleControl.toggleEl.disabled).toBe(true);
    expect(textControl.inputEl.disabled).toBe(true);
    expect(buttonControl.buttonEl.disabled).toBe(true);
    dom.window.close();
  });

  it("renders secret inputs and reports empty values as null", () => {
    const dom = new JSDOM("<!doctype html><body><main></main></body>", {
      url: "https://threadleaf.invalid/",
    });
    const container = dom.window.document.querySelector("main");
    expect(container).not.toBeNull();
    if (!container) {
      return;
    }

    const changes: Array<string | null> = [];
    const component = new SecretComponent({} as never, container).onChange((value) => {
      changes.push(value);
    });
    expect(component.inputEl.type).toBe("password");
    expect(component.inputEl.autocomplete).toBe("off");
    expect(component.inputEl.className).toBe("secret-input");
    component.setValue("opaque");
    component.inputEl.dispatchEvent(new dom.window.Event("input"));
    component.setValue("");
    component.inputEl.dispatchEvent(new dom.window.Event("input"));
    expect(changes).toEqual(["opaque", null]);
    dom.window.close();
  });
});

describe("Obsidian declarative settings compatibility", () => {
  it("renders controls, validates writes, refreshes predicates, and navigates pages", async () => {
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    vi.stubGlobal("document", dom.window.document);
    const values = new Map<string, unknown>([
      ["enabled", false],
      ["threshold", 2],
    ]);
    const writes: Array<[string, unknown]> = [];
    const app = {
      secretStorage: {
        getSecret: () => null,
        setSecret: vi.fn(),
      },
      vault: {
        getConfig: (key: string) => values.get(key),
        setConfig: (key: string, value: unknown) => {
          values.set(key, value);
          writes.push([key, value]);
        },
      },
    } as never;
    class FixtureTab extends SettingTab {
      override getSettingDefinitions(): unknown[] {
        return [
          {
            name: "Enable helpers",
            aliases: ["drawing"],
            control: { type: "toggle", key: "enabled" },
          },
          {
            name: "Canvas threshold",
            visible: () => values.get("enabled") === true,
            control: {
              type: "number",
              key: "threshold",
              validate: async (value: number) =>
                value < 1 || value > 8 ? "Choose a value from 1 to 8." : undefined,
            },
          },
          {
            type: "page",
            name: "Advanced canvas",
            items: [{ name: "Native renderer", control: { type: "toggle", key: "enabled" } }],
          },
        ];
      }
    }
    try {
      const tab = new FixtureTab(app);
      tab.update();
      tab.renderSettingDefinitions();
      const enabledRow = tab.containerEl.querySelector<HTMLElement>(
        '[data-setting-name="Enable helpers"]',
      );
      const thresholdRow = tab.containerEl.querySelector<HTMLElement>(
        '[data-setting-name="Canvas threshold"]',
      );
      expect(enabledRow?.dataset.settingSearch).toContain("drawing");
      expect(thresholdRow?.hidden).toBe(true);

      const enabledToggle = enabledRow?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!enabledToggle) return;
      enabledToggle.checked = true;
      enabledToggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      expect(writes).toContainEqual(["enabled", true]);
      expect(thresholdRow?.hidden).toBe(false);

      const thresholdInput = thresholdRow?.querySelector<HTMLInputElement>('input[type="number"]');
      expect(thresholdInput).not.toBeNull();
      if (!thresholdInput) return;
      thresholdInput.value = "12";
      thresholdInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      expect(thresholdRow?.querySelector(".setting-item-error")?.textContent).toBe(
        "Choose a value from 1 to 8.",
      );
      expect(writes).not.toContainEqual(["threshold", 12]);

      thresholdInput.value = "4";
      thresholdInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      expect(writes).toContainEqual(["threshold", 4]);
      expect(thresholdRow?.querySelector(".setting-item-error")).toBeNull();

      const pageRow = [...tab.containerEl.querySelectorAll<HTMLElement>(".setting-item-page")].find(
        (element) => element.textContent?.includes("Advanced canvas"),
      );
      pageRow?.click();
      expect(tab.containerEl.querySelector(".setting-page-titlebar")?.textContent).toContain(
        "Advanced canvas",
      );
      expect(tab.containerEl.querySelector('[data-setting-name="Native renderer"]')).not.toBeNull();
      tab.containerEl.querySelector<HTMLButtonElement>(".setting-page-back")?.click();
      expect(tab.containerEl.querySelector('[data-setting-name="Enable helpers"]')).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
      dom.window.close();
    }
  });
});

describe("Obsidian confirmation modal compatibility", () => {
  it("supports confirmation buttons, focus, secondary placement, and cancellation", async () => {
    const dom = new JSDOM("<!doctype html><body></body></html>", {
      url: "https://threadleaf.invalid/",
    });
    vi.stubGlobal("document", dom.window.document);
    let modal: ConfirmationModal | null = null;
    try {
      const app = {
        registerPluginModal: vi.fn(() => () => undefined),
      } as never;
      modal = new ConfirmationModal(app)
        .setTitle("Confirm action")
        .setContent("Body")
        .addClass("fixture-modal");
      const checkboxValues: boolean[] = [];
      let primary!: ConfirmationButton;
      let hold!: ConfirmationButton;
      modal.addCheckbox("Remember choice", (value) => checkboxValues.push(value));
      modal.addButton((button) => {
        primary = button
          .setButtonText("Proceed")
          .setInitialFocus()
          .onClick(() => undefined);
      });
      modal.addButton((button) => {
        hold = button
          .setButtonText("Hold")
          .setSecondary()
          .onClick(() => true);
      });
      modal.addCancelButton("Cancel");

      modal.open();
      const checkbox = modal.contentEl.querySelector("input");
      expect(checkbox).not.toBeNull();
      if (!checkbox) {
        return;
      }
      checkbox.checked = true;
      checkbox.dispatchEvent(new dom.window.Event("change"));

      expect(modal.modalEl.classList.contains("fixture-modal")).toBe(true);
      expect(document.activeElement).toBe(primary.buttonEl);
      expect(hold.buttonEl.parentElement).toBe(
        modal.modalEl.querySelector(".modal-button-container.mod-secondary"),
      );
      expect(modal.buttonContainerEl.querySelector("button")?.textContent).toBe("Proceed");
      expect(modal.buttonContainerEl.querySelectorAll("button")[1]?.textContent).toBe("Cancel");
      expect(modal.buttonContainerEl.querySelectorAll("button")[1]?.className).toBe("mod-warning");
      expect(checkboxValues).toEqual([true]);

      hold.buttonEl.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(modal.containerEl.isConnected).toBe(true);
      primary.buttonEl.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(modal.containerEl.isConnected).toBe(false);
    } finally {
      if (modal?.containerEl.isConnected) {
        modal.close();
      }
      vi.unstubAllGlobals();
      dom.window.close();
    }
  });
});

describe("Obsidian modal suggestion compatibility", () => {
  it("navigates and chooses fuzzy suggestions with the keyboard", async () => {
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    try {
      Object.assign(globalThis, {
        document: dom.window.document,
        window: dom.window,
      });
      const selected = vi.fn();
      class FixtureModal extends FuzzySuggestModal<string> {
        override getItems(): string[] {
          return ["Alpha", "Alpine", "Beta"];
        }

        override onChooseItem(item: string): void {
          selected(item);
        }
      }
      const modal = new FixtureModal({ registerPluginModal: () => () => undefined } as never);
      expect(modal.bgEl.style.zIndex).toBe("0");
      expect(modal.modalEl.style.position).toBe("relative");
      expect(modal.modalEl.style.zIndex).toBe("1");
      modal.open();
      modal.inputEl.value = "Al";
      modal.inputEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();

      expect(
        [...modal.resultContainerEl.querySelectorAll(".suggestion-item")].map(
          (element) => element.textContent,
        ),
      ).toEqual(["Alpha", "Alpine"]);
      expect(modal.resultContainerEl.querySelector(".is-selected")?.textContent).toBe("Alpha");
      modal.inputEl.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
      expect(modal.resultContainerEl.querySelector(".is-selected")?.textContent).toBe("Alpine");
      modal.inputEl.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      expect(selected).toHaveBeenCalledWith("Alpine");
      expect(modal.containerEl.isConnected).toBe(false);
    } finally {
      if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document");
      else globalThis.document = previousDocument;
      if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else globalThis.window = previousWindow;
      dom.window.close();
    }
  });
});

describe("Obsidian input suggestion compatibility", () => {
  it("renders, navigates, selects, and closes type-ahead suggestions", async () => {
    const dom = new JSDOM("<!doctype html><body><input></body>", {
      url: "https://threadleaf.invalid/",
    });
    const input = dom.window.document.querySelector("input");
    expect(input).not.toBeNull();
    if (!input) {
      return;
    }
    const selected = vi.fn();
    class FixtureSuggest extends AbstractInputSuggest<string> {
      protected override getSuggestions(query: string): string[] {
        return ["Alpha", "Alpine", "Beta"].filter((value) =>
          value.toLowerCase().startsWith(query.toLowerCase()),
        );
      }

      override renderSuggestion(value: string, element: HTMLElement): void {
        element.textContent = value;
      }
    }
    const suggest = new FixtureSuggest({} as never, input).onSelect(selected);
    suggest.limit = 2;
    suggest.setValue("Al");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await Promise.resolve();

    const suggestionItems = [...dom.window.document.querySelectorAll(".suggestion-item")];
    expect(suggestionItems.map((element) => element.textContent)).toEqual(["Alpha", "Alpine"]);
    expect(suggestionItems[0]?.classList.contains("is-selected")).toBe(true);

    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" }));
    expect(selected).toHaveBeenCalledWith("Alpine", expect.any(dom.window.KeyboardEvent));
    expect(dom.window.document.querySelector(".suggestion-container")).toBeNull();
    dom.window.close();
  });
});
