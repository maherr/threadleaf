import type { PluginIntegrationSnapshot } from "../shared/contracts";
import type {
  MarkdownCodeBlockProcessor,
  MarkdownPostProcessor,
  MarkdownPostProcessorContext,
} from "./obsidian-compat";
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
  direction: "horizontal" | "vertical";
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
  activeEditor: unknown | null = null;
  activeLeaf: unknown | null = null;
  readonly containerEl = workspaceContainer();
  readonly rootSplit = new WorkspaceSplit(this, "vertical");
  readonly floatingSplit = new WorkspaceSplit(this, "vertical");
  private readonly layoutReadyCallbacks = new Set<() => unknown>();
  private readonly leaves = new Set<unknown>();
  private readonly listeners = new Map<string, Set<EventCallback>>();
  private readonly rightLeaves = new Set<unknown>();
  private leafFactory: WorkspaceLeafFactory | null = null;
  private layoutReadyCallbackActive = false;
  private layoutReadyErrorHandler: ((error: unknown) => void) | null = null;
  private layoutReadyState = false;
  private mostRecentFile: unknown | null = null;

  get layoutReady(): boolean {
    return this.layoutReadyState;
  }

  setLeafFactory(factory: WorkspaceLeafFactory): void {
    this.leafFactory = factory;
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

  registerLeaf(leaf: unknown): () => void {
    this.leaves.add(leaf);
    if (this.activeLeaf === null) {
      this.setActiveLeaf(leaf);
    } else {
      this.setLeafVisibility(leaf, false);
    }
    return () => {
      this.leaves.delete(leaf);
      this.rightLeaves.delete(leaf);
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
    const activeView = this.leafView(leaf);
    this.activeEditor =
      activeView && "file" in activeView && "editor" in activeView && activeView.editor
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

  detachLeavesOfType(viewType: string): void {
    for (const leaf of this.getLeavesOfType(viewType)) {
      if (!leaf || typeof leaf !== "object" || !("detach" in leaf)) {
        continue;
      }
      const detach = leaf.detach;
      if (typeof detach === "function") {
        void detach.call(leaf);
      }
    }
  }

  iterateAllLeaves(callback: (leaf: unknown) => unknown): void {
    for (const leaf of this.leaves) {
      callback(leaf);
    }
  }

  getMostRecentLeaf(): unknown | null {
    return this.activeLeaf;
  }

  getActiveFile(): unknown | null {
    const activeFile = this.fileForLeaf(this.activeLeaf);
    if (activeFile) {
      this.mostRecentFile = activeFile;
      return activeFile;
    }
    return this.mostRecentFile;
  }

  getLayout(): WorkspaceLayout {
    const layoutLeaves = (leaves: unknown[]): WorkspaceLayoutLeaf[] =>
      leaves
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

  getLeaf(newLeaf?: boolean | string): unknown | null {
    if (newLeaf === true || typeof newLeaf === "string") {
      return this.createLeafBySplit(this.activeLeaf);
    }
    return this.activeLeaf ?? this.createLeafBySplit();
  }

  getUnpinnedLeaf(): unknown | null {
    return this.getLeaf(false);
  }

  splitActiveLeaf(direction?: "horizontal" | "vertical"): unknown | null {
    if (direction) {
      this.rootSplit.direction = direction;
    }
    return this.createLeafBySplit(this.activeLeaf);
  }

  getRightLeaf(split: boolean): unknown | null {
    if (!split) {
      const existingLeaf = [...this.rightLeaves].at(-1);
      if (existingLeaf) {
        return existingLeaf;
      }
    }
    const leaf = this.createLeafBySplit(this.activeLeaf);
    if (leaf) {
      this.rightLeaves.add(leaf);
    }
    return leaf;
  }

  async revealLeaf(leaf: unknown): Promise<void> {
    if (this.leaves.has(leaf)) {
      this.setActiveLeaf(leaf);
    }
  }

  async openLinkText(
    linktext: string,
    sourcePath: string,
    newLeaf?: "split" | "tab" | "window" | boolean,
    openViewState?: Record<string, unknown>,
  ): Promise<void> {
    const app = this.leafApp(this.activeLeaf);
    const metadataCache = app?.metadataCache;
    if (
      !metadataCache ||
      typeof metadataCache !== "object" ||
      !("getFirstLinkpathDest" in metadataCache) ||
      typeof metadataCache.getFirstLinkpathDest !== "function"
    ) {
      return;
    }
    const file = metadataCache.getFirstLinkpathDest(linktext, sourcePath);
    if (!file) {
      return;
    }
    const leaf = newLeaf ? this.getLeaf(newLeaf) : this.getLeaf(false);
    if (!leaf || typeof leaf !== "object" || !("openFile" in leaf)) {
      return;
    }
    const openFile = leaf.openFile;
    if (typeof openFile !== "function") {
      return;
    }
    await openFile.call(leaf, file, openViewState);
    this.setActiveLeaf(leaf);
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

  private fileForLeaf(leaf: unknown): unknown | null {
    const view = this.leafView(leaf);
    if (!view || !("file" in view)) {
      return null;
    }
    const file = view.file;
    return file && typeof file === "object" ? file : null;
  }

  private leafApp(leaf: unknown): Record<string, unknown> | null {
    if (!leaf || typeof leaf !== "object" || !("app" in leaf)) {
      return null;
    }
    const app = leaf.app;
    return app && typeof app === "object" ? (app as Record<string, unknown>) : null;
  }

  private leafView(leaf: unknown): Record<string, unknown> | null {
    if (!leaf || typeof leaf !== "object" || !("view" in leaf)) {
      return null;
    }
    const view = leaf.view;
    return view && typeof view === "object" ? (view as Record<string, unknown>) : null;
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
  private readonly editorExtensions = new Set<unknown>();
  private readonly editorSuggests = new Set<unknown>();
  private readonly extensions: ExtensionRegistration[] = [];
  private readonly markdownPostProcessors: MarkdownProcessorRegistration[] = [];
  private readonly ribbonItems = new Set<HTMLElement>();
  private readonly settingTabs = new Set<SettingTabRegistration>();
  private readonly statusBarItems = new Set<HTMLElement>();
  private readonly views = new Map<string, ViewRegistration>();
  private readonly icons = new Map<string, string>();
  private nextMarkdownProcessorSequence = 0;

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

  registerEditorExtension(editorExtension: unknown): () => void {
    this.editorExtensions.add(editorExtension);
    return () => this.editorExtensions.delete(editorExtension);
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
