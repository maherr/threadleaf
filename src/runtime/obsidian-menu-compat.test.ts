import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { Menu } from "./obsidian-menu-compat";

describe("Obsidian menu compatibility", () => {
  it("renders accessible items, state, separators, custom icons, and click dismissal", () => {
    const dom = new JSDOM("<!doctype html><body><main></main></body>", {
      url: "https://threadleaf.invalid/",
    });
    const parent = dom.window.document.querySelector("main");
    expect(parent).not.toBeNull();
    if (!parent) {
      return;
    }
    const selected = vi.fn();
    const hidden = vi.fn();
    const menu = new Menu((iconId) =>
      iconId === "threadleaf-custom" ? '<path d="M2 2h20v20H2z" />' : null,
    )
      .setParentElement(parent)
      .addItem((item) => item.setTitle("Drawing actions").setIsLabel(true))
      .addItem((item) =>
        item
          .setTitle("Open drawing")
          .setIcon("threadleaf-custom")
          .setSection("open")
          .onClick(selected),
      )
      .addItem((item) => item.setTitle("Auto-export").setChecked(true))
      .addSeparator()
      .addItem((item) => item.setTitle("Remove link").setWarning(true).setDisabled(true));
    menu.onHide(hidden);
    menu.showAtPosition({ x: 24, y: 30, width: 220 });

    const container = parent.querySelector<HTMLElement>(".threadleaf-compat-menu");
    const items = [...parent.querySelectorAll<HTMLButtonElement>(".menu-item")];
    expect(container?.getAttribute("role")).toBe("menu");
    expect(container?.style.width).toBe("220px");
    expect(items).toHaveLength(4);
    expect(items[0]?.classList.contains("is-label")).toBe(true);
    expect(items[1]?.dataset.section).toBe("open");
    expect(items[1]?.querySelector("svg")?.dataset.icon).toBe("threadleaf-custom");
    expect(items[2]?.getAttribute("role")).toBe("menuitemcheckbox");
    expect(items[2]?.getAttribute("aria-checked")).toBe("true");
    expect(items[3]?.disabled).toBe(true);
    expect(items[3]?.classList.contains("is-warning")).toBe(true);
    expect(parent.querySelectorAll('[role="separator"]')).toHaveLength(1);

    items[1]?.click();
    expect(selected).toHaveBeenCalledOnce();
    expect(hidden).toHaveBeenCalledOnce();
    expect(parent.querySelector(".threadleaf-compat-menu")).toBeNull();
    dom.window.close();
  });

  it("dismisses with Escape and wraps keyboard focus across enabled actions", () => {
    const dom = new JSDOM("<!doctype html><body></body>", {
      pretendToBeVisual: true,
      url: "https://threadleaf.invalid/",
    });
    const menu = new Menu()
      .addItem((item) => item.setTitle("First"))
      .addItem((item) => item.setTitle("Second"))
      .showAtPosition({ x: 10, y: 10 }, dom.window.document);
    const items = [...dom.window.document.querySelectorAll<HTMLButtonElement>(".menu-item")];
    expect(dom.window.document.activeElement).toBe(items[0]);

    items[0]?.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
    );
    expect(dom.window.document.activeElement).toBe(items[1]);
    items[1]?.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(dom.window.document.querySelector(".threadleaf-compat-menu")).toBeNull();
    menu.close();
    dom.window.close();
  });

  it("dismisses even when a plugin click callback throws", () => {
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    const reportedErrors: string[] = [];
    dom.window.addEventListener("error", (event) => {
      reportedErrors.push((event.error as Error).message);
      event.preventDefault();
    });
    new Menu()
      .addItem((item) =>
        item.setTitle("Failing action").onClick(() => {
          throw new Error("plugin callback failed");
        }),
      )
      .showAtPosition({ x: 10, y: 10 }, dom.window.document);
    const item = dom.window.document.querySelector<HTMLButtonElement>(".menu-item");
    item?.click();
    expect(reportedErrors).toEqual(["plugin callback failed"]);
    expect(dom.window.document.querySelector(".threadleaf-compat-menu")).toBeNull();
    dom.window.close();
  });

  it("removes an open menu when its component lifecycle unloads", () => {
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    const menu = new Menu().addItem((item) => item.setTitle("Lifecycle item"));
    menu.load();
    menu.showAtPosition({ x: 10, y: 10 }, dom.window.document);

    menu.unload();
    expect(dom.window.document.querySelector(".threadleaf-compat-menu")).toBeNull();
    dom.window.close();
  });

  it("projects bounded actionable items and awaits the selected callback before dismissal", async () => {
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    const selected: string[] = [];
    const hidden = vi.fn();
    const menu = new Menu()
      .addItem((item) => item.setTitle("Section").setIsLabel(true))
      .addItem((item) =>
        item
          .setTitle("Change icon")
          .setIcon("hashtag")
          .setSection("iconize")
          .onClick(async () => {
            await Promise.resolve();
            selected.push("changed");
          }),
      )
      .addSeparator()
      .addItem((item) => item.setTitle("Remove icon").setIcon("trash").setWarning(true));
    menu.onHide(hidden);

    expect(menu.projectItems("menu-7")).toEqual([
      {
        checked: null,
        disabled: false,
        icon: "hashtag",
        id: "menu-7:1",
        section: "iconize",
        title: "Change icon",
        warning: false,
      },
      {
        checked: null,
        disabled: false,
        icon: "trash",
        id: "menu-7:3",
        section: "",
        title: "Remove icon",
        warning: true,
      },
    ]);
    await menu.activateProjected("menu-7:1");
    expect(selected).toEqual(["changed"]);
    expect(hidden).toHaveBeenCalledOnce();
    dom.window.close();
  });
});
