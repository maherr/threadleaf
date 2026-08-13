/** JSON Canvas 1.0 data model shared across the application and bridge. */

export type CanvasNodeType = "text" | "file" | "link" | "group";
export type CanvasNodeSide = "top" | "right" | "bottom" | "left";
export type CanvasEdgeEnd = "none" | "arrow";
export type CanvasBackgroundStyle = "cover" | "ratio" | "repeat";

export interface CanvasNodeBase {
  id: string;
  type: CanvasNodeType | (string & {});
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  [key: string]: unknown;
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: "text";
  text: string;
}

export interface CanvasFileNode extends CanvasNodeBase {
  type: "file";
  file: string;
  subpath?: string;
}

export interface CanvasLinkNode extends CanvasNodeBase {
  type: "link";
  url: string;
}

export interface CanvasGroupNode extends CanvasNodeBase {
  type: "group";
  label?: string;
  background?: string;
  backgroundStyle?: CanvasBackgroundStyle;
}

export type CanvasNode =
  | CanvasTextNode
  | CanvasFileNode
  | CanvasLinkNode
  | CanvasGroupNode
  | CanvasNodeBase;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: CanvasNodeSide;
  fromEnd?: CanvasEdgeEnd;
  toNode: string;
  toSide?: CanvasNodeSide;
  toEnd?: CanvasEdgeEnd;
  color?: string;
  label?: string;
  [key: string]: unknown;
}

export interface JsonCanvasDocument {
  nodes?: CanvasNode[];
  edges?: CanvasEdge[];
  [key: string]: unknown;
}

export interface CanvasDiagnostic {
  code:
    | "invalid-json"
    | "invalid-utf8"
    | "invalid-root"
    | "invalid-array"
    | "invalid-node"
    | "invalid-edge"
    | "duplicate-id"
    | "missing-reference"
    | "unsupported-node"
    | "limit-exceeded";
  path: string;
  message: string;
  line?: number;
  column?: number;
}

export interface ParsedJsonCanvas {
  status: "ready" | "malformed";
  document: JsonCanvasDocument | null;
  diagnostics: CanvasDiagnostic[];
  /** True only when the bytes are exactly the bytes supplied to the parser. */
  originalBytes: Uint8Array;
  originalText: string;
}

export type CanvasGeometry = Pick<CanvasNodeBase, "x" | "y" | "width" | "height">;
