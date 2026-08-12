import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  AbstractInputSuggest,
  type ButtonComponent,
  type DropdownComponent,
  Editor,
  Setting,
  type SliderComponent,
  type TextComponent,
  type ToggleComponent,
} from "./obsidian-ui-compat";

describe("Obsidian editor compatibility", () => {
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
