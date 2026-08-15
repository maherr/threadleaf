import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import inventory from "../../compatibility/open-plugin-usage.v1.json";
import { testConstructionDispatch } from "../test-support/plugin-construction";
import {
  App,
  CommandRegistry,
  type MarkdownPostProcessor,
  type MarkdownPostProcessorContext,
  MarkdownRenderChild,
  MarkdownRenderer,
  NoticeBus,
  Plugin,
  Vault,
} from "./obsidian-compat";
import { Component } from "./obsidian-components";
import { CompatibilityIntegrationRegistry } from "./obsidian-workspace-compat";
import { PluginHost } from "./plugin-host";

const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
const temporaryDirectories: string[] = [];

async function loadPlugin(host: PluginHost, pluginDirectory: string) {
  return host.loadAuthorizedPlugin(await testConstructionDispatch(pluginDirectory));
}

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

function createContext(): MarkdownPostProcessorContext {
  return {
    docId: "fixture-doc",
    sourcePath: "Notes/Fixture.md",
    frontmatter: undefined,
    addChild: vi.fn(),
    getSectionInfo: () => null,
  };
}

afterEach(async () => {
  for (const descriptor of previousGlobals) {
    const [name, value] = descriptor;
    if (value) {
      Object.defineProperty(globalThis, name, value);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
  previousGlobals.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("measured Markdown processor compatibility", () => {
  it("runs fenced processors first and keeps deterministic dynamic ordering", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    exposeDom(dom);
    const registry = new CompatibilityIntegrationRegistry();
    const root = dom.window.document.createElement("article");
    root.innerHTML = '<p>before</p><pre><code class="language-THREADLEAF">alpha\n</code></pre>';
    const calls: string[] = [];
    const codeProcessor = vi.fn((source: string, element: HTMLElement) => {
      calls.push(`code:${source}`);
      element.dataset.code = source;
    });
    const first = ((element: HTMLElement) => {
      calls.push(
        `first:${element.querySelector(".markdown-code-block")?.getAttribute("data-code")}`,
      );
    }) as MarkdownPostProcessor;
    first.sortOrder = 20;
    const second = (() => {
      calls.push("second");
    }) as MarkdownPostProcessor;
    second.sortOrder = 10;

    registry.registerMarkdownPostProcessor("first", first, 20);
    registry.registerMarkdownPostProcessor("second", second, 10);
    first.sortOrder = 0;
    registry.registerMarkdownCodeBlockProcessor("code", " ThreadLeaf ", codeProcessor, 100);

    await registry.runMarkdownPostProcessors(root, createContext());

    expect(calls).toEqual(["code:alpha", "first:alpha", "second"]);
    expect(root.querySelector("pre")).toBeNull();
    expect(root.querySelector(".markdown-code-block")?.className).toBe("markdown-code-block");
    expect(codeProcessor).toHaveBeenCalledOnce();
  });

  it("preserves unmatched fenced blocks and rejects invalid or failing registrations", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    exposeDom(dom);
    const registry = new CompatibilityIntegrationRegistry();
    const root = dom.window.document.createElement("article");
    root.innerHTML = '<pre><code class="language-other">alpha</code></pre>';
    const handler = vi.fn();

    registry.registerMarkdownCodeBlockProcessor("fixture", "threadleaf", handler);
    await registry.runMarkdownPostProcessors(root, createContext());
    expect(root.querySelector("pre")).not.toBeNull();
    expect(handler).not.toHaveBeenCalled();

    expect(() => registry.registerMarkdownPostProcessor("fixture", undefined as never)).toThrow(
      "requires a function",
    );
    expect(() =>
      registry.registerMarkdownPostProcessor(
        "fixture",
        (() => undefined) as MarkdownPostProcessor,
        1.5,
      ),
    ).toThrow("finite integer");
    expect(() => registry.registerMarkdownCodeBlockProcessor("fixture", " ", handler)).toThrow(
      "requires a language",
    );

    const failing = (() => {
      throw new Error("processor failed");
    }) as MarkdownPostProcessor;
    const following = vi.fn();
    registry.registerMarkdownPostProcessor("fixture", failing);
    registry.registerMarkdownPostProcessor("fixture", following);
    await expect(registry.runMarkdownPostProcessors(root, createContext())).rejects.toThrow(
      "processor failed",
    );
    expect(following).not.toHaveBeenCalled();
  });

  it("exposes deterministic render context and render-child lifecycle through MarkdownRenderer", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    exposeDom(dom);
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "threadleaf-markdown-render-"));
    temporaryDirectories.push(rootPath);
    const app = new App(new Vault(rootPath), new CommandRegistry(), new NoticeBus(() => undefined));
    let observed: MarkdownPostProcessorContext | null = null;
    class ContextPlugin extends Plugin {
      async onload(): Promise<void> {
        this.registerMarkdownPostProcessor((element, context) => {
          observed = context;
          context.getSectionInfo(element);
          context.addChild(new Child(element));
        });
      }
    }
    class Child extends MarkdownRenderChild {
      onload(): void {
        this.containerEl.dataset.childState = "loaded";
      }

      onunload(): void {
        this.containerEl.dataset.childState = "unloaded";
      }
    }

    const plugin = new ContextPlugin(app, {
      id: "context-fixture",
      name: "Context fixture",
      version: "0.1.0",
    });
    await plugin.__load();
    const component = new Component();
    component.load();
    const element = dom.window.document.createElement("article");
    const markdown = "---\ntitle: Hello\n---\nBody\n";

    await MarkdownRenderer.render(app, markdown, element, "./Notes\\Doc.md", component);

    const context = observed as MarkdownPostProcessorContext | null;
    expect(context).not.toBeNull();
    if (!context) {
      throw new Error("Markdown renderer did not invoke the post processor.");
    }
    expect(context).toMatchObject({
      sourcePath: "Notes/Doc.md",
      frontmatter: { title: "Hello" },
    });
    expect(context.docId).toMatch(/^Notes\/Doc\.md:[a-f0-9]{64}$/u);
    expect(context.getSectionInfo(element)).toEqual({
      text: markdown,
      lineStart: 0,
      lineEnd: 4,
    });
    expect(context.getSectionInfo(dom.window.document.createElement("div"))).toBeNull();
    expect(element.dataset.childState).toBe("loaded");

    component.unload();
    expect(element.dataset.childState).toBe("unloaded");
    await plugin.__unload();
  });

  it("loads the unchanged family fixture, exercises all four public members, and releases it", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    exposeDom(dom);
    const vaultPath = path.resolve("fixtures/vaults/basic");
    const pluginPath = path.join(vaultPath, ".obsidian", "plugins", "markdown-processors-fixture");
    const bundlePath = path.join(pluginPath, "main.js");
    const before = await fs.readFile(bundlePath);
    const host = new PluginHost(vaultPath);
    const component = new Component();
    component.load();

    await loadPlugin(host, pluginPath);
    const element = dom.window.document.createElement("article");
    const markdown = "---\ntitle: Fixture\n---\n```ThReAdLeAf\nvalue\n```\n";
    await MarkdownRenderer.render(host.app, markdown, element, "Notes/Fixture.md", component);

    const codeBlock = element.querySelector<HTMLElement>(".markdown-code-block");
    expect(codeBlock).not.toBeNull();
    expect(codeBlock?.dataset.fixtureCode).toMatch(/^value\|Notes\/Fixture\.md:[a-f0-9]{64}$/u);
    expect(element.dataset.fixturePost).toBe("Notes/Fixture.md|Fixture");
    expect(element.dataset.fixtureChild).toBe("loaded");
    expect(element.querySelector("pre")).toBeNull();

    await host.unloadPlugin();
    component.unload();
    const afterUnload = dom.window.document.createElement("article");
    await MarkdownRenderer.render(
      host.app,
      markdown,
      afterUnload,
      "Notes/Fixture.md",
      new Component(),
    );
    expect(afterUnload.dataset.fixturePost).toBeUndefined();
    expect(afterUnload.querySelector("pre")).not.toBeNull();
    expect(element.dataset.fixtureChild).toBe("unloaded");
    expect(await fs.readFile(bundlePath)).toEqual(before);
    await host.close();
  });

  it("keeps the measured inventory explicit and honest", () => {
    expect(inventory.family).toBe("markdown-processors");
    expect(inventory.classification).toBe("desktop-compatibility-only");
    expect(inventory.registryClaim.status).toBe("not-added");
    expect(inventory.corpus).toHaveLength(5);
    expect(
      inventory.corpus.filter(({ classification }) => classification === "selected-family-usage"),
    ).toHaveLength(3);
    expect(
      inventory.corpus.filter(
        ({ classification }) => classification === "negative-adjacent-family",
      ),
    ).toHaveLength(2);
    for (const record of inventory.corpus) {
      expect(record.plugin.bundleSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(record.plugin.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(record.plugin.license.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(record.unresolvedOrDynamic.length).toBeGreaterThan(0);
    }
    expect(inventory.implementedMembers.map(({ member }) => member)).toEqual([
      "Plugin.registerMarkdownPostProcessor",
      "Plugin.registerMarkdownCodeBlockProcessor",
      "MarkdownRenderChild",
      "MarkdownPostProcessorContext",
    ]);
  });
});

describe("CITE settled Reading projection", () => {
  const citeVaultPath = path.resolve("fixtures/vaults/cite-settled-reading");
  const citePluginPath = path.join(citeVaultPath, ".obsidian", "plugins", "cite");

  it("renders CITE's settled, sanitizer-bound projection bound to the exact content hash", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    exposeDom(dom);
    const host = new PluginHost(citeVaultPath);
    await loadPlugin(host, citePluginPath);

    const content =
      "Grounded by prior work [cite: Doe 2024] and a second source [cite: Smith 2023].";
    const snapshot = await host.renderMarkdownProjection("cite", "Citations.md", content);

    const projection = snapshot.markdownProjection;
    expect(projection).not.toBeNull();
    if (!projection) {
      throw new Error("Expected a settled Markdown projection.");
    }
    expect(projection.pluginId).toBe("cite");
    expect(projection.sourcePath).toBe("Citations.md");
    expect(projection.postProcessorCount).toBe(1);
    expect(projection.contentSha256).toBe(
      createHash("sha256").update(content, "utf8").digest("hex"),
    );
    expect(projection.html).toContain('<span class="cite-citation">Doe 2024</span>');
    expect(projection.html).toContain('<span class="cite-citation">Smith 2023</span>');
    expect(projection.html).toContain("CITE recognized 2 citations.");

    await host.close();
  });

  it("reports an honest zero rather than fabricating a citation", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    exposeDom(dom);
    const host = new PluginHost(citeVaultPath);
    await loadPlugin(host, citePluginPath);

    const snapshot = await host.renderMarkdownProjection(
      "cite",
      "No Citations.md",
      "An ordinary note with no citation markers at all.",
    );

    expect(snapshot.markdownProjection?.html).toContain("CITE found no citations in this note.");
    expect(snapshot.markdownProjection?.html).not.toContain('cite-citation"');

    await host.close();
  });

  it("settles each request independently, proving no live callback or DOM state survives between calls", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    exposeDom(dom);
    const host = new PluginHost(citeVaultPath);
    await loadPlugin(host, citePluginPath);

    // Each call's render-child is loaded and unloaded synchronously inside
    // renderMarkdownProjection itself (see PluginHost.renderMarkdownProjection). Nothing outside
    // that call ever mounts or later unmounts this DOM tree, so a second, differently worded
    // request must reflect only its own content -- proof this is a settled, one-shot execution
    // rather than a live callback accumulating state or waiting on a native Reading view.
    const first = await host.renderMarkdownProjection("cite", "Citations.md", "[cite: Doe 2024]");
    const second = await host.renderMarkdownProjection(
      "cite",
      "Citations.md",
      "[cite: Smith 2023] [cite: Lee 2022]",
    );

    expect(first.markdownProjection?.html).toContain("Doe 2024");
    expect(first.markdownProjection?.html).toContain("CITE recognized 1 citation.");
    expect(first.markdownProjection?.html).not.toContain("Smith 2023");

    expect(second.markdownProjection?.html).toContain("Smith 2023");
    expect(second.markdownProjection?.html).toContain("Lee 2022");
    expect(second.markdownProjection?.html).toContain("CITE recognized 2 citations.");
    expect(second.markdownProjection?.html).not.toContain("Doe 2024");
    expect(second.markdownProjection?.contentSha256).not.toBe(
      first.markdownProjection?.contentSha256,
    );

    await host.close();
  });

  it("rejects explicitly rather than returning a partial snapshot when the plugin is not loaded", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    exposeDom(dom);
    const host = new PluginHost(citeVaultPath);

    await expect(
      host.renderMarkdownProjection("cite", "Citations.md", "[cite: Doe 2024]"),
    ).rejects.toThrow(/\[runtime-render-failed\]\.$/u);

    await host.close();
  });

  it("rejects with an explicit processor-error diagnostic when the registered processor throws", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    exposeDom(dom);
    const host = new PluginHost(citeVaultPath);
    const brokenPluginPath = path.join(citeVaultPath, ".obsidian", "plugins", "cite-broken");
    await loadPlugin(host, brokenPluginPath);

    await expect(
      host.renderMarkdownProjection("cite-broken", "Citations.md", "[cite: Doe 2024]"),
    ).rejects.toThrow(/\[runtime-render-failed\]\.$/u);

    // The compatibility host itself must stay usable for sibling plugins after one plugin's
    // processor throws while settling a projection.
    const snapshot = await host.getSnapshot();
    expect(snapshot.plugins?.find(({ id }) => id === "cite-broken")?.state).toBe("loaded");

    await host.close();
  });

  it("rejects a settled projection whose HTML exceeds the outbound size cap instead of returning it", async () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    exposeDom(dom);
    const host = new PluginHost(citeVaultPath);
    const oversizedPluginPath = path.join(citeVaultPath, ".obsidian", "plugins", "cite-oversized");
    await loadPlugin(host, oversizedPluginPath);

    await expect(
      host.renderMarkdownProjection("cite-oversized", "Citations.md", "trigger"),
    ).rejects.toThrow(/\[runtime-render-too-large\]\.$/u);

    // The oversized HTML must never have been returned on a "successful" snapshot as a partial
    // or truncated result -- the rejection above is the only outcome.
    const snapshot = await host.getSnapshot();
    expect(snapshot.plugins?.find(({ id }) => id === "cite-oversized")?.state).toBe("loaded");

    await host.close();
  });
});
