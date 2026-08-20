import type { PluginIntegrationSnapshot } from "../shared/contracts";
import type {
  MarkdownCodeBlockProcessor,
  MarkdownPostProcessor,
  MarkdownPostProcessorContext,
} from "./obsidian-compat";
import { type App, debounce, TFile } from "./obsidian-compat";
import type { CompatibilityEventRef } from "./obsidian-components";
import { Events } from "./obsidian-events";
import type { Menu } from "./obsidian-menu-compat";
import { Editor, isConstructedWorkspaceLeaf, WorkspaceLeaf } from "./obsidian-ui-compat";
import { WorkspaceParent } from "./obsidian-workspace-items";

export { WorkspaceItem, WorkspaceParent } from "./obsidian-workspace-items";

type EventCallback = (...args: unknown[]) => unknown;
type PaneType = "split" | "tab" | "window";
type SplitDirection = "horizontal" | "vertical";
type Side = "left" | "right";
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
  id: string;
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

function workspaceWindow(): Window {
  return typeof window === "undefined" ? ({} as Window) : window;
}

function workspaceDocument(): Document {
  return typeof document === "undefined" ? ({} as Document) : document;
}

export abstract class WorkspaceContainer extends WorkspaceSplit {
  abstract win: Window;
  abstract doc: Document;
}

export class WorkspaceMobileDrawer extends WorkspaceParent {
  parent: WorkspaceParent;
  collapsed = false;

  constructor(parent: WorkspaceParent = new WorkspaceParent()) {
    super();
    this.parent = parent;
  }

  expand(): void {
    this.collapsed = false;
  }

  collapse(): void {
    this.collapsed = true;
  }

  toggle(): void {
    this.collapsed = !this.collapsed;
  }
}

export class WorkspaceRibbon {}

export class WorkspaceRoot extends WorkspaceContainer {
  win = workspaceWindow();
  doc = workspaceDocument();
}

export class WorkspaceSidedock extends WorkspaceSplit {
  collapsed = false;

  toggle(): void {
    this.collapsed = !this.collapsed;
  }

  collapse(): void {
    this.collapsed = true;
  }

  expand(): void {
    this.collapsed = false;
  }
}

export class WorkspaceWindow extends WorkspaceContainer {
  win = workspaceWindow();
  doc = workspaceDocument();
}

export class WorkspaceFloating extends WorkspaceParent {
  parent: WorkspaceParent;

  constructor(parent: WorkspaceParent = new WorkspaceParent()) {
    super();
    this.parent = parent;
  }
}

export class Workspace extends Events {
  private activeEditorState: MarkdownFileInfo | null = null;
  activeLeaf: WorkspaceLeaf | null = null;
  readonly requestSaveLayout = debounce(async () => {
    this.trigger("layout-change");
  }, 0);
  readonly containerEl = workspaceContainer();
  readonly leftSplit = new WorkspaceSidedock(this, "vertical");
  readonly rightSplit = new WorkspaceSidedock(this, "vertical");
  readonly leftRibbon = new WorkspaceRibbon();
  readonly rightRibbon = new WorkspaceRibbon();
  readonly rootSplit = new WorkspaceRoot(this, "vertical");
  readonly floatingSplit = new WorkspaceSplit(this, "vertical");
  private readonly layoutReadyCallbacks = new Set<() => unknown>();
  private readonly leafGroups = new Map<WorkspaceLeaf, WorkspaceLeafGroup>();
  private readonly leaves = new Set<WorkspaceLeaf>();
  private readonly listeners = new Map<string, Set<EventCallback>>();
  private readonly leafParents = new Map<WorkspaceSplit, WorkspaceTabs>();
  private readonly leftLeaves = new Set<WorkspaceLeaf>();
  private readonly projectedLeaves = new Map<string, WorkspaceLeaf[]>();
  private readonly rightLeaves = new Set<WorkspaceLeaf>();
  private readonly recentLeaves: WorkspaceLeaf[] = [];
  private readonly recentFiles: string[] = [];
  private leafFactory: WorkspaceLeafFactory | null = null;
  private linkResolver: WorkspaceLinkResolver | null = null;
  private layoutReadyCallbackActive = false;
  private layoutReadyErrorHandler: ((error: unknown) => void) | null = null;
  private layoutReadyState = false;
  private mostRecentFile: TFile | null = null;
  private pendingLeafGroup: WorkspaceLeafGroup | null = null;
  private nextGroupId = 1;

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
      this.leftLeaves.delete(leaf);
      this.rightLeaves.delete(leaf);
      const recentLeafIndex = this.recentLeaves.indexOf(leaf);
      if (recentLeafIndex >= 0) {
        this.recentLeaves.splice(recentLeafIndex, 1);
      }
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

  setActiveLeaf(leaf: WorkspaceLeaf, _params?: { focus?: boolean }): void;
  setActiveLeaf(leaf: WorkspaceLeaf, pushHistory: boolean, focus: boolean): void;
  setActiveLeaf(
    leaf: WorkspaceLeaf,
    _paramsOrPushHistory?: { focus?: boolean } | boolean,
    _focus?: boolean,
  ): void {
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
      const recentFileIndex = this.recentFiles.indexOf(activeFile.path);
      if (recentFileIndex >= 0) {
        this.recentFiles.splice(recentFileIndex, 1);
      }
      this.recentFiles.unshift(activeFile.path);
      this.recentFiles.splice(10);
      this.trigger("file-open", activeFile);
    }
    const recentLeafIndex = this.recentLeaves.indexOf(leaf);
    if (recentLeafIndex >= 0) {
      this.recentLeaves.splice(recentLeafIndex, 1);
    }
    this.recentLeaves.unshift(leaf);
    const activeRegion = this.getLeafRegion(leaf);
    const visibleByRegion = new Map<"left-dock" | "main-document" | "right-dock", WorkspaceLeaf>([
      [activeRegion, leaf],
    ]);
    for (const candidate of this.recentLeaves) {
      const region = this.getLeafRegion(candidate);
      if (!visibleByRegion.has(region)) visibleByRegion.set(region, candidate);
    }
    for (const candidate of this.leaves) {
      const region = this.getLeafRegion(candidate);
      if (!visibleByRegion.has(region)) visibleByRegion.set(region, candidate);
    }
    for (const candidate of this.leaves) {
      this.setLeafVisibility(
        candidate,
        visibleByRegion.get(this.getLeafRegion(candidate)) === candidate,
      );
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

  async triggerAsync(name: string, ...args: unknown[]): Promise<void> {
    for (const callback of [...(this.listeners.get(name) ?? [])]) {
      await callback(...args);
    }
  }

  eventNames(): string[] {
    return [...this.listeners.entries()]
      .filter(([, callbacks]) => callbacks.size > 0)
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right, "en-US"));
  }

  offref(eventRef?: CompatibilityEventRef | null): void {
    eventRef?.off();
  }

  updateOptions(): void {
    this.trigger("layout-change");
  }

  async changeLayout(_workspace: unknown): Promise<void> {
    throw new Error(
      "Workspace layout replacement is not supported by this compatibility runtime; use Threadleaf workspace actions.",
    );
  }

  getLeavesOfType(viewType: string): WorkspaceLeaf[] {
    return [
      ...[...this.leaves].filter((leaf) => {
        const view = leaf.view;
        return (
          view !== null &&
          typeof view === "object" &&
          "getViewType" in view &&
          typeof view.getViewType === "function" &&
          view.getViewType() === viewType
        );
      }),
      ...(this.projectedLeaves.get(viewType) ?? []),
    ];
  }

  setProjectedLeaves(viewType: string, leaves: readonly WorkspaceLeaf[]): void {
    this.projectedLeaves.set(viewType, [...leaves]);
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
      if (leaf.view !== null) callback(leaf);
    }
  }

  iterateRootLeaves(callback: (leaf: WorkspaceLeaf) => unknown): void {
    for (const leaf of this.leaves) {
      if (leaf.view !== null && !this.leftLeaves.has(leaf) && !this.rightLeaves.has(leaf)) {
        callback(leaf);
      }
    }
  }

  getMostRecentLeaf(root?: WorkspaceParent): WorkspaceLeaf | null {
    const inRoot = (leaf: WorkspaceLeaf): boolean => {
      if (!root) {
        return !this.leftLeaves.has(leaf) && !this.rightLeaves.has(leaf);
      }
      if (root === this.rootSplit) {
        return !this.leftLeaves.has(leaf) && !this.rightLeaves.has(leaf);
      }
      if (root instanceof WorkspaceSplit) {
        return root.children.includes(leaf);
      }
      return leaf.parent === root;
    };
    return this.recentLeaves.find((leaf) => this.leaves.has(leaf) && inRoot(leaf)) ?? null;
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
    const mainLeaves = layoutLeaves(
      [...this.leaves].filter((leaf) => !this.leftLeaves.has(leaf) && !this.rightLeaves.has(leaf)),
    );
    const leftLeaves = layoutLeaves([...this.leftLeaves]);
    const rightLeaves = layoutLeaves([...this.rightLeaves]);
    const emptySplit = (): WorkspaceLayoutSplit => ({
      children: [],
      direction: "vertical",
      type: "split",
    });
    return {
      floating: emptySplit(),
      left: {
        children: leftLeaves,
        direction: "vertical",
        type: "split",
      },
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

  moveLeafToPopout(_leaf: WorkspaceLeaf, _data?: unknown): WorkspaceWindow {
    throw new Error("Workspace popout windows are not supported by this compatibility runtime.");
  }

  openPopoutLeaf(_data?: unknown): WorkspaceLeaf {
    throw new Error("Workspace popout windows are not supported by this compatibility runtime.");
  }

  getUnpinnedLeaf(): WorkspaceLeaf {
    return (
      [...this.leaves].find((leaf) => leaf.getViewState().pinned !== true) ?? this.getLeaf("tab")
    );
  }

  splitActiveLeaf(direction?: SplitDirection): WorkspaceLeaf {
    return this.getLeaf("split", direction);
  }

  async duplicateLeaf(leaf: WorkspaceLeaf, direction?: SplitDirection): Promise<WorkspaceLeaf>;
  async duplicateLeaf(
    leaf: WorkspaceLeaf,
    leafType: PaneType | boolean,
    direction?: SplitDirection,
  ): Promise<WorkspaceLeaf>;
  async duplicateLeaf(
    leaf: WorkspaceLeaf,
    leafTypeOrDirection: PaneType | boolean | SplitDirection = "split",
    direction?: SplitDirection,
  ): Promise<WorkspaceLeaf> {
    if (!this.leaves.has(leaf)) {
      throw new Error("Workspace leaf duplication requires a leaf from the active workspace.");
    }
    const isDirection = leafTypeOrDirection === "horizontal" || leafTypeOrDirection === "vertical";
    const leafType = isDirection ? "split" : leafTypeOrDirection;
    const splitDirection = isDirection ? leafTypeOrDirection : direction;
    const duplicate =
      leafType === "split" ? this.createLeafBySplit(leaf, splitDirection) : this.getLeaf(leafType);
    await duplicate.setViewState(leaf.getViewState());
    const groupMember = this.getLeafGroupMember(leaf);
    if (groupMember) {
      this.setLeafGroup(duplicate, groupMember);
    }
    return duplicate;
  }

  getLeftLeaf(split: boolean): WorkspaceLeaf | null {
    if (!split) {
      const existingLeaf = [...this.leftLeaves].at(-1);
      if (existingLeaf) {
        return existingLeaf;
      }
      if (!this.leafFactory) {
        return null;
      }
    }
    const leaf = this.createLeafBySplit(this.activeLeaf ?? this.getLeaf(false));
    this.leftLeaves.add(leaf);
    return leaf;
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

  getLeafRegion(leaf: WorkspaceLeaf): "left-dock" | "main-document" | "right-dock" {
    if (this.leftLeaves.has(leaf)) return "left-dock";
    if (this.rightLeaves.has(leaf)) return "right-dock";
    return "main-document";
  }

  getLeavesInRegion(region: "left-dock" | "main-document" | "right-dock"): WorkspaceLeaf[] {
    if (region === "left-dock") return [...this.leftLeaves];
    if (region === "right-dock") return [...this.rightLeaves];
    return [...this.leaves].filter(
      (leaf) => !this.leftLeaves.has(leaf) && !this.rightLeaves.has(leaf),
    );
  }

  ensureSideLeaf(
    type: string,
    side: Side,
    options: {
      active?: boolean;
      split?: boolean;
      reveal?: boolean;
      state?: Record<string, unknown>;
    } = {},
  ): Promise<WorkspaceLeaf> {
    if (side !== "left" && side !== "right") {
      return Promise.reject(new Error(`Unsupported workspace side: ${side}.`));
    }
    const sideLeaves = side === "left" ? this.leftLeaves : this.rightLeaves;
    let leaf = [...sideLeaves].find((candidate) => candidate.view?.getViewType() === type) ?? null;
    const needsCreation = leaf === null;
    if (!leaf) {
      leaf =
        side === "left"
          ? this.getLeftLeaf(options.split === true)
          : this.getRightLeaf(options.split === true);
    }
    if (!leaf) {
      return Promise.reject(
        new Error(
          `Workspace ${side} side leaf creation requires an installed compatibility leaf factory.`,
        ),
      );
    }
    const nextLeaf = leaf;
    const viewState = needsCreation
      ? {
          ...(options.active === undefined ? {} : { active: options.active }),
          state: options.state ?? {},
          type,
        }
      : null;
    return (async () => {
      if (viewState) {
        await nextLeaf.setViewState(viewState);
      }
      if (options.active === true) {
        this.setActiveLeaf(nextLeaf);
      }
      if (options.reveal !== false) {
        await this.revealLeaf(nextLeaf);
      }
      return nextLeaf;
    })();
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
    const file = this.resolveLinkText(linktext, sourcePath);
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
    if (effectiveOpenViewState?.active !== false && this.activeLeaf !== leaf) {
      this.setActiveLeaf(leaf);
    }
  }

  handleLinkContextMenu(
    menu: Menu,
    linktext: string,
    sourcePath: string,
    leaf?: WorkspaceLeaf,
  ): boolean {
    const file = this.resolveLinkText(linktext, sourcePath);
    if (!file) {
      return false;
    }
    menu.addItem((item) => {
      item
        .setTitle(`Open ${file.name}`)
        .setIcon("document")
        .onClick(() => {
          const destination = leaf ?? this.activeLeaf ?? this.getLeaf(false);
          const subpathIndex = linktext.indexOf("#");
          const subpath = subpathIndex >= 0 ? linktext.slice(subpathIndex) : "";
          const openViewState = subpath ? { state: { subpath } } : undefined;
          void destination
            .openFile(file, openViewState)
            .then(() => this.setActiveLeaf(destination))
            .catch((error) => this.reportLayoutReadyError(error));
        });
    });
    return true;
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

  setLeafGroupId(leaf: WorkspaceLeaf, groupId: string): void {
    if (!this.leaves.has(leaf)) {
      throw new Error("Workspace leaf groups require leaves from the active workspace.");
    }
    const normalizedGroupId = groupId.trim();
    if (!normalizedGroupId) {
      throw new Error("Workspace leaf groups require a non-empty group id.");
    }
    const currentGroup = this.groupForLeaf(leaf);
    if (!currentGroup) {
      throw new Error("Workspace leaf group is unavailable.");
    }
    const destination = [...this.leafGroups.values()].find(
      (group) => group.id === normalizedGroupId,
    );
    if (destination && destination !== currentGroup) {
      for (const member of [...currentGroup.leaves]) {
        this.assignLeafToGroup(member, destination);
      }
    } else {
      currentGroup.id = normalizedGroupId;
    }
    this.trigger("layout-change");
  }

  getGroupLeaves(group: string): WorkspaceLeaf[] {
    return [...this.leaves].filter((leaf) => this.groupForLeaf(leaf)?.id === group);
  }

  getLastOpenFiles(): string[] {
    return [...this.recentFiles];
  }

  getRecentFiles(options: { maxCount: number }): string[] {
    const maxCount = Number.isFinite(options?.maxCount)
      ? Math.max(0, Math.floor(options.maxCount))
      : this.recentFiles.length;
    return this.recentFiles.slice(0, maxCount);
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
    return {
      id: `threadleaf-group-${this.nextGroupId++}`,
      leaves: new Set<WorkspaceLeaf>(),
    };
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
    // Community plugin styles load after the host shell and can mark every workspace leaf as
    // `display: flex !important`. Mirror Obsidian's tab ownership at the inline-important level
    // so an inactive leaf cannot invisibly cover the active plugin surface.
    containerEl.style.setProperty("display", active ? "flex" : "none", "important");
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

  private resolveLinkText(linktext: string, sourcePath: string): TFile | null {
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
    return resolver?.(linktext, sourcePath) ?? null;
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

export interface CompatibilityHoverLinkSource {
  display: string;
  defaultMod: boolean;
}

export interface CompatibilityBasesViewRegistration {
  name: string;
  icon: string;
  factory: (controller: unknown, containerEl: HTMLElement) => unknown;
  options?: (config: unknown) => unknown[];
}

export interface CompatibilityObsidianProtocolData {
  action: string;
  [key: string]: string | "true";
}

export type CompatibilityObsidianProtocolHandler = (
  params: CompatibilityObsidianProtocolData,
) => unknown;

export interface CompatibilityCliFlag {
  value?: string;
  description: string;
  required?: boolean;
}

export type CompatibilityCliFlags = Record<string, CompatibilityCliFlag>;
export type CompatibilityCliData = Record<string, string | "true">;
export type CompatibilityCliHandler = (params: CompatibilityCliData) => string | Promise<string>;

interface HoverLinkSourceRegistration extends OwnedRegistration {
  id: string;
  info: CompatibilityHoverLinkSource;
}

interface ObsidianProtocolRegistration extends OwnedRegistration {
  action: string;
  handler: CompatibilityObsidianProtocolHandler;
}

interface CliRegistration extends OwnedRegistration {
  command: string;
  description: string;
  flags: CompatibilityCliFlags | null;
  handler: CompatibilityCliHandler;
}

export class CompatibilityIntegrationRegistry {
  private readonly editorExtensions: EditorExtensionRegistration[] = [];
  private readonly editorSuggests = new Map<unknown, string>();
  private readonly extensions: ExtensionRegistration[] = [];
  private readonly markdownPostProcessors: MarkdownProcessorRegistration[] = [];
  private readonly ribbonItems = new Set<HTMLElement>();
  private readonly settingTabs = new Set<SettingTabRegistration>();
  private readonly statusBarItems = new Set<HTMLElement>();
  private readonly views = new Map<string, ViewRegistration>();
  private readonly hoverLinkSources = new Map<string, HoverLinkSourceRegistration>();
  private readonly obsidianProtocolHandlers = new Map<string, ObsidianProtocolRegistration>();
  private readonly cliHandlers = new Map<string, CliRegistration>();
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

  registerHoverLinkSource(
    ownerId: string,
    id: string,
    info: CompatibilityHoverLinkSource,
  ): () => void {
    const normalizedId = requireNonEmptyRegistrationId(id, "hover link source");
    if (!info || typeof info.display !== "string" || typeof info.defaultMod !== "boolean") {
      throw new Error(`Invalid hover link source registration: ${normalizedId}`);
    }
    if (this.hoverLinkSources.has(normalizedId)) {
      throw new Error(`Hover link source already registered: ${normalizedId}`);
    }
    const registration: HoverLinkSourceRegistration = {
      ownerId,
      id: normalizedId,
      info: { display: info.display, defaultMod: info.defaultMod },
    };
    this.hoverLinkSources.set(normalizedId, registration);
    return () => {
      if (this.hoverLinkSources.get(normalizedId) === registration) {
        this.hoverLinkSources.delete(normalizedId);
      }
    };
  }

  getHoverLinkSource(id: string): CompatibilityHoverLinkSource | null {
    const registration = this.hoverLinkSources.get(id);
    return registration ? { ...registration.info } : null;
  }

  registerBasesView(
    _ownerId: string,
    viewId: string,
    registration: CompatibilityBasesViewRegistration,
  ): boolean {
    const normalizedId = requireNonEmptyRegistrationId(viewId, "Bases view");
    if (
      !registration ||
      typeof registration.name !== "string" ||
      typeof registration.icon !== "string" ||
      typeof registration.factory !== "function"
    ) {
      throw new Error(`Invalid Bases view registration: ${normalizedId}`);
    }
    return false;
  }

  registerObsidianProtocolHandler(
    ownerId: string,
    action: string,
    handler: CompatibilityObsidianProtocolHandler,
  ): () => void {
    const normalizedAction = requireNonEmptyRegistrationId(action, "Obsidian protocol action");
    if (typeof handler !== "function") {
      throw new Error(`Invalid Obsidian protocol handler: ${normalizedAction}`);
    }
    if (this.obsidianProtocolHandlers.has(normalizedAction)) {
      throw new Error(`Obsidian protocol action already registered: ${normalizedAction}`);
    }
    const registration: ObsidianProtocolRegistration = {
      ownerId,
      action: normalizedAction,
      handler,
    };
    this.obsidianProtocolHandlers.set(normalizedAction, registration);
    return () => {
      if (this.obsidianProtocolHandlers.get(normalizedAction) === registration) {
        this.obsidianProtocolHandlers.delete(normalizedAction);
      }
    };
  }

  invokeObsidianProtocol(params: CompatibilityObsidianProtocolData): unknown {
    const registration = this.obsidianProtocolHandlers.get(params.action);
    if (!registration) {
      throw new Error(`Obsidian protocol action is not registered: ${params.action}`);
    }
    return registration.handler({ ...params });
  }

  registerCliHandler(
    ownerId: string,
    command: string,
    description: string,
    flags: CompatibilityCliFlags | null,
    handler: CompatibilityCliHandler,
  ): () => void {
    const normalizedCommand = validateCliCommand(command);
    if (typeof description !== "string") {
      throw new Error(`Invalid CLI description: ${normalizedCommand}`);
    }
    if (flags !== null && (typeof flags !== "object" || Array.isArray(flags))) {
      throw new Error(`Invalid CLI flags: ${normalizedCommand}`);
    }
    if (typeof handler !== "function") {
      throw new Error(`Invalid CLI handler: ${normalizedCommand}`);
    }
    if (this.cliHandlers.has(normalizedCommand)) {
      throw new Error(`CLI command already registered: ${normalizedCommand}`);
    }
    const registration: CliRegistration = {
      ownerId,
      command: normalizedCommand,
      description,
      flags: flags ? { ...flags } : null,
      handler,
    };
    this.cliHandlers.set(normalizedCommand, registration);
    return () => {
      if (this.cliHandlers.get(normalizedCommand) === registration) {
        this.cliHandlers.delete(normalizedCommand);
      }
    };
  }

  async invokeCliHandler(command: string, params: CompatibilityCliData): Promise<string> {
    const registration = this.cliHandlers.get(command);
    if (!registration) {
      throw new Error(`CLI command is not registered: ${command}`);
    }
    return await registration.handler({ ...params });
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

  registerEditorSuggest(ownerId: string, editorSuggest: unknown): () => void {
    this.editorSuggests.set(editorSuggest, ownerId);
    return () => this.editorSuggests.delete(editorSuggest);
  }

  getEditorSuggests(): Array<{ ownerId: string; suggest: unknown }> {
    return [...this.editorSuggests].map(([suggest, ownerId]) => ({ ownerId, suggest }));
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
      .filter(({ ownerId }) => this.editorExtensionDeliveryAvailable(ownerId))
      .sort(
        (left, right) =>
          (ownerOrder.get(left.ownerId) ?? Number.MAX_SAFE_INTEGER) -
            (ownerOrder.get(right.ownerId) ?? Number.MAX_SAFE_INTEGER) ||
          left.sequence - right.sequence,
      )
      .map(({ extension }) => extension);
  }

  editorExtensionDeliveryAvailable(ownerId: string): boolean {
    return ownerId !== "templater-obsidian" && ownerId !== "obsidian-icon-folder";
  }

  hasUnavailableEditorExtensions(ownerId: string): boolean {
    return this.editorExtensions.some(
      (registration) =>
        registration.ownerId === ownerId && !this.editorExtensionDeliveryAvailable(ownerId),
    );
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
    ownerId?: string,
  ): Promise<void> {
    const registrations = this.markdownPostProcessors
      .filter((registration) => ownerId === undefined || registration.ownerId === ownerId)
      .sort(compareMarkdownProcessors);
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

  getViewTypesForOwner(ownerId: string): string[] {
    return [...this.views.values()]
      .filter((registration) => registration.ownerId === ownerId)
      .map((registration) => registration.type);
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

function requireNonEmptyRegistrationId(value: string, kind: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${kind} registration requires a non-empty identifier.`);
  }
  return normalized;
}

function validateCliCommand(command: string): string {
  const normalized = requireNonEmptyRegistrationId(command, "CLI command");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*$/u.test(normalized)) {
    throw new Error(`Invalid CLI command: ${command}`);
  }
  return normalized;
}
