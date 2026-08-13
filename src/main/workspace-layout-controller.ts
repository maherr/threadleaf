import {
  createDefaultWorkspaceLayout,
  parseWorkspaceLayout,
  type WorkspaceDockId,
  type WorkspaceLayoutDocument,
  type WorkspaceLayoutSnapshot,
} from "../shared/workspace-layout";

export interface WorkspaceLayoutStorePort {
  load(vaultId: string): Promise<WorkspaceLayoutDocument | null>;
  save(layout: WorkspaceLayoutDocument): Promise<WorkspaceLayoutDocument>;
}

export interface WorkspaceLayoutControllerOptions {
  store: WorkspaceLayoutStorePort;
  supportedPopoutViewTypes?: readonly string[];
}

type LayoutListener = (snapshot: WorkspaceLayoutSnapshot) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function snapshotOf(document: WorkspaceLayoutDocument): WorkspaceLayoutSnapshot {
  return {
    version: document.version,
    vaultId: document.vaultId,
    docks: {
      left: {
        id: "left",
        collapsed: document.docks.left.collapsed,
        viewType: document.docks.left.viewType,
        state: "ready",
        warning: null,
      },
      right: {
        id: "right",
        collapsed: document.docks.right.collapsed,
        viewType: document.docks.right.viewType,
        state: "ready",
        warning: null,
      },
    },
    mainWindowBounds: document.mainWindowBounds,
    popout: { ...document.popout },
  };
}

export class WorkspaceLayoutController {
  readonly #store: WorkspaceLayoutStorePort;
  readonly #supportedPopoutViewTypes: ReadonlySet<string>;
  readonly #listeners = new Set<LayoutListener>();
  #document: WorkspaceLayoutDocument | null = null;
  #warning: string | null = null;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceLayoutControllerOptions) {
    this.#store = options.store;
    this.#supportedPopoutViewTypes = new Set(options.supportedPopoutViewTypes ?? []);
  }

  async activateVault(vaultId: string): Promise<WorkspaceLayoutSnapshot> {
    this.#warning = null;
    try {
      this.#document = (await this.#store.load(vaultId)) ?? createDefaultWorkspaceLayout(vaultId);
    } catch (error) {
      this.#document = createDefaultWorkspaceLayout(vaultId);
      this.#warning = `Could not read saved workspace layout: ${errorMessage(error)} The file was not changed.`;
    }
    if (
      this.#document.popout.viewType &&
      !this.#supportedPopoutViewTypes.has(this.#document.popout.viewType)
    ) {
      this.#warning = `Saved pop-out view ${this.#document.popout.viewType} is unavailable in this build.`;
      this.#document = {
        ...this.#document,
        popout: {
          ...this.#document.popout,
          state: "degraded",
          warning: this.#warning,
        },
      };
    } else if (this.#document.popout.state === "open") {
      const warning =
        "The previous plugin pop-out was closed when Threadleaf restarted. Open its plugin view again in the main window.";
      this.#document = {
        ...this.#document,
        popout: {
          ...this.#document.popout,
          state: "degraded",
          warning,
        },
      };
    }
    const snapshot = this.snapshot();
    this.publish(snapshot);
    return snapshot;
  }

  get vaultId(): string {
    if (!this.#document) {
      throw new Error("Workspace layout has no active vault.");
    }
    return this.#document.vaultId;
  }

  snapshot(): WorkspaceLayoutSnapshot {
    if (!this.#document) {
      throw new Error("Workspace layout has no active vault.");
    }
    const snapshot = snapshotOf(this.#document);
    if (this.#warning) {
      snapshot.docks.left = { ...snapshot.docks.left, state: "degraded", warning: this.#warning };
      snapshot.docks.right = { ...snapshot.docks.right, state: "degraded", warning: this.#warning };
      snapshot.popout = { ...snapshot.popout, state: "degraded", warning: this.#warning };
    }
    return snapshot;
  }

  onSnapshot(listener: LayoutListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async setDockCollapsed(
    dockId: WorkspaceDockId,
    collapsed: boolean,
    expectedVaultId: string,
  ): Promise<WorkspaceLayoutSnapshot> {
    this.assertVault(expectedVaultId);
    const document = this.requireDocument();
    await this.persist({
      ...document,
      docks: { ...document.docks, [dockId]: { ...document.docks[dockId], collapsed } },
    });
    return this.snapshot();
  }

  async setMainWindowBounds(
    bounds: NonNullable<WorkspaceLayoutDocument["mainWindowBounds"]>,
    expectedVaultId: string,
  ): Promise<WorkspaceLayoutSnapshot> {
    this.assertVault(expectedVaultId);
    await this.persist({ ...this.requireDocument(), mainWindowBounds: bounds });
    return this.snapshot();
  }

  async setPopout(
    popout: WorkspaceLayoutDocument["popout"],
    expectedVaultId: string,
  ): Promise<WorkspaceLayoutSnapshot> {
    this.assertVault(expectedVaultId);
    if (popout.viewType && !this.#supportedPopoutViewTypes.has(popout.viewType)) {
      throw new Error(`Pop-out view type is not supported: ${popout.viewType}`);
    }
    await this.persist({ ...this.requireDocument(), popout });
    return this.snapshot();
  }

  async reattachPopout(
    expectedVaultId: string,
    warning: string | null = null,
  ): Promise<WorkspaceLayoutSnapshot> {
    this.assertVault(expectedVaultId);
    const document = this.requireDocument();
    await this.persist({
      ...document,
      popout: {
        state: warning ? "degraded" : "closed",
        viewType: warning ? document.popout.viewType : null,
        filePath: warning ? document.popout.filePath : null,
        bounds: document.popout.bounds,
        warning,
      },
    });
    return this.snapshot();
  }

  private requireDocument(): WorkspaceLayoutDocument {
    if (!this.#document) {
      throw new Error("Workspace layout has no active vault.");
    }
    return this.#document;
  }

  private assertVault(expectedVaultId: string): void {
    if (expectedVaultId !== this.vaultId) {
      throw new Error("The active vault changed before the workspace layout could be updated.");
    }
  }

  private async persist(document: WorkspaceLayoutDocument): Promise<void> {
    const normalized = parseWorkspaceLayout(document, this.vaultId);
    const write = this.#writeTail
      .catch(() => undefined)
      .then(async () => {
        const saved = await this.#store.save(normalized);
        this.#document = saved;
        this.#warning = null;
        this.publish(this.snapshot());
      });
    this.#writeTail = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
  }

  private publish(snapshot: WorkspaceLayoutSnapshot): void {
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }
}
