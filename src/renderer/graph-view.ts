import type {
  VaultGraphMode,
  VaultGraphRequest,
  VaultGraphResponse,
  WorkspaceCensusSnapshot,
} from "../shared/contracts";
import {
  GRAPH_VIEWBOX_HEIGHT,
  GRAPH_VIEWBOX_WIDTH,
  layoutVaultGraph,
  type PositionedGraphNode,
} from "./graph-layout";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const graphPreferencePrefix = "threadleaf-graph-preferences:";

type ReadyGraph = Extract<VaultGraphResponse, { status: "ready" }>;

interface GraphContext {
  vaultId: string;
  vaultName: string;
  indexGeneration: string;
  censusState: WorkspaceCensusSnapshot["state"];
  rootPath: string | null;
}

interface GraphPreferences {
  depth: number;
  includeOrphans: boolean;
  showArrows: boolean;
}

export interface GraphViewControllerOptions {
  context(): GraphContext | null;
  load(request: VaultGraphRequest, expectedVaultId: string): Promise<VaultGraphResponse>;
  openNote(path: string): Promise<boolean>;
  setPluginSurfaceVisible(visible: boolean): void;
  report(message: string): void;
}

interface GraphElements {
  title: HTMLElement;
  context: HTMLElement;
  close: HTMLButtonElement;
  globalMode: HTMLButtonElement;
  localMode: HTMLButtonElement;
  search: HTMLInputElement;
  depth: HTMLSelectElement;
  depthField: HTMLElement;
  orphans: HTMLInputElement;
  arrows: HTMLInputElement;
  zoomOut: HTMLButtonElement;
  zoomIn: HTMLButtonElement;
  reset: HTMLButtonElement;
  zoomValue: HTMLElement;
  interaction: HTMLElement;
  canvas: SVGSVGElement;
  panSurface: SVGRectElement;
  scene: SVGGElement;
  status: HTMLElement;
  empty: HTMLElement;
  nodeList: HTMLElement;
}

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing graph view element: ${selector}`);
  }
  return element;
}

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, tag);
}

function defaultPreferences(): GraphPreferences {
  return { depth: 1, includeOrphans: false, showArrows: true };
}

function preferenceKey(vaultId: string): string {
  return `${graphPreferencePrefix}${vaultId}`;
}

function readPreferences(vaultId: string): GraphPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(preferenceKey(vaultId)) ?? "null") as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return defaultPreferences();
    }
    const value = parsed as Record<string, unknown>;
    return {
      depth:
        Number.isInteger(value.depth) &&
        (value.depth as number) >= 1 &&
        (value.depth as number) <= 4
          ? (value.depth as number)
          : 1,
      includeOrphans: value.includeOrphans === true,
      showArrows: value.showArrows !== false,
    };
  } catch {
    return defaultPreferences();
  }
}

function writePreferences(vaultId: string, preferences: GraphPreferences): void {
  localStorage.setItem(preferenceKey(vaultId), JSON.stringify(preferences));
}

function edgePath(source: PositionedGraphNode, target: PositionedGraphNode): string {
  if (source.path === target.path) {
    const size = source.radius * 2.4;
    return `M ${source.x} ${source.y - source.radius} c ${size} ${-size} ${size} ${size} 0 ${source.radius * 2}`;
  }
  return `M ${source.x} ${source.y} L ${target.x} ${target.y}`;
}

export class GraphViewController {
  readonly #elements: GraphElements;
  readonly #options: GraphViewControllerOptions;
  #mode: VaultGraphMode = "global";
  #rootPath: string | null = null;
  #response: ReadyGraph | null = null;
  #vaultId: string | null = null;
  #requestSerial = 0;
  #refreshTimer: number | undefined;
  #restoreFocus: HTMLElement | null = null;
  #panX = 0;
  #panY = 0;
  #zoom = 1;
  #dragPointer: number | null = null;
  #dragClientX = 0;
  #dragClientY = 0;

  constructor(
    readonly dialog: HTMLDialogElement,
    options: GraphViewControllerOptions,
  ) {
    this.#options = options;
    this.#elements = {
      title: requireElement(dialog, "#graph-title"),
      context: requireElement(dialog, "#graph-context"),
      close: requireElement(dialog, "#graph-close"),
      globalMode: requireElement(dialog, "#graph-mode-global"),
      localMode: requireElement(dialog, "#graph-mode-local"),
      search: requireElement(dialog, "#graph-search"),
      depth: requireElement(dialog, "#graph-depth"),
      depthField: requireElement(dialog, "#graph-depth-field"),
      orphans: requireElement(dialog, "#graph-orphans"),
      arrows: requireElement(dialog, "#graph-arrows"),
      zoomOut: requireElement(dialog, "#graph-zoom-out"),
      zoomIn: requireElement(dialog, "#graph-zoom-in"),
      reset: requireElement(dialog, "#graph-reset-view"),
      zoomValue: requireElement(dialog, "#graph-zoom-value"),
      interaction: requireElement(dialog, "#graph-interaction"),
      canvas: requireElement(dialog, "#graph-canvas"),
      panSurface: requireElement(dialog, "#graph-pan-surface"),
      scene: requireElement(dialog, "#graph-scene"),
      status: requireElement(dialog, "#graph-status"),
      empty: requireElement(dialog, "#graph-empty"),
      nodeList: requireElement(dialog, "#graph-node-list"),
    };
    this.#bindEvents();
  }

  get open(): boolean {
    return this.dialog.open;
  }

  async show(mode: VaultGraphMode): Promise<void> {
    const context = this.#options.context();
    if (!context) {
      this.#options.report("Open a vault before opening its graph.");
      return;
    }
    if (mode === "local" && !context.rootPath) {
      this.#options.report("Open a note before opening its local graph.");
      return;
    }
    this.#mode = mode;
    this.#rootPath = mode === "local" ? context.rootPath : null;
    this.#vaultId = context.vaultId;
    const preferences = readPreferences(context.vaultId);
    this.#elements.depth.value = String(preferences.depth);
    this.#elements.orphans.checked = preferences.includeOrphans;
    this.#elements.arrows.checked = preferences.showArrows;
    this.#elements.search.value = "";
    this.#resetTransform();
    this.#restoreFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!this.dialog.open) {
      this.#options.setPluginSurfaceVisible(false);
      this.dialog.showModal();
    }
    this.#syncControls(context);
    window.requestAnimationFrame(() => this.#elements.search.focus());
    await this.#refresh();
  }

  close(restoreFocus = true): void {
    if (!this.dialog.open) {
      return;
    }
    this.#requestSerial += 1;
    if (this.#refreshTimer !== undefined) {
      window.clearTimeout(this.#refreshTimer);
      this.#refreshTimer = undefined;
    }
    this.dialog.close();
    this.#options.setPluginSurfaceVisible(true);
    const restoreTarget = this.#restoreFocus;
    this.#restoreFocus = null;
    if (restoreFocus && restoreTarget?.isConnected) {
      restoreTarget.focus();
    }
  }

  onSnapshot(context: GraphContext): void {
    if (!this.dialog.open) {
      return;
    }
    if (this.#vaultId !== context.vaultId) {
      this.close(false);
      this.#options.report("The graph closed because the active vault changed.");
      return;
    }
    if (
      this.#response &&
      (this.#response.indexGeneration !== context.indexGeneration ||
        this.#response.census.state !== context.censusState)
    ) {
      this.#scheduleRefresh(80);
    }
  }

  destroy(): void {
    if (this.#refreshTimer !== undefined) {
      window.clearTimeout(this.#refreshTimer);
    }
    this.#requestSerial += 1;
  }

  #bindEvents(): void {
    this.#elements.close.addEventListener("click", () => this.close());
    this.dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.close();
    });
    this.dialog.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape") {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.close();
      },
      { capture: true },
    );
    this.#elements.globalMode.addEventListener("click", () => {
      this.#mode = "global";
      this.#rootPath = null;
      this.#resetTransform();
      this.#syncControls(this.#options.context());
      void this.#refresh();
    });
    this.#elements.localMode.addEventListener("click", () => {
      const context = this.#options.context();
      if (!context?.rootPath) {
        this.#options.report("Open a note before switching to a local graph.");
        return;
      }
      this.#mode = "local";
      this.#rootPath = context.rootPath;
      this.#resetTransform();
      this.#syncControls(context);
      void this.#refresh();
    });
    this.#elements.search.addEventListener("input", () => this.#scheduleRefresh(130));
    this.#elements.depth.addEventListener("change", () => {
      this.#savePreferences();
      void this.#refresh();
    });
    this.#elements.orphans.addEventListener("change", () => {
      this.#savePreferences();
      void this.#refresh();
    });
    this.#elements.arrows.addEventListener("change", () => {
      this.#savePreferences();
      this.#renderGraph();
    });
    this.#elements.zoomOut.addEventListener("click", () => this.#setZoom(this.#zoom / 1.2));
    this.#elements.zoomIn.addEventListener("click", () => this.#setZoom(this.#zoom * 1.2));
    this.#elements.reset.addEventListener("click", () => this.#resetTransform());
    this.#elements.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = this.#elements.canvas.getBoundingClientRect();
        const cursorX = ((event.clientX - rect.left) / rect.width) * GRAPH_VIEWBOX_WIDTH;
        const cursorY = ((event.clientY - rect.top) / rect.height) * GRAPH_VIEWBOX_HEIGHT;
        this.#setZoom(this.#zoom * (event.deltaY < 0 ? 1.13 : 1 / 1.13), cursorX, cursorY);
      },
      { passive: false },
    );
    this.#elements.interaction.addEventListener("keydown", (event) => {
      const amount = 28 / this.#zoom;
      if (event.key === "ArrowLeft") {
        this.#panX += amount;
      } else if (event.key === "ArrowRight") {
        this.#panX -= amount;
      } else if (event.key === "ArrowUp") {
        this.#panY += amount;
      } else if (event.key === "ArrowDown") {
        this.#panY -= amount;
      } else if (event.key === "+" || event.key === "=") {
        this.#setZoom(this.#zoom * 1.2);
        event.preventDefault();
        return;
      } else if (event.key === "-") {
        this.#setZoom(this.#zoom / 1.2);
        event.preventDefault();
        return;
      } else if (event.key === "0") {
        this.#resetTransform();
        event.preventDefault();
        return;
      } else {
        return;
      }
      event.preventDefault();
      this.#renderTransform();
    });
    this.#elements.panSurface.addEventListener("pointerdown", (event) => {
      this.#dragPointer = event.pointerId;
      this.#dragClientX = event.clientX;
      this.#dragClientY = event.clientY;
      this.#elements.canvas.setPointerCapture(event.pointerId);
      this.#elements.canvas.dataset.dragging = "true";
    });
    this.#elements.canvas.addEventListener("pointermove", (event) => {
      if (this.#dragPointer !== event.pointerId) {
        return;
      }
      const rect = this.#elements.canvas.getBoundingClientRect();
      this.#panX += ((event.clientX - this.#dragClientX) / rect.width) * GRAPH_VIEWBOX_WIDTH;
      this.#panY += ((event.clientY - this.#dragClientY) / rect.height) * GRAPH_VIEWBOX_HEIGHT;
      this.#dragClientX = event.clientX;
      this.#dragClientY = event.clientY;
      this.#renderTransform();
    });
    const endDrag = (event: PointerEvent): void => {
      if (this.#dragPointer !== event.pointerId) {
        return;
      }
      this.#dragPointer = null;
      this.#elements.canvas.dataset.dragging = "false";
      if (this.#elements.canvas.hasPointerCapture(event.pointerId)) {
        this.#elements.canvas.releasePointerCapture(event.pointerId);
      }
    };
    this.#elements.canvas.addEventListener("pointerup", endDrag);
    this.#elements.canvas.addEventListener("pointercancel", endDrag);
  }

  #scheduleRefresh(delay: number): void {
    if (this.#refreshTimer !== undefined) {
      window.clearTimeout(this.#refreshTimer);
    }
    this.#refreshTimer = window.setTimeout(() => {
      this.#refreshTimer = undefined;
      void this.#refresh();
    }, delay);
  }

  #syncControls(context: GraphContext | null): void {
    this.#elements.globalMode.setAttribute("aria-pressed", String(this.#mode === "global"));
    this.#elements.localMode.setAttribute("aria-pressed", String(this.#mode === "local"));
    this.#elements.depthField.hidden = this.#mode !== "local";
    this.#elements.orphans.disabled = this.#mode === "local";
    this.#elements.title.textContent = this.#mode === "local" ? "Local graph" : "Vault graph";
    this.#elements.context.textContent =
      this.#mode === "local"
        ? (this.#rootPath ?? "No note selected")
        : (context?.vaultName ?? "Active vault");
  }

  #preferences(): GraphPreferences {
    return {
      depth: Number(this.#elements.depth.value),
      includeOrphans: this.#elements.orphans.checked,
      showArrows: this.#elements.arrows.checked,
    };
  }

  #savePreferences(): void {
    if (this.#vaultId) {
      writePreferences(this.#vaultId, this.#preferences());
    }
  }

  async #refresh(): Promise<void> {
    const context = this.#options.context();
    if (!context || !this.dialog.open || context.vaultId !== this.#vaultId) {
      return;
    }
    const serial = ++this.#requestSerial;
    const request: VaultGraphRequest = {
      mode: this.#mode,
      rootPath: this.#mode === "local" ? this.#rootPath : null,
      depth: Number(this.#elements.depth.value),
      query: this.#elements.search.value,
      includeOrphans: this.#mode === "global" && this.#elements.orphans.checked,
    };
    this.#elements.status.dataset.state = "loading";
    this.#elements.status.textContent = "Mapping indexed links…";
    try {
      const response = await this.#options.load(request, context.vaultId);
      if (serial !== this.#requestSerial || !this.dialog.open) {
        return;
      }
      if (response.status === "stale-vault") {
        this.close(false);
        this.#options.report("The graph request belonged to a vault that is no longer active.");
        return;
      }
      this.#response = response;
      this.#renderGraph();
    } catch (error) {
      if (serial !== this.#requestSerial) {
        return;
      }
      this.#response = null;
      this.#elements.scene.replaceChildren();
      this.#elements.nodeList.replaceChildren();
      this.#elements.empty.hidden = false;
      this.#elements.empty.textContent = "The graph could not be built.";
      this.#elements.status.dataset.state = "error";
      this.#elements.status.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  #renderGraph(): void {
    const response = this.#response;
    if (!response) {
      return;
    }
    const positioned = layoutVaultGraph(response);
    const positions = new Map(positioned.map((node) => [node.path, node]));
    const fragment = document.createDocumentFragment();
    const edges = svgElement("g");
    edges.classList.add("graph-edges");
    for (const edge of response.edges) {
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (!source || !target) {
        continue;
      }
      const path = svgElement("path");
      path.classList.add("graph-edge");
      path.dataset.source = edge.source;
      path.dataset.target = edge.target;
      path.dataset.occurrences = String(edge.occurrences);
      path.setAttribute("d", edgePath(source, target));
      path.setAttribute("vector-effect", "non-scaling-stroke");
      path.setAttribute("stroke-width", String(Math.min(4, 1 + Math.log2(edge.occurrences + 1))));
      if (this.#elements.arrows.checked && source.path !== target.path) {
        path.setAttribute("marker-end", "url(#graph-arrowhead)");
      }
      edges.append(path);
    }
    fragment.append(edges);

    const nodes = svgElement("g");
    nodes.classList.add("graph-nodes");
    const visibleLabelPaths = new Set(
      [...positioned]
        .sort(
          (left, right) =>
            right.neighborCount - left.neighborCount || left.path.localeCompare(right.path),
        )
        .slice(0, 44)
        .map((node) => node.path),
    );
    for (const node of positioned) {
      const group = svgElement("g");
      group.classList.add("graph-node");
      if (node.distance === 0) {
        group.classList.add("is-root");
      }
      group.dataset.path = node.path;
      group.setAttribute("transform", `translate(${node.x} ${node.y})`);
      group.setAttribute("role", "button");
      group.setAttribute("tabindex", "0");
      group.setAttribute(
        "aria-label",
        `${node.title}, ${node.neighborCount} connection${node.neighborCount === 1 ? "" : "s"}`,
      );
      const circle = svgElement("circle");
      circle.setAttribute("r", String(node.radius));
      const label = svgElement("text");
      label.textContent = node.title;
      label.setAttribute("x", String(node.radius + 7));
      label.setAttribute("y", "4");
      label.dataset.visible = String(visibleLabelPaths.has(node.path));
      group.append(circle, label);
      group.addEventListener("mouseenter", () => this.#highlight(node.path));
      group.addEventListener("mouseleave", () => this.#highlight(null));
      group.addEventListener("focus", () => this.#highlight(node.path));
      group.addEventListener("blur", () => this.#highlight(null));
      group.addEventListener("click", () => void this.#openNode(node.path));
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void this.#openNode(node.path);
        }
      });
      nodes.append(group);
    }
    fragment.append(nodes);
    this.#elements.scene.replaceChildren(fragment);
    this.#renderNodeList(positioned);
    this.#elements.empty.hidden = positioned.length > 0;
    this.#elements.empty.textContent =
      response.query.trim() === ""
        ? "No linked notes match these options."
        : "No notes match this filter.";
    const shown = `${positioned.length} of ${response.totalNodes} note${response.totalNodes === 1 ? "" : "s"}`;
    const edgesShown = `${response.edges.length} of ${response.totalEdges} link${response.totalEdges === 1 ? "" : "s"}`;
    const censusState = response.census.state;
    const censusCurrent = censusState === "current";
    this.#elements.status.dataset.state = !censusCurrent
      ? censusState === "degraded"
        ? "degraded"
        : "warming"
      : response.truncated
        ? "limited"
        : "ready";
    const censusNotice = !censusCurrent
      ? censusState === "degraded"
        ? "Index census degraded; graph may be incomplete"
        : "Index warming; graph will update when ready"
      : null;
    this.#elements.status.textContent = `${censusNotice ? `${censusNotice} · ` : ""}${shown} · ${edgesShown}${response.truncated ? " · display limit reached" : ""}`;
    this.#renderTransform();
  }

  #renderNodeList(nodes: readonly PositionedGraphNode[]): void {
    const fragment = document.createDocumentFragment();
    for (const node of [...nodes].sort((left, right) => left.path.localeCompare(right.path))) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "graph-note-row";
      button.dataset.path = node.path;
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = node.title;
      const path = document.createElement("small");
      path.textContent = node.path;
      copy.append(title, path);
      const count = document.createElement("span");
      count.className = "graph-note-count";
      count.textContent =
        node.distance === null
          ? String(node.neighborCount)
          : node.distance === 0
            ? "Root"
            : `D${node.distance}`;
      count.setAttribute(
        "aria-label",
        node.distance === null
          ? `${node.neighborCount} connections`
          : node.distance === 0
            ? "Local graph root"
            : `Distance ${node.distance}`,
      );
      button.append(copy, count);
      button.addEventListener("mouseenter", () => this.#highlight(node.path));
      button.addEventListener("mouseleave", () => this.#highlight(null));
      button.addEventListener("focus", () => this.#highlight(node.path));
      button.addEventListener("blur", () => this.#highlight(null));
      button.addEventListener("click", () => void this.#openNode(node.path));
      fragment.append(button);
    }
    this.#elements.nodeList.replaceChildren(fragment);
  }

  #highlight(path: string | null): void {
    const connected = new Set<string>();
    if (path) {
      connected.add(path);
      for (const edge of this.#response?.edges ?? []) {
        if (edge.source === path) {
          connected.add(edge.target);
        }
        if (edge.target === path) {
          connected.add(edge.source);
        }
      }
    }
    for (const node of this.#elements.scene.querySelectorAll<SVGGElement>(".graph-node")) {
      const nodePath = node.dataset.path ?? "";
      node.classList.toggle("is-active", nodePath === path);
      node.classList.toggle(
        "is-neighbor",
        Boolean(path && connected.has(nodePath) && nodePath !== path),
      );
      node.classList.toggle("is-dimmed", Boolean(path && !connected.has(nodePath)));
    }
    for (const edge of this.#elements.scene.querySelectorAll<SVGPathElement>(".graph-edge")) {
      const active = Boolean(
        path && (edge.dataset.source === path || edge.dataset.target === path),
      );
      edge.classList.toggle("is-active", active);
      edge.classList.toggle("is-dimmed", Boolean(path && !active));
    }
    for (const row of this.#elements.nodeList.querySelectorAll<HTMLElement>(".graph-note-row")) {
      row.classList.toggle("is-active", row.dataset.path === path);
      row.classList.toggle("is-dimmed", Boolean(path && !connected.has(row.dataset.path ?? "")));
    }
  }

  async #openNode(path: string): Promise<void> {
    this.close(false);
    const opened = await this.#options.openNote(path);
    if (!opened) {
      this.#options.report("Save or revert the open draft before navigating from the graph.");
    }
  }

  #setZoom(
    value: number,
    anchorX = GRAPH_VIEWBOX_WIDTH / 2,
    anchorY = GRAPH_VIEWBOX_HEIGHT / 2,
  ): void {
    const next = Math.max(0.5, Math.min(2.5, value));
    const contentX = (anchorX - this.#panX) / this.#zoom;
    const contentY = (anchorY - this.#panY) / this.#zoom;
    this.#panX = anchorX - contentX * next;
    this.#panY = anchorY - contentY * next;
    this.#zoom = next;
    this.#renderTransform();
  }

  #resetTransform(): void {
    this.#panX = 0;
    this.#panY = 0;
    this.#zoom = 1;
    this.#renderTransform();
  }

  #renderTransform(): void {
    this.#elements.scene.setAttribute(
      "transform",
      `translate(${this.#panX} ${this.#panY}) scale(${this.#zoom})`,
    );
    this.#elements.zoomValue.textContent = `${Math.round(this.#zoom * 100)}%`;
  }
}
