import type { PluginIntegrationSnapshot } from "../shared/contracts";
import type { CompatibilityEventRef } from "./obsidian-components";

type EventCallback = (...args: unknown[]) => unknown;
type WorkspaceLeafFactory = (containerEl?: HTMLElement) => unknown;

interface WorkspaceLayoutLeaf {
  id: string;
  state: {
    state: Record<string, unknown>;
    type: string;
  };
  type: "leaf";
}

interface WorkspaceLayoutSplit {
  children: WorkspaceLayoutLeaf[];
  direction: "horizontal" | "vertical";
  type: "split";
}

export interface WorkspaceLayout {
  floating: WorkspaceLayoutSplit;
  left: WorkspaceLayoutSplit;
  main: WorkspaceLayoutSplit;
  right: WorkspaceLayoutSplit;
}

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
  private leafFactory: WorkspaceLeafFactory | null = null;
  private layoutReady = false;
  private layoutReadyFailure: unknown = null;
  private layoutReadyTail: Promise<void> = Promise.resolve();

  setLeafFactory(factory: WorkspaceLeafFactory): void {
    this.leafFactory = factory;
  }

  onLayoutReady(callback: () => unknown): void {
    if (this.layoutReady) {
      this.enqueueLayoutReadyCallback(callback);
      return;
    }
    this.layoutReadyCallbacks.add(callback);
  }

  async markLayoutReady(): Promise<void> {
    if (!this.layoutReady) {
      this.layoutReady = true;
      const callbacks = [...this.layoutReadyCallbacks];
      this.layoutReadyCallbacks.clear();
      for (const callback of callbacks) {
        this.enqueueLayoutReadyCallback(callback);
      }
    }

    let observedTail: Promise<void>;
    do {
      observedTail = this.layoutReadyTail;
      await observedTail;
    } while (observedTail !== this.layoutReadyTail);

    if (this.layoutReadyFailure) {
      const failure = this.layoutReadyFailure;
      this.layoutReadyFailure = null;
      throw failure;
    }
  }

  isLayoutReady(): boolean {
    return this.layoutReady;
  }

  private enqueueLayoutReadyCallback(callback: () => unknown): void {
    this.layoutReadyTail = this.layoutReadyTail.then(async () => {
      try {
        await callback();
      } catch (error) {
        this.layoutReadyFailure ??= error;
      }
    });
  }

  async waitForLayoutReadyCallbacks(): Promise<void> {
    if (this.layoutReady) {
      await this.markLayoutReady();
    }
  }

  registerLeaf(leaf: unknown): () => void {
    this.leaves.add(leaf);
    if (this.activeLeaf === null) {
      this.setActiveLeaf(leaf);
    } else {
      this.setLeafVisibility(leaf, false);
    }
    return () => {
      this.leaves.delete(leaf);
      if (this.activeLeaf === leaf) {
        const nextLeaf = [...this.leaves].at(-1) ?? null;
        this.activeLeaf = null;
        if (nextLeaf) {
          this.setActiveLeaf(nextLeaf);
        }
      }
    };
  }

  setActiveLeaf(leaf: unknown): void {
    if (!this.leaves.has(leaf)) {
      return;
    }
    this.activeLeaf = leaf;
    for (const candidate of this.leaves) {
      this.setLeafVisibility(candidate, candidate === leaf);
    }
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

  getLayout(): WorkspaceLayout {
    const mainLeaves = [...this.leaves]
      .map((leaf): WorkspaceLayoutLeaf | null => {
        if (!leaf || typeof leaf !== "object" || !("id" in leaf)) {
          return null;
        }
        const getViewState =
          "getViewState" in leaf && typeof leaf.getViewState === "function"
            ? leaf.getViewState.bind(leaf)
            : null;
        const viewState = getViewState?.() ?? { type: "empty", state: {} };
        return {
          id: typeof leaf.id === "string" ? leaf.id : String(leaf.id),
          state: {
            state:
              viewState && typeof viewState === "object" && "state" in viewState
                ? structuredClone(viewState.state as Record<string, unknown>)
                : {},
            type:
              viewState && typeof viewState === "object" && "type" in viewState
                ? String(viewState.type)
                : "empty",
          },
          type: "leaf",
        };
      })
      .filter((leaf): leaf is WorkspaceLayoutLeaf => leaf !== null);
    const emptySplit = (): WorkspaceLayoutSplit => ({
      children: [],
      direction: "vertical",
      type: "split",
    });
    return {
      floating: emptySplit(),
      left: emptySplit(),
      main: {
        children: mainLeaves,
        direction: this.rootSplit.direction,
        type: "split",
      },
      right: emptySplit(),
    };
  }

  getLeaf(newLeaf?: boolean | string): unknown | null {
    if (newLeaf === true || typeof newLeaf === "string") {
      return this.createLeafBySplit(this.activeLeaf);
    }
    return this.activeLeaf;
  }

  createLeafBySplit(originLeaf?: unknown): unknown | null {
    if (!this.leafFactory) {
      return null;
    }
    const originContainer = this.leafContainer(originLeaf);
    const doc =
      originContainer?.ownerDocument ?? (typeof document === "undefined" ? null : document);
    if (!doc) {
      return this.leafFactory();
    }
    const containerEl = doc.createElement("div");
    containerEl.className = "threadleaf-plugin-surface workspace-leaf";
    Object.assign(containerEl.style, {
      display: "flex",
      inset: "0",
      minHeight: "0",
      minWidth: "0",
      overflow: "hidden",
      position: "absolute",
    });
    if (originContainer?.parentElement) {
      originContainer.after(containerEl);
    } else {
      doc.body.append(containerEl);
    }
    return this.leafFactory(containerEl);
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
    return this.createLeafBySplit(this.activeLeaf);
  }

  private leafContainer(leaf: unknown): HTMLElement | null {
    if (!leaf || typeof leaf !== "object" || !("containerEl" in leaf)) {
      return null;
    }
    const containerEl = leaf.containerEl;
    return containerEl && typeof containerEl === "object" && "ownerDocument" in containerEl
      ? (containerEl as HTMLElement)
      : null;
  }

  private setLeafVisibility(leaf: unknown, active: boolean): void {
    const containerEl = this.leafContainer(leaf);
    if (!containerEl) {
      return;
    }
    containerEl.hidden = !active;
    containerEl.classList.toggle("mod-active", active);
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
