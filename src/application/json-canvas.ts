/**
 * JSON Canvas 1.0 domain model.
 *
 * The format intentionally remains a plain JSON object.  The parser validates
 * the published fields but keeps unknown keys on every object so a newer
 * producer can make a round trip through Threadleaf without data loss.
 */

export const JSON_CANVAS_VERSION = "1.0" as const;
export const MAX_CANVAS_BYTES = 8 * 1024 * 1024;
export const MAX_CANVAS_NODES = 2_048;
export const MAX_CANVAS_EDGES = 4_096;

export type {
  CanvasBackgroundStyle,
  CanvasDiagnostic,
  CanvasEdge,
  CanvasEdgeEnd,
  CanvasFileNode,
  CanvasGeometry,
  CanvasGroupNode,
  CanvasLinkNode,
  CanvasNode,
  CanvasNodeBase,
  CanvasNodeSide,
  CanvasNodeType,
  CanvasTextNode,
  JsonCanvasDocument,
  ParsedJsonCanvas,
} from "../shared/json-canvas";

import type {
  CanvasDiagnostic,
  CanvasEdge,
  CanvasEdgeEnd,
  CanvasGeometry,
  CanvasNode,
  CanvasNodeSide,
  JsonCanvasDocument,
  ParsedJsonCanvas,
} from "../shared/json-canvas";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownString(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === "string" ? record[key] : null;
}

function ownFiniteInteger(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function diagnostic(
  code: CanvasDiagnostic["code"],
  path: string,
  message: string,
): CanvasDiagnostic {
  return { code, path, message };
}

function parseJsonErrorPosition(
  message: string,
  source: string,
): { line: number; column: number } | null {
  const position = /position\s+(\d+)/iu.exec(message)?.[1];
  if (!position) {
    return null;
  }
  const offset = Number(position);
  const before = source.slice(0, offset);
  const line = before.split("\n").length;
  const lastLineBreak = before.lastIndexOf("\n");
  return { line, column: offset - lastLineBreak };
}

function isNodeSide(value: unknown): value is CanvasNodeSide {
  return value === "top" || value === "right" || value === "bottom" || value === "left";
}

function isEdgeEnd(value: unknown): value is CanvasEdgeEnd {
  return value === "none" || value === "arrow";
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateNode(
  value: unknown,
  index: number,
  diagnostics: CanvasDiagnostic[],
): value is CanvasNode {
  const basePath = `$.nodes[${index}]`;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("invalid-node", basePath, "Each canvas node must be an object."));
    return false;
  }
  const id = ownString(value, "id");
  const type = ownString(value, "type");
  const x = ownFiniteInteger(value, "x");
  const y = ownFiniteInteger(value, "y");
  const width = ownFiniteInteger(value, "width");
  const height = ownFiniteInteger(value, "height");
  if (!id) {
    diagnostics.push(diagnostic("invalid-node", `${basePath}.id`, "Node id must be a string."));
  }
  if (!type) {
    diagnostics.push(diagnostic("invalid-node", `${basePath}.type`, "Node type must be a string."));
  }
  for (const [key, field] of [
    ["x", x],
    ["y", y],
    ["width", width],
    ["height", height],
  ] as const) {
    if (field === null) {
      diagnostics.push(
        diagnostic("invalid-node", `${basePath}.${key}`, `${key} must be a safe integer.`),
      );
    }
  }
  if (!id || !type || x === null || y === null || width === null || height === null) {
    return false;
  }
  if (width < 1 || height < 1) {
    diagnostics.push(
      diagnostic("invalid-node", basePath, "Node width and height must be positive integers."),
    );
  }
  if (value.color !== undefined && typeof value.color !== "string") {
    diagnostics.push(
      diagnostic("invalid-node", `${basePath}.color`, "Node color must be a string."),
    );
  }

  if (type === "text" && typeof value.text !== "string") {
    diagnostics.push(diagnostic("invalid-node", `${basePath}.text`, "Text nodes require text."));
  }
  if (type === "file" && typeof value.file !== "string") {
    diagnostics.push(diagnostic("invalid-node", `${basePath}.file`, "File nodes require file."));
  }
  if (type === "file" && value.subpath !== undefined) {
    if (typeof value.subpath !== "string") {
      diagnostics.push(
        diagnostic("invalid-node", `${basePath}.subpath`, "File node subpath must be a string."),
      );
    } else if (!value.subpath.startsWith("#")) {
      diagnostics.push(
        diagnostic("invalid-node", `${basePath}.subpath`, "File node subpath must start with #."),
      );
    }
  }
  if (type === "link" && typeof value.url !== "string") {
    diagnostics.push(diagnostic("invalid-node", `${basePath}.url`, "Link nodes require url."));
  }
  if (type === "group") {
    if (value.label !== undefined && typeof value.label !== "string") {
      diagnostics.push(
        diagnostic("invalid-node", `${basePath}.label`, "Group label must be a string."),
      );
    }
    if (value.background !== undefined && typeof value.background !== "string") {
      diagnostics.push(
        diagnostic("invalid-node", `${basePath}.background`, "Group background must be a string."),
      );
    }
    if (
      value.backgroundStyle !== undefined &&
      value.backgroundStyle !== "cover" &&
      value.backgroundStyle !== "ratio" &&
      value.backgroundStyle !== "repeat"
    ) {
      diagnostics.push(
        diagnostic(
          "invalid-node",
          `${basePath}.backgroundStyle`,
          "Group backgroundStyle must be cover, ratio, or repeat.",
        ),
      );
    }
  }
  if (!(["text", "file", "link", "group"] as string[]).includes(type)) {
    diagnostics.push(
      diagnostic(
        "unsupported-node",
        `${basePath}.type`,
        `Node type ${JSON.stringify(type)} is not supported for editing; the node is preserved read-only.`,
      ),
    );
  }
  return true;
}

function validateEdge(
  value: unknown,
  index: number,
  diagnostics: CanvasDiagnostic[],
): value is CanvasEdge {
  const basePath = `$.edges[${index}]`;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("invalid-edge", basePath, "Each canvas edge must be an object."));
    return false;
  }
  const requiredStrings = ["id", "fromNode", "toNode"] as const;
  let valid = true;
  for (const key of requiredStrings) {
    if (typeof value[key] !== "string" || value[key] === "") {
      diagnostics.push(
        diagnostic("invalid-edge", `${basePath}.${key}`, `${key} must be a string.`),
      );
      valid = false;
    }
  }
  for (const key of ["fromSide", "toSide"] as const) {
    if (value[key] !== undefined && !isNodeSide(value[key])) {
      diagnostics.push(
        diagnostic(
          "invalid-edge",
          `${basePath}.${key}`,
          `${key} must be top, right, bottom, or left.`,
        ),
      );
      valid = false;
    }
  }
  for (const key of ["fromEnd", "toEnd"] as const) {
    if (value[key] !== undefined && !isEdgeEnd(value[key])) {
      diagnostics.push(
        diagnostic("invalid-edge", `${basePath}.${key}`, `${key} must be none or arrow.`),
      );
      valid = false;
    }
  }
  if (value.color !== undefined && typeof value.color !== "string") {
    diagnostics.push(
      diagnostic("invalid-edge", `${basePath}.color`, "Edge color must be a string."),
    );
    valid = false;
  }
  if (value.label !== undefined && typeof value.label !== "string") {
    diagnostics.push(
      diagnostic("invalid-edge", `${basePath}.label`, "Edge label must be a string."),
    );
    valid = false;
  }
  return valid;
}

/** Parse a JSON Canvas document without dropping unknown JSON fields. */
export function parseJsonCanvas(input: Uint8Array | string): ParsedJsonCanvas {
  const originalBytes =
    typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  const originalText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(
    originalBytes,
  );
  if (originalBytes.length > MAX_CANVAS_BYTES) {
    return {
      status: "malformed",
      document: null,
      diagnostics: [
        diagnostic(
          "limit-exceeded",
          "$",
          `Canvas exceeds the ${MAX_CANVAS_BYTES} byte safety limit and is read-only.`,
        ),
      ],
      originalBytes,
      originalText,
    };
  }

  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(originalBytes);
  } catch {
    return {
      status: "malformed",
      document: null,
      diagnostics: [
        diagnostic("invalid-utf8", "$", "Canvas is not valid UTF-8 JSON and is read-only."),
      ],
      originalBytes,
      originalText,
    };
  }

  let parsed: unknown;
  const parseText = originalText.replace(/^\uFEFF/u, "");
  try {
    parsed = JSON.parse(parseText);
  } catch (error) {
    const position = parseJsonErrorPosition(error instanceof Error ? error.message : "", parseText);
    return {
      status: "malformed",
      document: null,
      diagnostics: [
        {
          ...diagnostic("invalid-json", "$", "Canvas contains invalid JSON and is read-only."),
          ...(position ?? {}),
        },
      ],
      originalBytes,
      originalText,
    };
  }

  const diagnostics: CanvasDiagnostic[] = [];
  if (!isRecord(parsed)) {
    diagnostics.push(diagnostic("invalid-root", "$", "Canvas root must be a JSON object."));
    return { status: "malformed", document: null, diagnostics, originalBytes, originalText };
  }
  if (parsed.nodes !== undefined && !Array.isArray(parsed.nodes)) {
    diagnostics.push(diagnostic("invalid-array", "$.nodes", "Canvas nodes must be an array."));
  }
  if (parsed.edges !== undefined && !Array.isArray(parsed.edges)) {
    diagnostics.push(diagnostic("invalid-array", "$.edges", "Canvas edges must be an array."));
  }
  if (Array.isArray(parsed.nodes) && parsed.nodes.length > MAX_CANVAS_NODES) {
    diagnostics.push(
      diagnostic("limit-exceeded", "$.nodes", `Canvas supports at most ${MAX_CANVAS_NODES} nodes.`),
    );
  }
  if (Array.isArray(parsed.edges) && parsed.edges.length > MAX_CANVAS_EDGES) {
    diagnostics.push(
      diagnostic("limit-exceeded", "$.edges", `Canvas supports at most ${MAX_CANVAS_EDGES} edges.`),
    );
  }

  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
  const nodeIds = new Set<string>();
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    validateNode(node, index, diagnostics);
    if (isRecord(node) && typeof node.id === "string") {
      if (nodeIds.has(node.id)) {
        diagnostics.push(
          diagnostic(
            "duplicate-id",
            `$.nodes[${index}].id`,
            `Node id ${JSON.stringify(node.id)} is duplicated.`,
          ),
        );
      }
      nodeIds.add(node.id);
    }
  }
  const edgeIds = new Set<string>();
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index];
    validateEdge(edge, index, diagnostics);
    if (isRecord(edge) && typeof edge.id === "string") {
      if (edgeIds.has(edge.id)) {
        diagnostics.push(
          diagnostic(
            "duplicate-id",
            `$.edges[${index}].id`,
            `Edge id ${JSON.stringify(edge.id)} is duplicated.`,
          ),
        );
      }
      edgeIds.add(edge.id);
    }
    if (isRecord(edge)) {
      for (const key of ["fromNode", "toNode"] as const) {
        if (typeof edge[key] === "string" && !nodeIds.has(edge[key])) {
          diagnostics.push(
            diagnostic(
              "missing-reference",
              `$.edges[${index}].${key}`,
              `Edge references missing node ${JSON.stringify(edge[key])}.`,
            ),
          );
        }
      }
    }
  }

  const document = cloneJson(parsed) as JsonCanvasDocument;
  if (!Array.isArray(document.nodes)) {
    document.nodes = [];
  }
  if (!Array.isArray(document.edges)) {
    document.edges = [];
  }
  const status = diagnostics.length === 0 ? "ready" : "malformed";
  // Keep the parsed tree even when validation found issues. Callers must use
  // `status`/`diagnostics` to enforce read-only behavior, but retaining the
  // tree lets the viewer show every recoverable object without rewriting the
  // original bytes.
  return { status, document, diagnostics, originalBytes, originalText };
}

/** Serialize only after a mutation. Unknown object keys remain present. */
export function serializeJsonCanvas(document: JsonCanvasDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function ensureDocument(
  document: JsonCanvasDocument,
): Required<Pick<JsonCanvasDocument, "nodes" | "edges">> {
  if (!Array.isArray(document.nodes)) {
    document.nodes = [];
  }
  if (!Array.isArray(document.edges)) {
    document.edges = [];
  }
  return document as Required<Pick<JsonCanvasDocument, "nodes" | "edges">>;
}

function nextId(document: JsonCanvasDocument, prefix: string): string {
  const { nodes, edges } = ensureDocument(document);
  const used = new Set([...nodes, ...edges].map((entry) => entry.id));
  let index = 1;
  while (used.has(`${prefix}-${index}`)) {
    index += 1;
  }
  return `${prefix}-${index}`;
}

/** Small mutation surface shared by the desktop renderer and deterministic tests. */
export class MutableJsonCanvas {
  readonly #document: JsonCanvasDocument;

  constructor(document: JsonCanvasDocument) {
    this.#document = cloneJson(document);
    ensureDocument(this.#document);
  }

  snapshot(): JsonCanvasDocument {
    return cloneJson(this.#document);
  }

  addNode(node: CanvasNode): string {
    const { nodes } = ensureDocument(this.#document);
    if (nodes.length >= MAX_CANVAS_NODES) {
      throw new Error(`Canvas supports at most ${MAX_CANVAS_NODES} nodes.`);
    }
    if (nodes.some((candidate) => candidate.id === node.id)) {
      throw new Error(`Canvas node id already exists: ${node.id}`);
    }
    nodes.push(cloneJson(node));
    return node.id;
  }

  addText(text: string, geometry: CanvasGeometry, id = nextId(this.#document, "text")): string {
    return this.addNode({ id, type: "text", ...geometry, text });
  }

  addGroup(label: string, geometry: CanvasGeometry, id = nextId(this.#document, "group")): string {
    return this.addNode({ id, type: "group", ...geometry, label });
  }

  addFile(file: string, geometry: CanvasGeometry, id = nextId(this.#document, "file")): string {
    return this.addNode({ id, type: "file", ...geometry, file });
  }

  addLink(url: string, geometry: CanvasGeometry, id = nextId(this.#document, "link")): string {
    return this.addNode({ id, type: "link", ...geometry, url });
  }

  moveNode(id: string, x: number, y: number): void {
    const node = this.node(id);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
      throw new Error("Canvas node positions must be safe integers.");
    }
    node.x = x;
    node.y = y;
  }

  resizeNode(id: string, width: number, height: number): void {
    const node = this.node(id);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      throw new Error("Canvas node dimensions must be positive safe integers.");
    }
    node.width = width;
    node.height = height;
  }

  editText(id: string, text: string): void {
    const node = this.node(id);
    if (node.type !== "text") {
      throw new Error(`Canvas node is not a text node: ${id}`);
    }
    node.text = text;
  }

  editFile(id: string, file: string, subpath?: string): void {
    const node = this.node(id);
    if (node.type !== "file") {
      throw new Error(`Canvas node is not a file node: ${id}`);
    }
    node.file = file;
    if (subpath === undefined) {
      delete node.subpath;
    } else {
      node.subpath = subpath;
    }
  }

  editLink(id: string, url: string): void {
    const node = this.node(id);
    if (node.type !== "link") {
      throw new Error(`Canvas node is not a link node: ${id}`);
    }
    node.url = url;
  }

  editGroup(id: string, label: string): void {
    const node = this.node(id);
    if (node.type !== "group") {
      throw new Error(`Canvas node is not a group node: ${id}`);
    }
    node.label = label;
  }

  editEdgeLabel(id: string, label: string): void {
    const edge = ensureDocument(this.#document).edges.find((candidate) => candidate.id === id);
    if (!edge) {
      throw new Error(`Canvas edge does not exist: ${id}`);
    }
    if (label) {
      edge.label = label;
    } else {
      delete edge.label;
    }
  }

  addEdge(edge: CanvasEdge): string {
    const { nodes, edges } = ensureDocument(this.#document);
    if (edges.length >= MAX_CANVAS_EDGES) {
      throw new Error(`Canvas supports at most ${MAX_CANVAS_EDGES} edges.`);
    }
    if (edges.some((candidate) => candidate.id === edge.id)) {
      throw new Error(`Canvas edge id already exists: ${edge.id}`);
    }
    if (
      !nodes.some((node) => node.id === edge.fromNode) ||
      !nodes.some((node) => node.id === edge.toNode)
    ) {
      throw new Error("Canvas edges must reference existing nodes.");
    }
    edges.push(cloneJson(edge));
    return edge.id;
  }

  connect(
    fromNode: string,
    toNode: string,
    fromSide: CanvasNodeSide,
    toSide: CanvasNodeSide,
    id = nextId(this.#document, "edge"),
  ): string {
    return this.addEdge({ id, fromNode, toNode, fromSide, toSide });
  }

  removeNode(id: string): void {
    const { nodes, edges } = ensureDocument(this.#document);
    const index = nodes.findIndex((node) => node.id === id);
    if (index === -1) {
      return;
    }
    nodes.splice(index, 1);
    this.#document.edges = edges.filter((edge) => edge.fromNode !== id && edge.toNode !== id);
  }

  removeEdge(id: string): void {
    const { edges } = ensureDocument(this.#document);
    this.#document.edges = edges.filter((edge) => edge.id !== id);
  }

  private node(id: string): CanvasNode {
    const node = ensureDocument(this.#document).nodes.find((candidate) => candidate.id === id);
    if (!node) {
      throw new Error(`Canvas node does not exist: ${id}`);
    }
    return node;
  }
}
