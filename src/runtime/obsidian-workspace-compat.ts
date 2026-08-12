import type { PluginIntegrationSnapshot } from "../shared/contracts";
import type { CompatibilityEventRef } from "./obsidian-components";

type EventCallback = (...args: unknown[]) => unknown;

class WorkspaceEventRef implements CompatibilityEventRef {
  private callback: (() => void) | null;

  constructor(callback: () => void) {
    this.callback = callback;
  }

  off(): void {
    this.callback?.();
    this.callback = null;
  }
}

function createWorkspaceElement(className: string): HTMLElement {
  if (typeof document === "undefined") {
    return new EventTarget() as HTMLElement;
  }
  const element = document.createElement("div");
  element.className = className;
  return element;
}

function workspaceContainer(): HTMLElement {
  if (typeof document === "undefined") {
    return new EventTarget() as HTMLElement;
  }
  return document.body;
}

export class WorkspaceSplit {
  readonly children: unknown[] = [];
  readonly containerEl = createWorkspaceElement("workspace-split");
  readonly direction: "horizontal" | "vertical";
  readonly workspace: Workspace;

  constructor(workspace: Workspace, direction: "horizontal" | "vertical") {
    this.workspace = workspace;
    this.direction = direction;
  }

  getRoot(): WorkspaceSplit {
    return this;
  }

  getContainer(): WorkspaceSplit {
    return this;
  }
}

export class Workspace {
  activeLeaf: unknown | null = null;
  readonly containerEl = workspaceContainer();
  readonly rootSplit = new WorkspaceSplit(this, "vertical");
  readonly floatingSplit = new WorkspaceSplit(this, "vertical");
  private readonly layoutReadyCallbacks = new Set<() => unknown>();
  private readonly leaves = new Set<unknown>();
  private readonly listeners = new Map<string, Set<EventCallback>>();
  private layoutReady = false;

  onLayoutReady(callback: () => unknown): void {
    if (this.layoutReady) {
      queueMicrotask(callback);
      return;
    }
    this.layoutReadyCallbacks.add(callback);
  }

  async markLayoutReady(): Promise<void> {
    if (this.layoutReady) {
      return;
    }
    this.layoutReady = true;
    const callbacks = [...this.layoutReadyCallbacks];
    this.layoutReadyCallbacks.clear();
    let failure: unknown = null;
    for (const callback of callbacks) {
      try {
        await callback();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) {
      throw failure;
    }
  }

  registerLeaf(leaf: unknown): () => void {
    this.leaves.add(leaf);
    this.activeLeaf = leaf;
    return () => {
      this.leaves.delete(leaf);
      if (this.activeLeaf === leaf) {
        this.activeLeaf = [...this.leaves].at(-1) ?? null;
      }
    };
  }

  on(name: string, callback: EventCallback, context?: unknown): CompatibilityEventRef {
    const bound = context ? callback.bind(context) : callback;
    const callbacks = this.listeners.get(name) ?? new Set<EventCallback>();
    callbacks.add(bound);
    this.listeners.set(name, callbacks);
    return new WorkspaceEventRef(() => {
      callbacks.delete(bound);
      if (callbacks.size === 0) {
        this.listeners.delete(name);
      }
    });
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const callback of [...(this.listeners.get(name) ?? [])]) {
      callback(...args);
    }
  }

  offref(eventRef: CompatibilityEventRef): void {
    eventRef.off();
  }

  updateOptions(): void {
    this.trigger("layout-change");
  }

  getLeavesOfType(viewType: string): unknown[] {
    return [...this.leaves].filter((leaf) => {
      if (!leaf || typeof leaf !== "object" || !("view" in leaf)) {
        return false;
      }
      const view = leaf.view;
      return (
        view !== null &&
        typeof view === "object" &&
        "getViewType" in view &&
        typeof view.getViewType === "function" &&
        view.getViewType() === viewType
      );
    });
  }

  iterateAllLeaves(callback: (leaf: unknown) => unknown): void {
    for (const leaf of this.leaves) {
      callback(leaf);
    }
  }

  getMostRecentLeaf(): unknown | null {
    return this.activeLeaf;
  }

  getLeaf(): unknown | null {
    return this.activeLeaf;
  }

  getLeafById(leafId: string | null | undefined): unknown | null {
    if (!leafId) {
      return null;
    }
    return (
      [...this.leaves].find(
        (leaf) => leaf !== null && typeof leaf === "object" && "id" in leaf && leaf.id === leafId,
      ) ?? null
    );
  }

  getActiveViewOfType<T>(viewType: new (...args: never[]) => T): T | null {
    if (!this.activeLeaf || typeof this.activeLeaf !== "object" || !("view" in this.activeLeaf)) {
      return null;
    }
    return this.activeLeaf.view instanceof viewType ? this.activeLeaf.view : null;
  }

  createLeafInParent(_parent: WorkspaceSplit, _index: number): unknown {
    const containerEl = createWorkspaceElement("workspace-leaf");
    return {
      containerEl,
      detach: () => containerEl.remove(),
      id: `threadleaf-internal-leaf-${this.leaves.size + 1}`,
      view: null,
    };
  }
}

interface OwnedRegistration {
  ownerId: string;
}

interface ViewRegistration extends OwnedRegistration {
  type: string;
  creator: (leaf: unknown) => unknown;
}

interface ExtensionRegistration extends OwnedRegistration {
  extensions: string[];
  viewType: string;
}

export class CompatibilityIntegrationRegistry {
  private readonly editorExtensions = new Set<unknown>();
  private readonly editorSuggests = new Set<unknown>();
  private readonly extensions: ExtensionRegistration[] = [];
  private readonly markdownPostProcessors = new Set<unknown>();
  private readonly ribbonItems = new Set<HTMLElement>();
  private readonly settingTabs = new Set<unknown>();
  private readonly statusBarItems = new Set<HTMLElement>();
  private readonly views = new Map<string, ViewRegistration>();
  private readonly pluginData = new Map<string, unknown>();
  private readonly icons = new Map<string, string>();

  registerView(ownerId: string, type: string, creator: (leaf: unknown) => unknown): () => void {
    if (this.views.has(type)) {
      throw new Error(`View type already registered: ${type}`);
    }
    const registration = { ownerId, type, creator };
    this.views.set(type, registration);
    return () => {
      if (this.views.get(type) === registration) {
        this.views.delete(type);
      }
    };
  }

  registerExtensions(ownerId: string, extensions: string[], viewType: string): () => void {
    const registration = {
      ownerId,
      extensions: extensions.map((extension) => extension.replace(/^\./, "").toLowerCase()),
      viewType,
    };
    this.extensions.push(registration);
    return () => {
      const index = this.extensions.indexOf(registration);
      if (index >= 0) {
        this.extensions.splice(index, 1);
      }
    };
  }

  addSettingTab(settingTab: unknown): () => void {
    this.settingTabs.add(settingTab);
    return () => this.settingTabs.delete(settingTab);
  }

  registerEditorSuggest(editorSuggest: unknown): () => void {
    this.editorSuggests.add(editorSuggest);
    return () => this.editorSuggests.delete(editorSuggest);
  }

  registerEditorExtension(editorExtension: unknown): () => void {
    this.editorExtensions.add(editorExtension);
    return () => this.editorExtensions.delete(editorExtension);
  }

  registerMarkdownPostProcessor(postProcessor: unknown): () => void {
    this.markdownPostProcessors.add(postProcessor);
    return () => this.markdownPostProcessors.delete(postProcessor);
  }

  addRibbonItem(element: HTMLElement): () => void {
    this.ribbonItems.add(element);
    return () => {
      this.ribbonItems.delete(element);
      element.remove();
    };
  }

  addStatusBarItem(element: HTMLElement): () => void {
    this.statusBarItems.add(element);
    return () => {
      this.statusBarItems.delete(element);
      element.remove();
    };
  }

  addIcon(id: string, svgContent: string): void {
    this.icons.set(id, svgContent);
  }

  getIcon(id: string): string | null {
    return this.icons.get(id) ?? null;
  }

  createView(type: string, leaf: unknown): unknown {
    const registration = this.views.get(type);
    if (!registration) {
      throw new Error(`View type is not registered: ${type}`);
    }
    return registration.creator(leaf);
  }

  getViewTypeForExtension(extension: string): string | null {
    const normalized = extension.replace(/^\./, "").toLowerCase();
    for (const registration of [...this.extensions].reverse()) {
      if (registration.extensions.includes(normalized)) {
        return registration.viewType;
      }
    }
    return null;
  }

  loadPluginData(pluginId: string): unknown | null {
    return this.pluginData.get(pluginId) ?? null;
  }

  savePluginData(pluginId: string, data: unknown): void {
    this.pluginData.set(pluginId, structuredClone(data));
  }

  snapshot(): PluginIntegrationSnapshot {
    return {
      editorSuggests: this.editorSuggests.size,
      extensions: this.extensions
        .flatMap(({ extensions, viewType }) =>
          extensions.map((extension) => ({ extension, viewType })),
        )
        .sort(
          (left, right) =>
            left.extension.localeCompare(right.extension) ||
            left.viewType.localeCompare(right.viewType),
        ),
      markdownPostProcessors: this.markdownPostProcessors.size,
      ribbonItems: this.ribbonItems.size,
      settingTabs: this.settingTabs.size,
      statusBarItems: this.statusBarItems.size,
      viewTypes: [...this.views.keys()].sort(),
    };
  }
}
