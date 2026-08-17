import type { PluginIntegrationSnapshot } from "../shared/contracts";
import type {
  MarkdownCodeBlockProcessor,
  MarkdownPostProcessor,
  MarkdownPostProcessorContext,
} from "./obsidian-compat";
import { type App, TFile } from "./obsidian-compat";
import type { CompatibilityEventRef } from "./obsidian-components";
import { Events } from "./obsidian-events";
import { Editor, isConstructedWorkspaceLeaf, WorkspaceLeaf } from "./obsidian-ui-compat";
import { WorkspaceParent } from "./obsidian-workspace-items";

export { WorkspaceItem, WorkspaceParent } from "./obsidian-workspace-items";

type EventCallback = (...args: unknown[]) => unknown;
type PaneType = "split" | "tab" | "window";
type SplitDirection = "horizontal" | "vertical";
type WorkspaceLeafFactory = (containerEl?: HTMLElement) => WorkspaceLeaf;
type WorkspaceLinkResolver = (linktext: string, sourcePath: string) => TFile | null;

export interface MarkdownFileInfo {
  app: App;
  readonly file: TFile | null;
  editor?: Editor;
  hoverPopover: null;
}

export interface OpenViewState {
  active?: boolean;
  eState?: Record<string, unknown>;
  group?: WorkspaceLeaf;
  state?: Record<string, unknown>;
}

interface WorkspaceLeafGroup {
  readonly leaves: Set<WorkspaceLeaf>;
}

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

export class WorkspaceSplit extends WorkspaceParent {
  readonly children: WorkspaceLeaf[] = [];
  readonly containerEl = createWorkspaceElement("workspace-split");
  direction: SplitDirection;
  readonly workspace: Workspace;
  parent: WorkspaceParent | null = null;

  constructor(workspace: Workspace, direction: "horizontal" | "vertical") {
    super();
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

export class WorkspaceTabs extends WorkspaceParent {
  readonly children: WorkspaceLeaf[] = [];
  readonly parent: WorkspaceSplit;

  constructor(parent: WorkspaceSplit) {
    super();
    this.parent = parent;
  }
}

export class Workspace extends Events {
  private activeEditorState: MarkdownFileInfo | null = null;
  activeLeaf: WorkspaceLeaf | null = null;
  readonly containerEl = workspaceContainer();
  readonly rootSplit = new WorkspaceSplit(this, "vertical");
  readonly floatingSplit = new WorkspaceSplit(this, "vertical");
  private readonly layoutReadyCallbacks = new Set<() => unknown>();
  private readonly leafGroups = new Map<WorkspaceLeaf, WorkspaceLeafGroup>();
  private readonly leaves = new Set<WorkspaceLeaf>();
  private readonly listeners = new Map<string, Set<EventCallback>>();
  private readonly leafParents = new Map<WorkspaceSplit, WorkspaceTabs>();
  private readonly rightLeaves = new Set<WorkspaceLeaf>();
  private leafFactory: WorkspaceLeafFactory | null = null;
  private linkResolver: WorkspaceLinkResolver | null = null;
  private layoutReadyCallbackActive = false;
  private layoutReadyErrorHandler: ((error: unknown) => void) | null = null;
  private layoutReadyState = false;
  private mostRecentFile: TFile | null = null;
  private pendingLeafGroup: WorkspaceLeafGroup | null = null;

  constructor() {
    super();
    this.leafParents.set(this.rootSplit, new WorkspaceTabs(this.rootSplit));
    this.leafParents.set(this.floatingSplit, new WorkspaceTabs(this.floatingSplit));
  }

  get activeEditor(): MarkdownFileInfo | null {
    return this.activeEditorState;
  }

  set activeEditor(value: MarkdownFileInfo | null) {
    const activeApp = this.activeLeaf?.app;
    this.activeEditorState = activeApp && this.isMarkdownFileInfo(value, activeApp) ? value : null;
  }

  get layoutReady(): boolean {
    return this.layoutReadyState;
  }

  setLeafFactory(factory: WorkspaceLeafFactory): void {
    this.leafFactory = factory;
  }

  setLinkResolver(resolver: WorkspaceLinkResolver): void {
    this.linkResolver = resolver;
  }

  setLayoutReadyErrorHandler(handler: (error: unknown) => void): void {
    this.layoutReadyErrorHandler = handler;
  }

  onLayoutReady(callback: () => unknown): void {
    if (this.layoutReadyState) {
      if (this.layoutReadyCallbackActive) {
        queueMicrotask(() => this.invokeLayoutReadyCallback(callback));
      } else {
        this.invokeLayoutReadyCallback(callback);
      }
      return;
    }
    this.layoutReadyCallbacks.add(callback);
  }

  async markLayoutReady(): Promise<void> {
    if (!this.layoutReadyState) {
      this.layoutReadyState = true;
      const callbacks = [...this.layoutReadyCallbacks];
      this.layoutReadyCallbacks.clear();
      for (const callback of callbacks) {
        this.invokeLayoutReadyCallback(callback);
      }
    }
  }

  isLayoutReady(): boolean {
    return this.layoutReadyState;
  }

  private invokeLayoutReadyCallback(callback: () => unknown): void {
    this.layoutReadyCallbackActive = true;
    try {
      void Promise.resolve(callback()).catch((error) => this.reportLayoutReadyError(error));
    } catch (error) {
      this.reportLayoutReadyError(error);
    } finally {
      this.layoutReadyCallbackActive = false;
    }
  }

  private reportLayoutReadyError(error: unknown): void {
    try {
      this.layoutReadyErrorHandler?.(error);
    } catch {
      // Diagnostic reporting cannot become a workspace-readiness barrier.
    }
  }

  async waitForLayoutReadyCallbacks(): Promise<void> {
    await Promise.resolve();
  }

  registerLeaf(leaf: WorkspaceLeaf): () => void {
    this.assertWorkspaceLeaf(leaf);
    this.assignLeafParent(leaf, this.rootSplit);
    const group =
      this.pendingLeafGroup ?? this.groupForLeaf(this.activeLeaf) ?? this.createLeafGroup();
    this.assignLeafToGroup(leaf, group);
    this.leaves.add(leaf);
    if (this.activeLeaf === null) {
      this.setActiveLeaf(leaf);
    } else {
      this.setLeafVisibility(leaf, false);
    }
    return () => {
      this.leaves.delete(leaf);
      this.rightLeaves.delete(leaf);
      const group = this.leafGroups.get(leaf);
      group?.leaves.delete(leaf);
      this.leafGroups.delete(leaf);
      this.removeLeafFromParent(leaf);
      if (this.activeLeaf === leaf) {
        const nextLeaf = [...this.leaves].at(-1) ?? null;
        this.activeLeaf = null;
        this.activeEditor = null;
        if (nextLeaf) {
          this.setActiveLeaf(nextLeaf);
        }
      }
    };
  }

  setActiveLeaf(leaf: WorkspaceLeaf, _params?: { focus?: boolean }): void {
    if (!this.leaves.has(leaf)) {
      return;
    }
    this.activeLeaf = leaf;
    const activeView = this.leafView(leaf);
    this.activeEditor =
      activeView && this.isMarkdownFileInfo(activeView, leaf.app) && activeView.editor
        ? activeView
        : null;
    const activeFile = this.fileForLeaf(leaf);
    if (activeFile) {
      this.mostRecentFile = activeFile;
    }
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

  getLeavesOfType(viewType: string): WorkspaceLeaf[] {
    return [...this.leaves].filter((leaf) => {
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

  detachLeavesOfType(viewType: string): void {
    for (const leaf of this.getLeavesOfType(viewType)) {
      const detach = leaf.detach;
      if (typeof detach === "function") {
        void detach.call(leaf);
      }
    }
  }

  iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => unknown): void {
    for (const leaf of this.leaves) {
      callback(leaf);
    }
  }

  getMostRecentLeaf(): WorkspaceLeaf | null {
    return this.activeLeaf;
  }

  getActiveFile(): TFile | null {
    const activeFile = this.fileForLeaf(this.activeLeaf);
    if (activeFile) {
      this.mostRecentFile = activeFile;
      return activeFile;
    }
    return this.mostRecentFile;
  }

  getLayout(): WorkspaceLayout {
    const layoutLeaves = (leaves: WorkspaceLeaf[]): WorkspaceLayoutLeaf[] =>
      leaves
        .map((leaf): WorkspaceLayoutLeaf | null => {
          const viewState = leaf.getViewState();
          return {
            id: leaf.id,
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
    const mainLeaves = layoutLeaves([...this.leaves].filter((leaf) => !this.rightLeaves.has(leaf)));
    const rightLeaves = layoutLeaves([...this.rightLeaves]);
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
      right: {
        children: rightLeaves,
        direction: "vertical",
        type: "split",
      },
    };
  }

  getLeaf(newLeaf?: "split", direction?: SplitDirection): WorkspaceLeaf;
  getLeaf(newLeaf?: PaneType | boolean): WorkspaceLeaf;
  getLeaf(newLeaf?: PaneType | boolean, direction?: SplitDirection): WorkspaceLeaf {
    if (newLeaf === undefined || newLeaf === false) {
      return this.activeLeaf ?? this.createLeafInPane("tab");
    }
    if (newLeaf === true || newLeaf === "tab") {
      return this.createLeafInPane("tab", this.activeLeaf);
    }
    if (newLeaf === "split") {
      return this.createLeafBySplit(this.activeLeaf ?? this.getLeaf(false), direction);
    }
    if (newLeaf === "window") {
      throw new Error("Workspace popout leaves are not supported by this compatibility runtime.");
    }
    throw new Error(`Unsupported workspace pane type: ${String(newLeaf)}.`);
  }

  getUnpinnedLeaf(): WorkspaceLeaf {
    return (
      [...this.leaves].find((leaf) => leaf.getViewState().pinned !== true) ?? this.getLeaf("tab")
    );
  }

  splitActiveLeaf(direction?: SplitDirection): WorkspaceLeaf {
    return this.getLeaf("split", direction);
  }

  getRightLeaf(split: boolean): WorkspaceLeaf | null {
    if (!split) {
      const existingLeaf = [...this.rightLeaves].at(-1);
      if (existingLeaf) {
        return existingLeaf;
      }
      if (!this.leafFactory) {
        return null;
      }
    }
    const leaf = this.createLeafBySplit(this.activeLeaf ?? this.getLeaf(false));
    this.rightLeaves.add(leaf);
    return leaf;
  }

  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    if (this.leaves.has(leaf)) {
      this.setActiveLeaf(leaf);
    }
  }

  async openLinkText(
    linktext: string,
    sourcePath: string,
    newLeaf?: PaneType | boolean,
    openViewState?: OpenViewState,
  ): Promise<void> {
    let resolver = this.linkResolver;
    if (!resolver) {
      const app = this.leafApp(this.activeLeaf);
      const metadataCache = app?.metadataCache;
      if (
        metadataCache &&
        typeof metadataCache === "object" &&
        "getFirstLinkpathDest" in metadataCache &&
        typeof metadataCache.getFirstLinkpathDest === "function"
      ) {
        const getFirstLinkpathDest = metadataCache.getFirstLinkpathDest;
        resolver = (candidate, source) =>
          getFirstLinkpathDest.call(metadataCache, candidate, source);
      }
    }
    if (!resolver) {
      return;
    }
    const file = resolver(linktext, sourcePath);
    if (!file) {
      return;
    }
    const leaf = newLeaf === undefined ? this.getLeaf(false) : this.getLeaf(newLeaf);
    const openFile = leaf.openFile;
    const subpathIndex = linktext.indexOf("#");
    const subpath = subpathIndex >= 0 ? linktext.slice(subpathIndex) : "";
    const requestedState = openViewState?.state;
    const state =
      requestedState && typeof requestedState === "object"
        ? (requestedState as Record<string, unknown>)
        : {};
    const effectiveOpenViewState = subpath
      ? {
          ...openViewState,
          state: {
            ...state,
            subpath,
          },
        }
      : openViewState;
    await openFile.call(leaf, file, effectiveOpenViewState);
    if (effectiveOpenViewState?.active !== false) {
      this.setActiveLeaf(leaf);
    }
  }

  createLeafBySplit(
    originLeaf?: WorkspaceLeaf | null,
    direction?: SplitDirection,
    before = false,
  ): WorkspaceLeaf {
    if (direction) {
      this.rootSplit.direction = direction;
    }
    return this.createLeafInPane("split", originLeaf, before);
  }

  createLeafInParent(parent: WorkspaceSplit, index: number): WorkspaceLeaf {
    if (parent.workspace !== this) {
      throw new Error("Workspace leaf parent belongs to a different workspace.");
    }
    const leaf = this.createLeafInPane("tab", this.activeLeaf);
    this.assignLeafParent(leaf, parent);
    const insertionIndex = Math.max(0, Math.min(index, parent.children.length));
    parent.children.splice(insertionIndex, 0, leaf);
    return leaf;
  }

  setLeafGroup(leaf: WorkspaceLeaf, groupLeaf: WorkspaceLeaf): void {
    if (!this.leaves.has(leaf) || !this.leaves.has(groupLeaf)) {
      throw new Error("Workspace leaf groups require leaves from the active workspace.");
    }
    const group = this.groupForLeaf(groupLeaf);
    if (!group) {
      throw new Error("Workspace leaf group is unavailable.");
    }
    this.assignLeafToGroup(leaf, group);
    if (this.activeLeaf && this.groupForLeaf(this.activeLeaf) === group) {
      for (const candidate of group.leaves) {
        this.setLeafVisibility(candidate, candidate === this.activeLeaf);
      }
    }
  }

  getLeafGroupMember(leaf: WorkspaceLeaf): WorkspaceLeaf | null {
    const group = this.groupForLeaf(leaf);
    return [...(group?.leaves ?? [])].find((candidate) => candidate !== leaf) ?? null;
  }

  private createLeafInPane(
    paneType: Exclude<PaneType, "window">,
    originLeaf?: WorkspaceLeaf | null,
    before = false,
  ): WorkspaceLeaf {
    if (!this.leafFactory) {
      throw new Error("Workspace leaf creation requires an installed compatibility leaf factory.");
    }
    const originContainer = this.leafContainer(originLeaf);
    const doc =
      originContainer?.ownerDocument ?? (typeof document === "undefined" ? null : document);
    if (!doc) {
      throw new Error("Workspace leaf creation requires a renderer document.");
    }
    const containerEl = doc.createElement("div");
    containerEl.className = `threadleaf-plugin-surface workspace-leaf mod-${paneType}`;
    containerEl.dataset.threadleafPaneType = paneType;
    Object.assign(containerEl.style, {
      display: "flex",
      inset: "0",
      minHeight: "0",
      minWidth: "0",
      overflow: "hidden",
      position: "absolute",
    });
    if (originContainer?.parentElement) {
      if (before) {
        originContainer.before(containerEl);
      } else {
        originContainer.after(containerEl);
      }
    } else {
      doc.body.append(containerEl);
    }
    const group =
      paneType === "tab"
        ? (this.groupForLeaf(originLeaf ?? null) ?? this.createLeafGroup())
        : this.createLeafGroup();
    this.pendingLeafGroup = group;
    try {
      const leaf = this.leafFactory(containerEl);
      if (!(leaf instanceof WorkspaceLeaf) || !isConstructedWorkspaceLeaf(leaf)) {
        throw new Error(
          "Compatibility workspace leaf factory must return an actual WorkspaceLeaf.",
        );
      }
      this.assertWorkspaceLeaf(leaf);
      if (!this.leaves.has(leaf)) {
        this.registerLeaf(leaf);
      }
      this.assignLeafToGroup(leaf, group);
      return leaf;
    } finally {
      this.pendingLeafGroup = null;
    }
  }

  getLeafById(leafId: string | null | undefined): WorkspaceLeaf | null {
    if (!leafId) {
      return null;
    }
    return [...this.leaves].find((leaf) => leaf.id === leafId) ?? null;
  }

  getActiveViewOfType<T>(viewType: new (...args: never[]) => T): T | null {
    if (!this.activeLeaf || typeof this.activeLeaf !== "object" || !("view" in this.activeLeaf)) {
      return null;
    }
    return this.activeLeaf.view instanceof viewType ? this.activeLeaf.view : null;
  }

  private createLeafGroup(): WorkspaceLeafGroup {
    return { leaves: new Set<WorkspaceLeaf>() };
  }

  private tabsForSplit(split: WorkspaceSplit): WorkspaceTabs {
    const existing = this.leafParents.get(split);
    if (existing) {
      return existing;
    }
    const tabs = new WorkspaceTabs(split);
    this.leafParents.set(split, tabs);
    return tabs;
  }

  private assignLeafParent(leaf: WorkspaceLeaf, split: WorkspaceSplit): void {
    this.removeLeafFromParent(leaf);
    const parent = this.tabsForSplit(split);
    leaf.parent = parent;
    if (!parent.children.includes(leaf)) {
      parent.children.push(leaf);
    }
  }

  private removeLeafFromParent(leaf: WorkspaceLeaf): void {
    const parent = leaf.parent;
    if (!parent) {
      return;
    }
    const index = parent.children.indexOf(leaf);
    if (index >= 0) {
      parent.children.splice(index, 1);
    }
    leaf.parent = null;
  }

  private assignLeafToGroup(leaf: WorkspaceLeaf, group: WorkspaceLeafGroup): void {
    const previous = this.leafGroups.get(leaf);
    if (previous === group) {
      return;
    }
    previous?.leaves.delete(leaf);
    group.leaves.add(leaf);
    this.leafGroups.set(leaf, group);
  }

  private groupForLeaf(leaf: WorkspaceLeaf | null): WorkspaceLeafGroup | null {
    return leaf ? (this.leafGroups.get(leaf) ?? null) : null;
  }

  private fileForLeaf(leaf: WorkspaceLeaf | null): TFile | null {
    const view = this.leafView(leaf);
    if (!view || !("file" in view)) {
      return null;
    }
    const file = view.file;
    return file instanceof TFile ? file : null;
  }

  private leafApp(leaf: WorkspaceLeaf | null): Record<string, unknown> | null {
    const app = leaf?.app;
    return app && typeof app === "object" ? (app as unknown as Record<string, unknown>) : null;
  }

  private leafView(leaf: WorkspaceLeaf | null): Record<string, unknown> | null {
    if (!leaf) {
      return null;
    }
    const view = leaf.view;
    return view && typeof view === "object" ? (view as unknown as Record<string, unknown>) : null;
  }

  private leafContainer(leaf: WorkspaceLeaf | null | undefined): HTMLElement | null {
    if (!leaf) {
      return null;
    }
    const containerEl = leaf.containerEl;
    return containerEl && typeof containerEl === "object" && "ownerDocument" in containerEl
      ? (containerEl as HTMLElement)
      : null;
  }

  private setLeafVisibility(leaf: WorkspaceLeaf, active: boolean): void {
    const containerEl = this.leafContainer(leaf);
    if (!containerEl) {
      return;
    }
    containerEl.hidden = !active;
    containerEl.classList.toggle("mod-active", active);
  }

  private assertWorkspaceLeaf(value: unknown): asserts value is WorkspaceLeaf {
    if (
      !value ||
      typeof value !== "object" ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !("containerEl" in value) ||
      !("openFile" in value) ||
      typeof value.openFile !== "function" ||
      !("getViewState" in value) ||
      typeof value.getViewState !== "function"
    ) {
      throw new Error("Compatibility workspace leaf factory returned an invalid WorkspaceLeaf.");
    }
  }

  private isMarkdownFileInfo(value: unknown, expectedApp?: unknown): value is MarkdownFileInfo {
    if (!value || typeof value !== "object") {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    if (
      !("app" in candidate) ||
      (expectedApp !== undefined && candidate.app !== expectedApp) ||
      !("file" in candidate) ||
      (candidate.file !== null && !(candidate.file instanceof TFile)) ||
      !("hoverPopover" in candidate) ||
      candidate.hoverPopover !== null
    ) {
      return false;
    }
    return !("editor" in candidate) || candidate.editor instanceof Editor;
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

interface EditorExtensionRegistration extends OwnedRegistration {
  extension: unknown;
  sequence: number;
}

interface MarkdownProcessorRegistration extends OwnedRegistration {
  codeBlockLanguage: string | null;
  codeBlockProcessor: MarkdownCodeBlockProcessor | null;
  defaultSortOrder: number;
  processor: MarkdownPostProcessor;
  sequence: number;
}

export interface CompatibilitySettingTab {
  containerEl: HTMLElement;
  display(): unknown;
  hide(): unknown;
}

interface SettingTabRegistration extends OwnedRegistration {
  tab: CompatibilitySettingTab;
}

export class CompatibilityIntegrationRegistry {
  private readonly editorExtensions: EditorExtensionRegistration[] = [];
  private readonly editorSuggests = new Set<unknown>();
  private readonly extensions: ExtensionRegistration[] = [];
  private readonly markdownPostProcessors: MarkdownProcessorRegistration[] = [];
  private readonly ribbonItems = new Set<HTMLElement>();
  private readonly settingTabs = new Set<SettingTabRegistration>();
  private readonly statusBarItems = new Set<HTMLElement>();
  private readonly views = new Map<string, ViewRegistration>();
  private readonly icons = new Map<string, string>();
  private nextMarkdownProcessorSequence = 0;
  private nextEditorExtensionSequence = 0;
  private editorExtensionOwnerOrder: readonly string[] = [];
  private editorExtensionChangeListener: ((extensions: readonly unknown[]) => void) | null = null;

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

  addSettingTab(ownerId: string, settingTab: CompatibilitySettingTab): () => void {
    const registration = { ownerId, tab: settingTab };
    this.settingTabs.add(registration);
    return () => this.settingTabs.delete(registration);
  }

  getSettingTab(ownerId: string): CompatibilitySettingTab | null {
    return (
      [...this.settingTabs].reverse().find((registration) => registration.ownerId === ownerId)
        ?.tab ?? null
    );
  }

  registerEditorSuggest(editorSuggest: unknown): () => void {
    this.editorSuggests.add(editorSuggest);
    return () => this.editorSuggests.delete(editorSuggest);
  }

  setEditorExtensionChangeListener(
    listener: ((extensions: readonly unknown[]) => void) | null,
  ): void {
    this.editorExtensionChangeListener = listener;
    if (listener) {
      listener(this.getEditorExtensions());
    }
  }

  setEditorExtensionOwnerOrder(ownerIds: readonly string[]): void {
    this.editorExtensionOwnerOrder = [...ownerIds];
    this.notifyEditorExtensionChange();
  }

  getEditorExtensions(): unknown[] {
    const ownerOrder = new Map(
      this.editorExtensionOwnerOrder.map((ownerId, index) => [ownerId, index]),
    );
    return [...this.editorExtensions]
      .sort(
        (left, right) =>
          (ownerOrder.get(left.ownerId) ?? Number.MAX_SAFE_INTEGER) -
            (ownerOrder.get(right.ownerId) ?? Number.MAX_SAFE_INTEGER) ||
          left.sequence - right.sequence,
      )
      .map(({ extension }) => extension);
  }

  registerEditorExtension(ownerId: string, editorExtension: unknown): () => void;
  registerEditorExtension(editorExtension: unknown): () => void;
  registerEditorExtension(
    ownerOrExtension: string | unknown,
    maybeEditorExtension?: unknown,
  ): () => void {
    const registration: EditorExtensionRegistration = {
      ownerId: typeof ownerOrExtension === "string" ? ownerOrExtension : "",
      extension: typeof ownerOrExtension === "string" ? maybeEditorExtension : ownerOrExtension,
      sequence: this.nextEditorExtensionSequence++,
    };
    this.editorExtensions.push(registration);
    this.notifyEditorExtensionChange();
    return () => {
      const index = this.editorExtensions.indexOf(registration);
      if (index >= 0) {
        this.editorExtensions.splice(index, 1);
        this.notifyEditorExtensionChange();
      }
    };
  }

  private notifyEditorExtensionChange(): void {
    this.editorExtensionChangeListener?.(this.getEditorExtensions());
  }

  registerMarkdownPostProcessor(
    ownerId: string,
    postProcessor: MarkdownPostProcessor,
    sortOrder?: number,
  ): () => void;
  registerMarkdownPostProcessor(
    postProcessor: MarkdownPostProcessor,
    sortOrder?: number,
  ): () => void;
  registerMarkdownPostProcessor(
    ownerOrProcessor: string | MarkdownPostProcessor,
    processorOrSortOrder?: MarkdownPostProcessor | number,
    sortOrder?: number,
  ): () => void {
    const ownerId = typeof ownerOrProcessor === "string" ? ownerOrProcessor : "";
    const postProcessor =
      typeof ownerOrProcessor === "string" ? processorOrSortOrder : ownerOrProcessor;
    const requestedSortOrder =
      typeof ownerOrProcessor === "string"
        ? sortOrder
        : typeof processorOrSortOrder === "number"
          ? processorOrSortOrder
          : undefined;
    if (typeof postProcessor !== "function") {
      throw new Error("Markdown post processor registration requires a function.");
    }
    const defaultSortOrder = validateMarkdownSortOrder(requestedSortOrder ?? 0);
    const registration: MarkdownProcessorRegistration = {
      ownerId,
      codeBlockLanguage: null,
      codeBlockProcessor: null,
      defaultSortOrder,
      processor: postProcessor,
      sequence: this.nextMarkdownProcessorSequence++,
    };
    this.markdownPostProcessors.push(registration);
    return () => {
      const index = this.markdownPostProcessors.indexOf(registration);
      if (index >= 0) {
        this.markdownPostProcessors.splice(index, 1);
      }
    };
  }

  registerMarkdownCodeBlockProcessor(
    ownerId: string,
    language: string,
    handler: MarkdownCodeBlockProcessor,
    sortOrder?: number,
    registeredProcessor?: MarkdownPostProcessor,
  ): () => void;
  registerMarkdownCodeBlockProcessor(
    language: string,
    handler: MarkdownCodeBlockProcessor,
    sortOrder?: number,
    registeredProcessor?: MarkdownPostProcessor,
  ): () => void;
  registerMarkdownCodeBlockProcessor(
    ownerOrLanguage: string,
    languageOrHandler: string | MarkdownCodeBlockProcessor,
    handlerOrSortOrder?: MarkdownCodeBlockProcessor | number,
    sortOrderOrRegistered?: number | MarkdownPostProcessor,
    registeredProcessor?: MarkdownPostProcessor,
  ): () => void {
    const ownerId = typeof languageOrHandler === "string" ? ownerOrLanguage : "";
    const language = typeof languageOrHandler === "string" ? languageOrHandler : ownerOrLanguage;
    const handler = typeof languageOrHandler === "string" ? handlerOrSortOrder : languageOrHandler;
    const requestedSortOrder =
      typeof languageOrHandler === "string"
        ? typeof sortOrderOrRegistered === "number"
          ? sortOrderOrRegistered
          : undefined
        : typeof handlerOrSortOrder === "number"
          ? handlerOrSortOrder
          : undefined;
    const effectiveRegisteredProcessor =
      typeof languageOrHandler === "string"
        ? registeredProcessor
        : typeof sortOrderOrRegistered === "function"
          ? sortOrderOrRegistered
          : undefined;
    const normalizedLanguage = asciiLowercase(language.trim());
    if (!normalizedLanguage) {
      throw new Error("Markdown code block processor registration requires a language.");
    }
    if (typeof handler !== "function") {
      throw new Error("Markdown code block processor registration requires a function.");
    }
    const defaultSortOrder = validateMarkdownSortOrder(requestedSortOrder ?? 0);
    const processor =
      effectiveRegisteredProcessor ??
      (((_element: HTMLElement, _context: MarkdownPostProcessorContext) => {
        throw new Error(
          `Markdown code block processor for ${normalizedLanguage} can only run on a fenced block.`,
        );
      }) as MarkdownPostProcessor);
    if (requestedSortOrder !== undefined) {
      processor.sortOrder = defaultSortOrder;
    }
    const registration: MarkdownProcessorRegistration = {
      ownerId,
      codeBlockLanguage: normalizedLanguage,
      codeBlockProcessor: handler,
      defaultSortOrder,
      processor,
      sequence: this.nextMarkdownProcessorSequence++,
    };
    this.markdownPostProcessors.push(registration);
    return () => {
      const index = this.markdownPostProcessors.indexOf(registration);
      if (index >= 0) {
        this.markdownPostProcessors.splice(index, 1);
      }
    };
  }

  async runMarkdownPostProcessors(
    rootElement: HTMLElement,
    context: MarkdownPostProcessorContext,
  ): Promise<void> {
    const registrations = [...this.markdownPostProcessors].sort(compareMarkdownProcessors);
    const codeBlocks = [...rootElement.querySelectorAll<HTMLElement>("pre > code")];
    for (const codeBlock of codeBlocks) {
      const language = codeBlockLanguage(codeBlock);
      if (!language) {
        continue;
      }
      const matches = registrations.filter(
        (registration) => registration.codeBlockLanguage === language,
      );
      if (matches.length === 0) {
        continue;
      }
      const source = codeBlock.textContent?.replace(/(?:\r\n|\r|\n)$/u, "") ?? "";
      const replacement = rootElement.ownerDocument.createElement("div");
      replacement.className = "markdown-code-block";
      const preformatted = codeBlock.parentElement;
      if (!preformatted) {
        continue;
      }
      preformatted.replaceWith(replacement);
      for (const registration of matches) {
        await registration.codeBlockProcessor?.(source, replacement, context);
      }
    }

    for (const registration of registrations) {
      if (registration.codeBlockLanguage !== null) {
        continue;
      }
      await registration.processor(rootElement, context);
    }
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

  getIconIds(): string[] {
    return [...this.icons.keys()].sort((left, right) => left.localeCompare(right));
  }

  removeIcon(id: string): void {
    this.icons.delete(id);
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
      markdownPostProcessors: this.markdownPostProcessors.length,
      ribbonItems: this.ribbonItems.size,
      settingTabs: this.settingTabs.size,
      settingTabPluginIds: [...new Set([...this.settingTabs].map(({ ownerId }) => ownerId))].sort(),
      statusBarItems: this.statusBarItems.size,
      viewTypes: [...this.views.keys()].sort(),
    };
  }
}

function validateMarkdownSortOrder(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("Markdown processor sort order must be a finite integer.");
  }
  return value;
}

function markdownSortOrder(registration: MarkdownProcessorRegistration): number {
  const candidate = registration.processor.sortOrder;
  return candidate === undefined
    ? registration.defaultSortOrder
    : validateMarkdownSortOrder(candidate);
}

function compareMarkdownProcessors(
  left: MarkdownProcessorRegistration,
  right: MarkdownProcessorRegistration,
): number {
  return markdownSortOrder(left) - markdownSortOrder(right) || left.sequence - right.sequence;
}

function codeBlockLanguage(codeBlock: HTMLElement): string | null {
  const languageClass = [...codeBlock.classList].find((className) =>
    asciiLowercase(className).startsWith("language-"),
  );
  if (!languageClass) {
    return null;
  }
  const language = asciiLowercase(languageClass.slice("language-".length).trim());
  return language || null;
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}
