import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { BaseComponent, Component } from "./obsidian-components";

describe("Obsidian component compatibility", () => {
  it("loads children and releases child, event, DOM, and interval registrations", () => {
    const dom = new JSDOM("<!doctype html><button>Run</button>", {
      url: "https://threadleaf.invalid/",
    });
    const calls: string[] = [];
    class FixtureComponent extends Component {
      override onload(): void {
        calls.push("load");
      }

      override onunload(): void {
        calls.push("unload");
      }
    }
    const parent = new FixtureComponent();
    const child = parent.addChild(new FixtureComponent());
    const button = dom.window.document.querySelector("button");
    const clicked = vi.fn();
    expect(button).not.toBeNull();
    if (!button) {
      return;
    }
    parent.registerDomEvent(button, "click", clicked);
    const eventRef = { off: vi.fn() };
    parent.registerEvent(eventRef);
    const clearInterval = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    parent.registerInterval(42);

    parent.load();
    button.click();
    expect(calls).toEqual(["load", "load"]);
    expect(parent._loaded).toBe(true);
    expect(child._loaded).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);

    parent.unload();
    button.click();
    expect(calls).toEqual(["load", "load", "unload", "unload"]);
    expect(parent._loaded).toBe(false);
    expect(child._loaded).toBe(false);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(clearInterval).toHaveBeenCalledWith(42);
    expect(eventRef.off).toHaveBeenCalledTimes(1);
    expect(parent.removeChild(child)).toBe(child);
    clearInterval.mockRestore();
    dom.window.close();
  });

  it("keeps unloading resources after an unload hook fails", () => {
    const dispose = vi.fn();
    class FailingComponent extends Component {
      override onunload(): void {
        throw new Error("hook failed");
      }
    }
    const component = new FailingComponent();
    component.register(dispose);
    component.load();

    expect(() => component.unload()).toThrow("hook failed");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("supports the public BaseComponent chaining contract", () => {
    const component = new BaseComponent();
    const callback = vi.fn((value: BaseComponent) => value.setDisabled(true));

    expect(component.then(callback)).toBe(component);
    expect(component.disabled).toBe(true);
    expect(callback).toHaveBeenCalledWith(component);
  });
});
