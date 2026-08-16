import {
  type CanvasNode,
  MutableJsonCanvas,
  serializeJsonCanvas,
} from "../application/json-canvas";
import type {
  CanvasAttachmentResponse,
  CanvasSaveResponse,
  WorkspaceCanvasSnapshot,
} from "../shared/contracts";

export interface CanvasViewCallbacks {
  openPath(path: string): void | Promise<void>;
  save(path: string, content: string, revision: string): Promise<CanvasSaveResponse>;
  loadAttachment(sourceCanvasPath: string, target: string): Promise<CanvasAttachmentResponse>;
}

type CanvasBoardNode = CanvasNode & { id: string };

function button(label: string, className = ""): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.className = className;
  element.setAttribute("aria-label", label);
  return element;
}

function titleForPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function isMarkdownPath(path: string): boolean {
  return path.toLocaleLowerCase("en-US").endsWith(".md");
}

function isCanvasPath(path: string): boolean {
  return path.toLocaleLowerCase("en-US").endsWith(".canvas");
}

function isExternalPath(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//");
}

export class CanvasViewController {
  readonly #root: HTMLElement;
  readonly #callbacks: CanvasViewCallbacks;
  #path: string | null = null;
  #revision = "";
  #model: MutableJsonCanvas | null = null;
  #dirty = false;
  #scale = 1;
  #status: HTMLElement | null = null;
  #board: HTMLElement | null = null;
  #objectList: HTMLOListElement | null = null;
  #saveButton: HTMLButtonElement | null = null;

  constructor(root: HTMLElement, callbacks: CanvasViewCallbacks) {
    this.#root = root;
    this.#callbacks = callbacks;
    this.#root.classList.add("canvas-view");
  }

  clear(): void {
    this.#root.replaceChildren();
    this.#root.hidden = true;
    this.#path = null;
    this.#revision = "";
    this.#model = null;
    this.#dirty = false;
  }

  render(snapshot: WorkspaceCanvasSnapshot): void {
    this.#root.hidden = false;
    if (this.#path === snapshot.path && this.#dirty && this.#model) {
      // Keep the revision from the version the user started editing. Saving
      // against that revision is what makes an external edit produce a
      // recoverable conflict instead of silently overwriting it.
      return;
    }
    this.#path = snapshot.path;
    this.#revision = snapshot.revision;
    this.#dirty = false;
    this.#model = snapshot.document ? new MutableJsonCanvas(snapshot.document) : null;
    this.#scale = 1;
    this.#renderSurface(snapshot);
  }

  #renderSurface(snapshot: WorkspaceCanvasSnapshot): void {
    this.#root.replaceChildren();
    const toolbar = document.createElement("div");
    toolbar.className = "canvas-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Canvas controls");
    const title = document.createElement("strong");
    title.className = "canvas-toolbar-title";
    title.textContent = titleForPath(snapshot.path);
    toolbar.append(title);
    const zoomLabel = document.createElement("span");
    zoomLabel.className = "canvas-zoom-label";
    zoomLabel.setAttribute("aria-live", "polite");
    const updateZoom = (): void => {
      zoomLabel.textContent = `Zoom ${Math.round(this.#scale * 100)}%`;
      if (this.#board) {
        this.#board.style.setProperty("--canvas-scale", String(this.#scale));
      }
    };
    const zoomOut = button("−", "canvas-tool");
    zoomOut.title = "Zoom out";
    zoomOut.addEventListener("click", () => {
      this.#scale = Math.max(0.5, Number((this.#scale - 0.1).toFixed(2)));
      updateZoom();
    });
    const zoomIn = button("+", "canvas-tool");
    zoomIn.title = "Zoom in";
    zoomIn.addEventListener("click", () => {
      this.#scale = Math.min(2, Number((this.#scale + 0.1).toFixed(2)));
      updateZoom();
    });
    const zoomReset = button("100%", "canvas-tool");
    zoomReset.title = "Reset zoom";
    zoomReset.addEventListener("click", () => {
      this.#scale = 1;
      updateZoom();
    });
    toolbar.append(zoomOut, zoomIn, zoomReset, zoomLabel);
    const readOnly = snapshot.readOnly || !this.#model;
    const addText = button("Add text", "canvas-tool canvas-edit-tool");
    addText.disabled = readOnly;
    addText.addEventListener("click", () => {
      if (!this.#model) return;
      this.#model.addText("New canvas text", { x: 40, y: 40, width: 260, height: 120 });
      this.#markDirty();
      this.#renderDocument(snapshot, updateZoom);
    });
    const addGroup = button("Add group", "canvas-tool canvas-edit-tool");
    addGroup.disabled = readOnly;
    addGroup.addEventListener("click", () => {
      if (!this.#model) return;
      this.#model.addGroup("New group", { x: 80, y: 80, width: 360, height: 220 });
      this.#markDirty();
      this.#renderDocument(snapshot, updateZoom);
    });
    const addFile = button("Add file", "canvas-tool canvas-edit-tool");
    addFile.disabled = readOnly;
    addFile.addEventListener("click", () => {
      if (!this.#model) return;
      this.#model.addFile("Welcome.md", { x: 120, y: 120, width: 260, height: 120 });
      this.#markDirty();
      this.#renderDocument(snapshot, updateZoom);
    });
    const addLink = button("Add link", "canvas-tool canvas-edit-tool");
    addLink.disabled = readOnly;
    addLink.addEventListener("click", () => {
      if (!this.#model) return;
      this.#model.addLink("https://example.test/inactive", {
        x: 160,
        y: 160,
        width: 280,
        height: 120,
      });
      this.#markDirty();
      this.#renderDocument(snapshot, updateZoom);
    });
    const connect = button("Connect first two", "canvas-tool canvas-edit-tool");
    connect.disabled = readOnly || (this.#model?.snapshot().nodes?.length ?? 0) < 2;
    connect.addEventListener("click", () => {
      const nodes = this.#model?.snapshot().nodes ?? [];
      const [from, to] = nodes;
      if (!from || !to || !this.#model) return;
      this.#model.connect(from.id, to.id, "right", "left");
      this.#markDirty();
      this.#renderDocument(snapshot, updateZoom);
    });
    this.#saveButton = button("Save", "canvas-tool canvas-save-tool");
    this.#saveButton.disabled = readOnly || !this.#dirty;
    this.#saveButton.addEventListener("click", () => void this.#save(snapshot));
    toolbar.append(addText, addGroup, addFile, addLink, connect, this.#saveButton);
    this.#status = document.createElement("span");
    this.#status.className = "canvas-status";
    this.#status.setAttribute("role", "status");
    this.#status.textContent = readOnly ? "Read-only" : "Ready";
    toolbar.append(this.#status);
    this.#root.append(toolbar);

    if (snapshot.diagnostics.length > 0) {
      const diagnosticPanel = document.createElement("aside");
      diagnosticPanel.className = "canvas-diagnostics";
      diagnosticPanel.setAttribute("role", "alert");
      const heading = document.createElement("strong");
      heading.textContent = "Read-only: this canvas has validation issues";
      diagnosticPanel.append(heading);
      const list = document.createElement("ul");
      for (const diagnostic of snapshot.diagnostics) {
        const item = document.createElement("li");
        item.textContent = `${diagnostic.path}: ${diagnostic.message}`;
        list.append(item);
      }
      diagnosticPanel.append(list);
      this.#root.append(diagnosticPanel);
    }

    if (!this.#model) {
      const empty = document.createElement("p");
      empty.className = "canvas-empty";
      empty.textContent =
        "No editable canvas model is available. The original file remains untouched.";
      this.#root.append(empty);
      return;
    }
    this.#renderDocument(snapshot, updateZoom);
    updateZoom();
  }

  #renderDocument(snapshot: WorkspaceCanvasSnapshot, updateZoom: () => void): void {
    if (!this.#model) return;
    const modelDocument = this.#model.snapshot();
    const shell = this.#root.querySelector<HTMLElement>(".canvas-content");
    shell?.remove();
    const content = document.createElement("div");
    content.className = "canvas-content";
    const objectSection = document.createElement("section");
    objectSection.className = "canvas-object-panel";
    const objectHeading = document.createElement("h3");
    objectHeading.textContent = "Objects";
    objectSection.append(objectHeading);
    this.#objectList = document.createElement("ol");
    this.#objectList.className = "canvas-object-list";
    this.#objectList.setAttribute("aria-label", "Canvas objects");
    objectSection.append(this.#objectList);
    const boardScroller = document.createElement("section");
    boardScroller.className = "canvas-board-scroller";
    boardScroller.tabIndex = 0;
    boardScroller.setAttribute(
      "aria-label",
      "Canvas board. Use the object list for keyboard navigation.",
    );
    this.#board = document.createElement("div");
    this.#board.className = "canvas-board";
    this.#board.setAttribute("role", "group");
    this.#board.setAttribute("aria-label", `${titleForPath(snapshot.path)} canvas board`);
    boardScroller.append(this.#board);
    content.append(objectSection, boardScroller);
    this.#root.append(content);
    this.#board.style.setProperty("--canvas-scale", String(this.#scale));
    for (const node of modelDocument.nodes ?? []) {
      if (!node || typeof node !== "object") {
        continue;
      }
      this.#renderNode(node as CanvasBoardNode, snapshot, updateZoom);
    }
    const edges = (modelDocument.edges ?? []).filter((edge): edge is NonNullable<typeof edge> =>
      Boolean(edge && typeof edge === "object"),
    );
    if (edges.length > 0) {
      const edgeSection = document.createElement("section");
      edgeSection.className = "canvas-edge-panel";
      const edgeHeading = document.createElement("h3");
      edgeHeading.textContent = "Connections";
      edgeSection.append(edgeHeading);
      const edgeList = document.createElement("ul");
      edgeList.className = "canvas-edge-list";
      for (const edge of edges) {
        const item = document.createElement("li");
        const label = document.createElement("input");
        label.type = "text";
        label.value = edge.label ?? "Connection";
        label.disabled = snapshot.readOnly;
        label.setAttribute("aria-label", `Label for connection ${edge.id}`);
        label.addEventListener("change", () => {
          this.#model?.editEdgeLabel(edge.id, label.value);
          this.#markDirty();
        });
        const description = document.createElement("span");
        description.textContent = `: ${edge.fromNode} → ${edge.toNode}`;
        const remove = button("Remove connection", "canvas-node-action");
        remove.disabled = snapshot.readOnly;
        remove.addEventListener("click", () => {
          this.#model?.removeEdge(edge.id);
          this.#markDirty();
          this.#renderDocument(snapshot, updateZoom);
        });
        item.append(label, description, remove);
        edgeList.append(item);
      }
      edgeSection.append(edgeList);
      this.#root.append(edgeSection);
    }
    updateZoom();
  }

  #renderNode(
    node: CanvasBoardNode,
    snapshot: WorkspaceCanvasSnapshot,
    updateZoom: () => void,
  ): void {
    if (!this.#board || !this.#objectList) return;
    const card = document.createElement("article");
    card.className = `canvas-node canvas-node-${node.type}`;
    card.dataset.nodeId = node.id;
    card.style.left = `${node.x}px`;
    card.style.top = `${node.y}px`;
    card.style.width = `${node.width}px`;
    card.style.minHeight = `${node.height}px`;
    card.tabIndex = 0;
    card.setAttribute("aria-label", `${node.type} object ${node.id}`);
    const header = document.createElement("header");
    header.className = "canvas-node-header";
    const nodeName = document.createElement("strong");
    nodeName.textContent = node.type;
    const nodeId = document.createElement("span");
    nodeId.textContent = node.id;
    header.append(nodeName, nodeId);
    card.append(header);
    const body = document.createElement("div");
    body.className = "canvas-node-body";
    const readOnly = snapshot.readOnly;
    if (node.type === "text") {
      const editor = document.createElement("textarea");
      editor.value = typeof node.text === "string" ? node.text : "";
      editor.disabled = readOnly;
      editor.setAttribute("aria-label", `Text for ${node.id}`);
      editor.addEventListener("change", () => {
        this.#model?.editText(node.id, editor.value);
        this.#markDirty();
      });
      body.append(editor);
    } else if (node.type === "group") {
      const label = document.createElement("input");
      label.value = typeof node.label === "string" ? node.label : "Group";
      label.disabled = readOnly;
      label.setAttribute("aria-label", `Label for ${node.id}`);
      label.addEventListener("change", () => {
        this.#model?.editGroup(node.id, label.value);
        this.#markDirty();
      });
      body.append(label);
    } else if (node.type === "file") {
      const fileTarget = typeof node.file === "string" ? node.file : "(invalid file target)";
      const opensLocalDocument =
        !isExternalPath(fileTarget) && (isMarkdownPath(fileTarget) || isCanvasPath(fileTarget));
      const target = document.createElement("p");
      target.className = "canvas-file-target";
      target.textContent = fileTarget;
      body.append(target);
      const fileEditor = document.createElement("input");
      fileEditor.type = "text";
      fileEditor.value = fileTarget;
      fileEditor.disabled = readOnly;
      fileEditor.setAttribute("aria-label", `File target for ${node.id}`);
      fileEditor.addEventListener("change", () => {
        this.#model?.editFile(node.id, fileEditor.value);
        this.#markDirty();
      });
      body.append(fileEditor);
      const open = button(
        opensLocalDocument ? "Open file" : "Inspect attachment",
        "canvas-node-action",
      );
      open.addEventListener("click", () => {
        if (opensLocalDocument) {
          void this.#callbacks.openPath(fileTarget);
        } else {
          void this.#loadAttachment(snapshot.path, fileTarget, body);
        }
      });
      body.append(open);
      if (!opensLocalDocument) {
        void this.#loadAttachment(snapshot.path, fileTarget, body);
      }
    } else if (node.type === "link") {
      const editor = document.createElement("input");
      editor.type = "url";
      editor.value = typeof node.url === "string" ? node.url : "";
      editor.disabled = readOnly;
      editor.setAttribute("aria-label", `URL for ${node.id}`);
      editor.addEventListener("change", () => {
        this.#model?.editLink(node.id, editor.value);
        this.#markDirty();
      });
      body.append(editor);
      const link = document.createElement("p");
      link.className = "canvas-link-label";
      link.textContent = `External link (inactive): ${typeof node.url === "string" ? node.url : "(invalid URL)"}`;
      body.append(link);
    } else {
      const unknown = document.createElement("p");
      unknown.textContent = "Unsupported object preserved read-only.";
      body.append(unknown);
    }
    card.append(body);
    const actions = document.createElement("div");
    actions.className = "canvas-node-actions";
    const movement: Array<[string, number, number]> = [
      ["Move left", -20, 0],
      ["Move right", 20, 0],
      ["Move up", 0, -20],
      ["Move down", 0, 20],
    ];
    for (const [label, dx, dy] of movement) {
      const control = button(label, "canvas-node-action");
      control.disabled = readOnly;
      control.addEventListener("click", () => {
        if (!this.#model) return;
        this.#model.moveNode(node.id, node.x + dx, node.y + dy);
        this.#markDirty();
        this.#renderDocument(snapshot, updateZoom);
      });
      actions.append(control);
    }
    const resize = button("Make larger", "canvas-node-action");
    resize.disabled = readOnly;
    resize.addEventListener("click", () => {
      if (!this.#model) return;
      this.#model.resizeNode(node.id, node.width + 20, node.height + 20);
      this.#markDirty();
      this.#renderDocument(snapshot, updateZoom);
    });
    actions.append(resize);
    const remove = button("Remove object", "canvas-node-action canvas-danger-action");
    remove.disabled = readOnly;
    remove.addEventListener("click", () => {
      this.#model?.removeNode(node.id);
      this.#markDirty();
      this.#renderDocument(snapshot, updateZoom);
    });
    actions.append(remove);
    card.append(actions);
    this.#board.append(card);

    const object = document.createElement("li");
    const jump = button(`${node.type}: ${node.id}`, "canvas-object-button");
    jump.addEventListener("click", () => {
      card.focus();
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth";
      card.scrollIntoView({ behavior, block: "center" });
    });
    object.append(jump);
    this.#objectList.append(object);
  }

  async #loadAttachment(source: string, target: string, body: HTMLElement): Promise<void> {
    const response = await this.#callbacks.loadAttachment(source, target);
    const preview = document.createElement("div");
    preview.className = "canvas-attachment-preview";
    if (response.status === "ready" && response.preview === "image" && response.base64) {
      const image = document.createElement("img");
      image.alt = `${titleForPath(response.path)} attachment`;
      image.src = `data:${response.mimeType};base64,${response.base64}`;
      preview.append(image);
    } else if (response.status === "ready" && response.preview === "text") {
      const code = document.createElement("pre");
      code.textContent = `${response.text ?? ""}${response.truncated ? "\n… truncated" : ""}`;
      preview.append(code);
    } else if (response.status === "ready") {
      preview.textContent = `${response.path} (${response.mimeType}, ${response.size} bytes)`;
    } else if (response.status === "unavailable") {
      preview.textContent = `Attachment unavailable: ${response.message}`;
    } else {
      preview.textContent = "Attachment unavailable: the active vault changed.";
    }
    body.append(preview);
  }

  #markDirty(): void {
    this.#dirty = true;
    if (this.#saveButton) {
      this.#saveButton.disabled = false;
    }
    if (this.#status) {
      this.#status.textContent = "Unsaved changes";
    }
  }

  async #save(snapshot: WorkspaceCanvasSnapshot): Promise<void> {
    if (!this.#model || !this.#path || !this.#dirty) return;
    const response = await this.#callbacks.save(
      this.#path,
      serializeJsonCanvas(this.#model.snapshot()),
      this.#revision,
    );
    if (response.outcome.status === "committed") {
      this.#revision = response.outcome.revision;
      this.#dirty = false;
      if (this.#status) this.#status.textContent = "Saved";
      if (this.#saveButton) this.#saveButton.disabled = true;
    } else if (response.outcome.status === "conflict") {
      if (this.#status) {
        this.#status.textContent = `Conflict preserved at ${response.outcome.conflictPath}`;
      }
    } else {
      if (this.#status) this.#status.textContent = "Read-only: changes were not written";
    }
    // Keep the current editor model in place. The runtime snapshot carries
    // the authoritative revision and will be applied on the next navigation.
    void snapshot;
  }
}
