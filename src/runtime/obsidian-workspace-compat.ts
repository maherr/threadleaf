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

export class Workspace {
  activeLeaf: unknown | null = null;
  private readonly layoutReadyCallbacks = new Set<() => unknown>();
  private readonly listeners = new Map<string, Set<EventCallback>>();
  private layoutReady = false;

  onLayoutReady(callback: () => unknown): void {
    if (this.layoutReady) {
      queueMicrotask(callback);
      return;
    }
    this.layoutReadyCallbacks.add(callback);
  }

  markLayoutReady(): void {
    if (this.layoutReady) {
      return;
    }
    this.layoutReady = true;
    const callbacks = [...this.layoutReadyCallbacks];
    this.layoutReadyCallbacks.clear();
    for (const callback of callbacks) {
      callback();
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

  getLeavesOfType(_viewType: string): unknown[] {
    return [];
  }

  getMostRecentLeaf(): unknown | null {
    return this.activeLeaf;
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

export interface CompatibilityIntegrationSnapshot {
  editorSuggests: number;
  markdownPostProcessors: number;
  ribbonItems: number;
  settingTabs: number;
  statusBarItems: number;
  viewTypes: string[];
}

export class CompatibilityIntegrationRegistry {
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
    const registration = { ownerId, extensions: [...extensions], viewType };
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

  loadPluginData(pluginId: string): unknown | null {
    return this.pluginData.get(pluginId) ?? null;
  }

  savePluginData(pluginId: string, data: unknown): void {
    this.pluginData.set(pluginId, structuredClone(data));
  }

  snapshot(): CompatibilityIntegrationSnapshot {
    return {
      editorSuggests: this.editorSuggests.size,
      markdownPostProcessors: this.markdownPostProcessors.size,
      ribbonItems: this.ribbonItems.size,
      settingTabs: this.settingTabs.size,
      statusBarItems: this.statusBarItems.size,
      viewTypes: [...this.views.keys()].sort(),
    };
  }
}
