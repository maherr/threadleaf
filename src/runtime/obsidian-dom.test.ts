import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { installObsidianDomCompatibility } from "./obsidian-dom";

interface TestElement extends HTMLDivElement {
  addClass(...classes: string[]): void;
  addClasses(classes: string[]): void;
  removeClass(...classes: string[]): void;
  toggleClass(className: string, value: boolean): void;
  hasClass(className: string): boolean;
  setAttrs(attributes: Record<string, string | number | null>): void;
  getAttr(name: string): string | null;
  getText(): string;
  setText(value: string): void;
  empty(): void;
  createDiv(
    options?: string | { cls?: string | string[]; text?: string; prepend?: boolean } | null,
  ): TestElement;
  createSpan(options?: string | { text?: string } | null): HTMLSpanElement;
  on(eventType: string, selector: string, listener: (event: Event, target: Element) => void): void;
  off(eventType: string, selector: string, listener: (event: Event, target: Element) => void): void;
  show(): void;
  hide(): void;
  toggleVisibility(visible: boolean): void;
  setCssProps(properties: Record<string, string>): void;
  setCssStyles(styles: Partial<CSSStyleDeclaration>): void;
}

describe("Obsidian DOM compatibility", () => {
  it("installs idempotent class, content, attribute, and creation helpers", () => {
    const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", {
      url: "https://threadleaf.invalid/",
    });
    installObsidianDomCompatibility(dom.window);
    installObsidianDomCompatibility(dom.window);
    const root = dom.window.document.querySelector<TestElement>("#root");
    expect(root).not.toBeNull();

    root?.addClass("alpha beta");
    root?.addClasses(["gamma", "delta"]);
    root?.removeClass("beta");
    root?.toggleClass("selected", true);
    expect(root?.hasClass("alpha")).toBe(true);
    expect(root?.className).toBe("alpha gamma delta selected");

    root?.setAttrs({ role: "region", tabindex: 0, title: null });
    expect(root?.getAttr("role")).toBe("region");
    expect(root?.getAttr("tabindex")).toBe("0");
    expect(root?.getAttr("title")).toBeNull();

    root?.setText("existing");
    const appended = root?.createDiv({ cls: ["card", "active"], text: "card" });
    const prepended = root?.createSpan({ text: "first" });
    root?.prepend(prepended ?? "");
    expect(root?.getText()).toBe("firstexistingcard");
    expect(appended?.className).toBe("card active");
    root?.empty();
    expect(root?.childElementCount).toBe(0);
  });

  it("supports delegated events, visibility, and inline style helpers", () => {
    const dom = new JSDOM(
      "<!doctype html><body><div id='root'><button class='action'>Go</button></div></body>",
      { url: "https://threadleaf.invalid/" },
    );
    installObsidianDomCompatibility(dom.window);
    const root = dom.window.document.querySelector<TestElement>("#root");
    const button = root?.querySelector<HTMLButtonElement>("button");
    const listener = vi.fn();

    root?.on("click", ".action", listener);
    button?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(listener).toHaveBeenCalledWith(expect.any(dom.window.Event), button);
    root?.off("click", ".action", listener);
    button?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(listener).toHaveBeenCalledTimes(1);

    root?.hide();
    expect(root?.hidden).toBe(true);
    expect(root?.classList.contains("is-hidden")).toBe(true);
    root?.toggleVisibility(true);
    expect(root?.hidden).toBe(false);
    root?.setCssProps({ "--accent": "#0072b2" });
    root?.setCssStyles({ paddingInline: "12px" });
    expect(root?.style.getPropertyValue("--accent")).toBe("#0072b2");
    expect(root?.style.paddingInline).toBe("12px");
  });
});
