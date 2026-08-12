import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  debounce,
  htmlToMarkdown,
  Platform,
  prepareFuzzySearch,
  setTooltip,
} from "./obsidian-compat";

const previousGlobals = new Map<string, PropertyDescriptor | undefined>();

function exposeDom(dom: JSDOM): void {
  for (const [name, value] of Object.entries({
    DOMParser: dom.window.DOMParser,
    document: dom.window.document,
    window: dom.window,
  })) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  }
}

afterEach(() => {
  vi.useRealTimers();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
  previousGlobals.clear();
});

describe("Obsidian public utility compatibility", () => {
  it("returns deterministic fuzzy scores and UTF-16 highlight ranges", () => {
    const drawingSearch = prepareFuzzySearch("dng");
    expect(drawingSearch("Drawing")?.matches).toEqual([
      [0, 1],
      [5, 7],
    ]);
    expect(drawingSearch("Diagram")).toBeNull();

    const contiguous = prepareFuzzySearch("ab");
    expect(contiguous("a---ab")?.matches).toEqual([[4, 6]]);
    expect(contiguous("ab")?.score).toBeGreaterThan(contiguous("a b")?.score ?? 0);

    expect(prepareFuzzySearch("🧵l")("🧵 Threadleaf")?.matches).toEqual([
      [0, 2],
      [9, 10],
    ]);
    expect(prepareFuzzySearch("")("Anything")).toEqual({ score: 0, matches: [] });
  });

  it("converts HTML strings and DOM fragments to stable Markdown", () => {
    const dom = new JSDOM("<!doctype html><body></body>", {
      url: "https://threadleaf.invalid/",
    });
    exposeDom(dom);
    const html =
      '<h2>Settings</h2><p><strong>Bold</strong> and <a href="/guide">Guide</a></p><ul><li>One</li><li>Two</li></ul>';
    expect(htmlToMarkdown(html)).toBe(
      "## Settings\n\n**Bold** and [Guide](/guide)\n\n-   One\n-   Two",
    );

    const fragment = dom.window.document.createDocumentFragment();
    const heading = dom.window.document.createElement("h3");
    heading.textContent = "Copied section";
    fragment.append(heading);
    expect(htmlToMarkdown(fragment)).toBe("### Copied section");
    dom.window.close();
  });

  it("debounces the latest call with cancellation and immediate-run controls", () => {
    vi.useFakeTimers();
    const values: string[] = [];
    const deferred = debounce(
      (value: string) => {
        values.push(value);
        return value.toUpperCase();
      },
      40,
      true,
    );

    expect(deferred("first")).toBe(deferred);
    vi.advanceTimersByTime(20);
    deferred("second");
    vi.advanceTimersByTime(39);
    expect(values).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(values).toEqual(["second"]);

    deferred("cancelled").cancel();
    vi.advanceTimersByTime(50);
    expect(values).toEqual(["second"]);
    deferred("immediate");
    expect(deferred.run()).toBe("IMMEDIATE");
    expect(values).toEqual(["second", "immediate"]);
  });

  it("reports the desktop platform and attaches native tooltip metadata", () => {
    expect(Platform.isDesktop).toBe(true);
    expect(Platform.isDesktopApp).toBe(true);
    expect(Platform.isMobile).toBe(false);
    expect([Platform.isLinux, Platform.isMacOS, Platform.isWin].filter(Boolean)).toHaveLength(1);

    const dom = new JSDOM("<!doctype html><body><button></button></body>", {
      url: "https://threadleaf.invalid/",
    });
    const button = dom.window.document.querySelector("button");
    expect(button).not.toBeNull();
    if (button) {
      setTooltip(button, "Open drawing", {
        placement: "bottom",
        classes: ["drawing-tooltip"],
        delay: 250,
        gap: 6,
      });
      expect(button.title).toBe("Open drawing");
      expect(button.ariaLabel).toBe("Open drawing");
      expect(button.dataset).toMatchObject({
        tooltipPosition: "bottom",
        tooltipClasses: "drawing-tooltip",
        tooltipDelay: "250",
        tooltipGap: "6",
      });
    }
    dom.window.close();
  });
});
